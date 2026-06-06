/**
 * record-tour.ts — graba un video del tour de la app para usar como
 * background en HeyGen (el avatar se overlay-ea después).
 *
 * Uso:
 *   bun run scripts/record-tour.ts --role=teacher
 *   bun run scripts/record-tour.ts --role=admin --headless=false
 *
 * Variables de entorno (.env.recording):
 *   APP_URL          — default http://localhost:5173
 *   DEMO_EMAIL       — email del usuario demo con el rol target
 *   DEMO_PASSWORD    — password del usuario demo
 *   OUTPUT_DIR       — default ./recordings
 *
 * Output:
 *   `recordings/<role>-<timestamp>.webm` (1280×720, ~30fps)
 *
 * Para usar el resultado en HeyGen:
 *   1. Convertí .webm a .mp4 con ffmpeg (HeyGen prefiere mp4):
 *      ffmpeg -i recordings/teacher-XXX.webm -c:v libx264 -preset slow -crf 18 -an out.mp4
 *      (-an = sin audio, HeyGen pone el del avatar)
 *   2. Subí out.mp4 a HeyGen como "background video".
 *   3. Pegá el script de docs/heygen/<rol>.md y elegí avatar.
 *   4. HeyGen rendea avatar overlay encima de la grabación.
 *
 * Prerequisitos:
 *   - Servidor dev corriendo (`bun run dev` en otra terminal).
 *   - Playwright instalado + chromium bajado (`bunx playwright install chromium`).
 *   - Un usuario demo con el rol target. Las credenciales NO van al repo;
 *     pasalas por env vars o .env.recording (gitignored).
 */
import { chromium, type Page, type BrowserContext } from "playwright";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

// ── Config ──────────────────────────────────────────────────────────
// Cargar .env.recording PRIMERO (antes de leer cualquier env var) —
// si no, las constantes APP_URL/OUTPUT_DIR/DEMO_* quedan con los
// defaults y los valores del archivo .env nunca se aplican.
loadDotEnvRecording();
const APP_URL = process.env.APP_URL ?? "http://localhost:5173";
const OUTPUT_DIR = resolve(process.env.OUTPUT_DIR ?? "./recordings");
const DEMO_EMAIL = process.env.DEMO_EMAIL ?? "";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";

// Tamaño del viewport — 1280×720 cabe bien en background HeyGen y
// pesa razonable (~5-15 MB por video). Si necesitás 1080p para HeyGen
// PRO, ajustá a 1920×1080 (videos pesan 3-4× más).
const VIEWPORT = { width: 1280, height: 720 };

// ── Tipos ──────────────────────────────────────────────────────────
type Role = "admin" | "teacher" | "student";

interface Scene {
  /** Ruta dentro de la app (sin host). Ej: "/app/teacher/exams". */
  path: string;
  /** Cuántos milisegundos de "dwell" en esta vista. Suficiente para
   *  que el avatar de HeyGen tenga tiempo de mencionarla. */
  dwellMs: number;
  /** Selector CSS opcional para hover/highlight. Si no se especifica
   *  no hace hover (la cámara solo se "queda mirando" la vista). */
  hover?: string;
  /** Selector CSS opcional para click. Útil para mostrar un dropdown
   *  abierto o un dialog. NO usar para navegar — usá path. */
  click?: string;
  /** Texto que se muestra en consola al entrar a la escena (para
   *  tracking del progreso). Default = path. */
  label?: string;
}

