/**
 * mobile-audit.ts — captura screenshots de la app en viewport de MÓVIL
 * (iPhone 13, 390×844) y detecta scroll horizontal a nivel página (el bug
 * de responsive #1). Herramienta de validación UI/UX, NO de grabación.
 *
 * Uso:
 *   MOB_EMAIL=... MOB_PASSWORD=... MOB_TENANT="ExamLab Demo" MOB_OUT=/ruta \
 *     node --experimental-strip-types scripts/mobile-audit.ts <scenario>
 *   scenario ∈ { public | superadmin | docente | docente-student }
 *
 * Reporta por ruta: URL final (detecta redirects a /unauthorized), scrollWidth
 * vs innerWidth (overflow horizontal = BUG), y guarda PNG fullPage.
 */
import { chromium, devices, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const APP = process.env.MOB_APP ?? "http://localhost:5173";
const OUT = resolve(process.env.MOB_OUT ?? "./mobile-shots");
const EMAIL = process.env.MOB_EMAIL ?? "";
const PASSWORD = process.env.MOB_PASSWORD ?? "";
const TENANT_MATCH = process.env.MOB_TENANT ?? ""; // substring, case-insensitive
const SWITCH_ROLE = process.env.MOB_ROLE ?? ""; // "Estudiante" etc, opcional

type Route = { p: string; n: string };

const SCENARIOS: Record<string, { login: boolean; routes: Route[] }> = {
  public: {
    login: false,
    routes: [
      { p: "/", n: "01-landing" },
      { p: "/auth", n: "02-login" },
    ],
  },
  superadmin: {
    login: true,
    routes: [
      { p: "/app", n: "01-dashboard" },
      { p: "/app/admin/users", n: "02-usuarios" },
      { p: "/app/admin/courses", n: "03-cursos" },
      { p: "/app/admin/certificates", n: "04-certificados" },
      { p: "/app/admin/audit-logs", n: "05-auditoria" },
      { p: "/app/admin/statistics", n: "06-estadisticas" },
      { p: "/app/superadmin/tenants", n: "07-tenants" },
      { p: "/app/admin/ai-cron", n: "08-cron-ia" },
      { p: "/app/admin/support", n: "09-soporte" },
      { p: "/app/trash", n: "10-papelera" },
      { p: "/app/admin/settings", n: "11-configuracion" },
      { p: "/app/messages", n: "12-mensajes" },
    ],
  },
  docente: {
    login: true,
    routes: [
      { p: "/app", n: "01-dashboard" },
      { p: "/app/teacher/courses", n: "02-cursos" },
      { p: "/app/teacher/exams", n: "03-examenes" },
      { p: "/app/teacher/workshops", n: "04-talleres" },
      { p: "/app/teacher/projects", n: "05-proyectos" },
      { p: "/app/teacher/gradebook", n: "06-gradebook" },
      { p: "/app/teacher/attendance", n: "07-asistencia" },
      { p: "/app/teacher/polls", n: "08-encuestas" },
      { p: "/app/teacher/contents", n: "09-contenidos" },
      { p: "/app/teacher/question-bank", n: "10-banco-preguntas" },
      { p: "/app/teacher/calendar", n: "11-calendario" },
      { p: "/app/messages", n: "12-mensajes" },
    ],
  },
  "docente-student": {
    login: true,
    routes: [
      { p: "/app", n: "01-dashboard-est" },
      { p: "/app/student/courses", n: "02-cursos" },
      { p: "/app/student/exams", n: "03-examenes" },
      { p: "/app/student/workshops", n: "04-talleres" },
      { p: "/app/student/grades", n: "05-notas" },
      { p: "/app/student/calendar", n: "06-calendario" },
      { p: "/app/student/tutor", n: "07-tutor" },
    ],
  },
};

async function listTenantAndPick(page: Page): Promise<void> {
  await page.locator("#li-tenant").click();
  await page.waitForSelector('[role="option"]', { timeout: 8000 });
  const opts = page.locator('[role="option"]');
  const count = await opts.count();
  let picked = -1;
  for (let i = 0; i < count; i++) {
    const label = ((await opts.nth(i).textContent()) ?? "").trim();
    if (TENANT_MATCH && label.toLowerCase().includes(TENANT_MATCH.toLowerCase())) {
      picked = i;
      break;
    }
  }
  if (picked === -1) {
    // fallback: primer tenant "real" (no cross-tenant) o el primero
    for (let i = 0; i < count; i++) {
      const label = ((await opts.nth(i).textContent()) ?? "").trim();
      if (label && !label.startsWith("—")) { picked = i; break; }
    }
  }
  if (picked === -1) picked = 0;
  await opts.nth(picked).click();
}

async function login(page: Page): Promise<void> {
  await page.goto(`${APP}/auth`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await listTenantAndPick(page);
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  const submit = page.locator('button[type="submit"]').first();
  await page.waitForFunction(
    () => { const b = document.querySelector<HTMLButtonElement>('button[type="submit"]'); return !!b && !b.disabled; },
    { timeout: 10000 },
  );
  await submit.click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20000 });
  await page.waitForTimeout(2500);
}