// ── Scenes por rol ────────────────────────────────────────────────
// Cada scene = 5-10s. Total target: 60-90s por rol (matching el
// duración del script de HeyGen en docs/heygen/<rol>.md).
const SCENES_BY_ROLE: Record<Role, Scene[]> = {
  admin: [
    { path: "/app", dwellMs: 6000, label: "Dashboard" },
    { path: "/app/admin/users", dwellMs: 8000, label: "Usuarios" },
    { path: "/app/admin/courses", dwellMs: 8000, label: "Cursos" },
    { path: "/app/admin/academic", dwellMs: 6000, label: "Académico" },
    { path: "/app/admin/ai-prompts", dwellMs: 6000, label: "Prompts IA" },
    { path: "/app/admin/ai-cron", dwellMs: 6000, label: "Cola IA" },
    { path: "/app/admin/statistics", dwellMs: 6000, label: "Estadísticas" },
    { path: "/app/admin/audit-logs", dwellMs: 6000, label: "Auditoría" },
    { path: "/app/trash", dwellMs: 7000, label: "Papelera" },
    { path: "/app/admin/settings", dwellMs: 6000, label: "Configuración" },
  ],
  teacher: [
    { path: "/app", dwellMs: 6000, label: "Dashboard" },
    { path: "/app/teacher/courses", dwellMs: 7000, label: "Mis cursos" },
    { path: "/app/teacher/question-bank", dwellMs: 6000, label: "Banco de preguntas" },
    { path: "/app/teacher/exams", dwellMs: 8000, label: "Exámenes" },
    { path: "/app/teacher/workshops", dwellMs: 7000, label: "Talleres" },
    { path: "/app/teacher/projects", dwellMs: 7000, label: "Proyectos" },
    { path: "/app/teacher/gradebook", dwellMs: 6000, label: "Calificaciones" },
    { path: "/app/teacher/attendance", dwellMs: 8000, label: "Asistencia" },
    { path: "/app/teacher/whiteboards", dwellMs: 7000, label: "Pizarras" },
    { path: "/app/teacher/polls", dwellMs: 6000, label: "Encuestas" },
    { path: "/app/teacher/contents", dwellMs: 6000, label: "Contenidos" },
    { path: "/app/trash", dwellMs: 6000, label: "Papelera" },
  ],
  student: [
    { path: "/app", dwellMs: 6000, label: "Dashboard" },
    { path: "/app/student/courses", dwellMs: 6000, label: "Mis cursos" },
    { path: "/app/student/exams", dwellMs: 7000, label: "Exámenes" },
    { path: "/app/student/workshops", dwellMs: 6000, label: "Talleres" },
    { path: "/app/student/projects", dwellMs: 6000, label: "Proyectos" },
    { path: "/app/student/grades", dwellMs: 7000, label: "Calificaciones" },
    { path: "/app/student/attendance", dwellMs: 7000, label: "Asistencia" },
    { path: "/app/student/polls", dwellMs: 5000, label: "Encuestas" },
    { path: "/app/student/whiteboards", dwellMs: 5000, label: "Pizarras compartidas" },
    { path: "/app/student/tutor", dwellMs: 6000, label: "Tutor IA" },
    { path: "/app/student/certificates", dwellMs: 5000, label: "Certificados" },
  ],
};

// ── Helpers ────────────────────────────────────────────────────────
function loadDotEnvRecording(): void {
  const path = resolve(".env.recording");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/^'(.*)'$/, "$1");
    if (key && !process.env[key]) process.env[key] = val;
  }
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function login(page: Page): Promise<void> {
  if (!DEMO_EMAIL || !DEMO_PASSWORD) {
    throw new Error(
      "DEMO_EMAIL y DEMO_PASSWORD requeridos. Definí ambos en .env.recording o como env vars del shell.",
    );
  }
  console.log(`  → Navegando a ${APP_URL}/auth`);
  await page.goto(`${APP_URL}/auth`, { waitUntil: "domcontentloaded" });
  // Esperamos el form. La app puede mostrar "Iniciar sesión" o
  // "Sign in" según el idioma del usuario default.
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  console.log("  → Login form visible, ingresando credenciales");
  await page.fill('input[type="email"]', DEMO_EMAIL);
  await page.fill('input[type="password"]', DEMO_PASSWORD);
  // Click en el botón de submit del form. Buscamos primero por
  // type="submit"; si no encuentra, fallback a buscar por texto.
  const submitBtn = page.locator('button[type="submit"]').first();
  if ((await submitBtn.count()) > 0) {
    await submitBtn.click();
  } else {
    await page.getByRole("button", { name: /iniciar|sign.in/i }).click();
  }
  console.log("  → Esperando redirect a /app");
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20000 });
  // Esperamos un toque para que el dashboard termine de renderizar
  // (queries iniciales, sidebar, etc.).
  await page.waitForTimeout(2000);
  console.log("  ✓ Login exitoso");
}

async function recordScenes(context: BrowserContext, page: Page, scenes: Scene[]): Promise<void> {
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const url = `${APP_URL}${s.path}`;
    console.log(`  [${i + 1}/${scenes.length}] ${s.label ?? s.path} (${s.dwellMs}ms)`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    // Esperamos un instante para que la query principal del módulo
    // termine. Sin esto el video muestra skeletons/spinners.
    await page.waitForTimeout(800);
    if (s.hover) {
      try {
        await page.locator(s.hover).first().hover({ timeout: 3000 });
      } catch {
        // Hover opcional, no rompemos.
      }
    }
    if (s.click) {
      try {
        await page.locator(s.click).first().click({ timeout: 3000 });
        await page.waitForTimeout(500);
      } catch {
        // Click opcional, no rompemos.
      }
    }
    await page.waitForTimeout(s.dwellMs);
  }
  // Pausa final para que el video no termine cortado en la última
  // escena (HeyGen suele necesitar 1-2s de margen).
  await page.waitForTimeout(1500);
  // Cerrar el contexto fuerza el flush del video al disco.
  await context.close();
}

// ── Main ───────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      role: { type: "string", short: "r" },
      headless: { type: "string", short: "h" },
    },
    allowPositionals: false,
  });

  const role = (values.role ?? "teacher") as Role;
  if (!["admin", "teacher", "student"].includes(role)) {
    console.error(`Role inválido: ${role}. Usá: admin | teacher | student`);
    process.exit(1);
  }
  const headless = (values.headless ?? "true") !== "false";

  const scenes = SCENES_BY_ROLE[role];
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`  Recording ExamLab tour for role: ${role.toUpperCase()}`);
  console.log(`  App URL: ${APP_URL}`);
  console.log(`  Scenes: ${scenes.length}`);
  console.log(`  Headless: ${headless}`);
  console.log(`═══════════════════════════════════════════════════════════`);

  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const browser = await chromium.launch({ headless });
  // recordVideo en el context para que TODA la sesión quede en UN solo
  // archivo. videoSize debe matchear viewport para evitar letterbox.
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: OUTPUT_DIR, size: VIEWPORT },
    // Aceptar locale español para que la UI muestre el idioma esperado
    // (driver.js, fechas, etc.).
    locale: "es-CO",
  });
  const page = await context.newPage();

  try {
    await login(page);
    await recordScenes(context, page, scenes);
    // Playwright nombra el video como un hash random. Lo renombramos
    // al patrón <role>-<ts>.webm para que sea identificable.
    const videoPath = await page.video()?.path();
    if (videoPath) {
      const target = join(OUTPUT_DIR, `${role}-${timestamp()}.webm`);
      const { renameSync } = await import("node:fs");
      try {
        renameSync(videoPath, target);
        console.log(`\n✓ Video guardado: ${target}`);
        console.log(`\nProximos pasos:`);
        console.log(`  1. Convertir a mp4 (HeyGen prefiere mp4):`);
        console.log(
          `       ffmpeg -i "${target}" -c:v libx264 -preset slow -crf 18 -an out-${role}.mp4`,
        );
        console.log(`  2. Subir out-${role}.mp4 a HeyGen como background video.`);
        console.log(`  3. Pegar el script de docs/heygen/${role}.md como narración.`);
      } catch (err) {
        console.warn(`No se pudo renombrar el video — quedó como ${videoPath}`, err);
      }
    } else {
      console.warn("No se obtuvo path del video — revisá el directorio de output");
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("\n✗ Error durante la grabación:");
  console.error(err);
  process.exit(1);
});