async function switchRole(page: Page, role: string): Promise<void> {
  // Mobile: abrir el drawer (hamburguesa) → role-switcher dentro del Sheet.
  try {
    const burger = page.locator('button:has(svg.lucide-menu), header button').first();
    await burger.click({ timeout: 4000 });
    await page.waitForTimeout(600);
    const trigger = page.locator('[data-tour-id="role-switcher"] [role="combobox"]').first();
    await trigger.click({ timeout: 4000 });
    await page.waitForTimeout(400);
    await page.getByRole("option", { name: role, exact: false }).first().click({ timeout: 4000 });
    await page.waitForTimeout(1500);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
  } catch (e) {
    console.log(`  ! no pude cambiar a rol ${role}: ${(e as Error).message}`);
  }
}

// Diálogos/modales a capturar (surface crítica en móvil): abrir ruta, click en
// el botón que abre el modal, screenshot. Corre con scenario "dialogs".
const DIALOGS: Array<{ route: string; button: string; n: string }> = [
  { route: "/app/teacher/exams", button: "Nuevo examen", n: "d1-nuevo-examen" },
  { route: "/app/teacher/workshops", button: "Nuevo taller", n: "d2-nuevo-taller" },
  { route: "/app/teacher/courses", button: "Nuevo curso", n: "d3-nuevo-curso" },
  { route: "/app/teacher/polls", button: "Nueva encuesta", n: "d4-nueva-encuesta" },
];

async function runDialogs(page: Page): Promise<void> {
  for (const d of DIALOGS) {
    try {
      await page.goto(`${APP}${d.route}`, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1000);
      const btn = page.getByRole("button", { name: new RegExp(d.button, "i") }).first();
      await btn.click({ timeout: 5000 });
      await page.waitForTimeout(1200);
      const file = join(OUT, `${d.n}.png`);
      await page.screenshot({ path: file, fullPage: true });
      // metrics del dialog: ¿overflow horizontal del viewport con el modal abierto?
      const m = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        iw: window.innerWidth,
        dialogW: (document.querySelector('[role="dialog"]') as HTMLElement | null)?.getBoundingClientRect().width ?? 0,
      }));
      console.log(`  ${m.sw > m.iw + 1 ? "⚠ OVERFLOW" : "ok"} ${d.n} (page sw=${m.sw}/${m.iw}, dialogW=${Math.round(m.dialogW)})`);
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(400);
    } catch (e) {
      console.log(`  ! ${d.n}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
}

async function main(): Promise<void> {
  const scenario = process.argv[2] ?? "public";
  const isDialogs = scenario === "dialogs";
  const cfg = SCENARIOS[scenario];
  if (!cfg && !isDialogs) { console.error(`scenario inválido: ${scenario}`); process.exit(1); }
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ...devices["iPhone 13"], locale: "es-CO" });
  const page = await context.newPage();
  const report: Array<Record<string, unknown>> = [];

  if (isDialogs) {
    try {
      if (!EMAIL || !PASSWORD) throw new Error("MOB_EMAIL / MOB_PASSWORD requeridos");
      await login(page);
      await runDialogs(page);
    } finally {
      await browser.close();
    }
    return;
  }

  try {
    if (cfg.login) {
      if (!EMAIL || !PASSWORD) throw new Error("MOB_EMAIL / MOB_PASSWORD requeridos");
      await login(page);
    }
    if (SWITCH_ROLE) await switchRole(page, SWITCH_ROLE);

    for (const r of cfg.routes) {
      try {
        await page.goto(`${APP}${r.p}`, { waitUntil: "domcontentloaded", timeout: 20000 });
      } catch { /* seguimos, capturamos lo que haya */ }
      await page.waitForLoadState("networkidle", { timeout: 9000 }).catch(() => {});
      await page.waitForTimeout(1200);
      // Si sigue mostrando "Cargando…", dar más tiempo (grids grandes).
      try {
        const loading = await page.getByText(/^Cargando/).first().isVisible({ timeout: 400 });
        if (loading) await page.waitForTimeout(3000);
      } catch { /* no loading text */ }
      const readMetrics = () =>
        page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          finalPath: location.pathname,
        }));
      let metrics: { scrollWidth: number; innerWidth: number; finalPath: string };
      try {
        metrics = await readMetrics();
      } catch {
        // navegación en vuelo (redirect) → esperar y reintentar
        await page.waitForTimeout(1800);
        try {
          metrics = await readMetrics();
        } catch {
          metrics = { scrollWidth: 0, innerWidth: 390, finalPath: new URL(page.url()).pathname };
        }
      }
      const overflow = metrics.scrollWidth > metrics.innerWidth + 1;
      const file = join(OUT, `${r.n}.png`);
      await page.screenshot({ path: file, fullPage: true }).catch(() => {});
      const row = {
        route: r.p,
        finalPath: metrics.finalPath,
        redirected: metrics.finalPath !== r.p,
        scrollWidth: metrics.scrollWidth,
        innerWidth: metrics.innerWidth,
        H_OVERFLOW: overflow,
        file: `${r.n}.png`,
      };
      report.push(row);
      console.log(
        `  ${overflow ? "⚠ OVERFLOW" : "ok       "} ${r.p} → ${metrics.finalPath} (sw=${metrics.scrollWidth}/${metrics.innerWidth})`,
      );
    }
  } finally {
    writeFileSync(join(OUT, `_report-${scenario}.json`), JSON.stringify(report, null, 2));
    await browser.close();
  }
  const bad = report.filter((r) => r.H_OVERFLOW);
  console.log(`\n=== ${scenario}: ${report.length} rutas, ${bad.length} con overflow horizontal ===`);
}

main().catch((e) => { console.error(e); process.exit(1); });
