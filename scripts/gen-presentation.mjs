// Genera una presentación PowerPoint GENERAL de ExamLab, resaltando la IA
// (ahorro de tiempo). Usa pptxgenjs (ya está en las deps del repo).
//
//   node scripts/gen-presentation.mjs
//
// Salida: docs/demos/presentacion/ExamLab-Presentacion-General.pptx
import pptxgen from "pptxgenjs";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs", "demos", "presentacion");
mkdirSync(OUT_DIR, { recursive: true });

// Paleta
const INK = "1E1B4B";
const PRIMARY = "4F46E5";
const PRIMARY2 = "7C3AED";
const AI = "059669";
const AIBG = "ECFDF5";
const LIGHT = "F5F3FF";
const WHITE = "FFFFFF";
const MUTED = "64748B";
const BORDER = "E2E8F0";

const pptx = new pptxgen();
pptx.author = "ExamLab";
pptx.company = "ExamLab";
pptx.title = "ExamLab — Plataforma educativa con IA";
pptx.layout = "LAYOUT_WIDE"; // 13.333 x 7.5
const W = 13.333;
const H = 7.5;

let page = 0;
function footer(slide, accent = PRIMARY) {
  page += 1;
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: H - 0.32, w: W, h: 0.32, fill: { color: LIGHT }, line: { type: "none" } });
  slide.addText("ExamLab · Plataforma de Gestión Educativa con IA", {
    x: 0.5, y: H - 0.34, w: 9, h: 0.3, fontSize: 9, color: MUTED, fontFace: "Calibri", valign: "middle",
  });
  slide.addText(`${page}`, { x: W - 1.0, y: H - 0.34, w: 0.5, h: 0.3, fontSize: 9, color: accent, align: "right", valign: "middle", bold: true });
}

// Slide de contenido estándar: banda de título + bullets
function contentSlide({ kicker, title, bullets, accent = PRIMARY, tag = null, note = null }) {
  const s = pptx.addSlide();
  s.background = { color: WHITE };
  // banda superior
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 1.35, fill: { color: accent }, line: { type: "none" } });
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 1.35, w: W, h: 0.06, fill: { color: PRIMARY2 }, line: { type: "none" } });
  if (kicker) s.addText(kicker.toUpperCase(), { x: 0.6, y: 0.22, w: 11, h: 0.3, fontSize: 11, color: "E0E7FF", charSpacing: 2, fontFace: "Calibri" });
  s.addText(title, { x: 0.6, y: 0.5, w: 11.2, h: 0.7, fontSize: 26, bold: true, color: WHITE, fontFace: "Calibri" });
  if (tag) {
    s.addText(tag, { x: W - 1.9, y: 0.42, w: 1.4, h: 0.45, fontSize: 12, bold: true, color: WHITE, align: "center", valign: "middle",
      fill: { color: AI }, rectRadius: 0.1, shape: pptx.ShapeType.roundRect });
  }
  const items = bullets.map((b) => {
    if (typeof b === "string") return { text: b, options: { bullet: { code: "2022" }, color: INK, fontSize: 16, paraSpaceAfter: 10 } };
    return { text: b.t, options: { bullet: { code: "2022" }, color: b.ai ? AI : INK, fontSize: 16, bold: !!b.ai, paraSpaceAfter: 10 } };
  });
  s.addText(items, { x: 0.7, y: 1.75, w: 12, h: note ? 4.2 : 5.2, valign: "top", fontFace: "Calibri", lineSpacingMultiple: 1.05 });
  if (note) {
    s.addShape(pptx.ShapeType.roundRect, { x: 0.7, y: 6.0, w: 11.9, h: 0.85, fill: { color: AIBG }, line: { color: AI, width: 1 }, rectRadius: 0.08 });
    s.addText([{ text: "✨  ", options: { color: AI, fontSize: 14, bold: true } }, { text: note, options: { color: INK, fontSize: 13, italic: true } }],
      { x: 0.95, y: 6.0, w: 11.4, h: 0.85, valign: "middle", fontFace: "Calibri" });
  }
  footer(s, accent);
  return s;
}

// ───────────────────────── 1. Portada ─────────────────────────
{
  const s = pptx.addSlide();
  s.background = { color: INK };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 2.5, fill: { color: PRIMARY }, line: { type: "none" } });
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 2.5, w: W, h: 0.08, fill: { color: AI }, line: { type: "none" } });
  s.addText("ExamLab", { x: 0.8, y: 2.7, w: 11.7, h: 1.2, fontSize: 54, bold: true, color: WHITE, fontFace: "Calibri" });
  s.addText("Plataforma de Gestión Educativa potenciada con IA", { x: 0.82, y: 3.9, w: 11.7, h: 0.6, fontSize: 22, color: "C7D2FE", fontFace: "Calibri" });
  s.addText("Crea, evalúa y enseña en menos tiempo.", { x: 0.82, y: 4.55, w: 11.7, h: 0.5, fontSize: 16, italic: true, color: "A5B4FC", fontFace: "Calibri" });
  s.addText("✨  Generación y calificación con IA · Tutor del curso · Antifraude", {
    x: 0.82, y: 5.7, w: 11, h: 0.5, fontSize: 14, color: WHITE, fontFace: "Calibri", bold: true,
  });
  s.addText("Administrador · Docente · Estudiante", { x: 0.82, y: 1.0, w: 11, h: 0.5, fontSize: 13, color: "E0E7FF", charSpacing: 2 });
}

// ───────────────── 2. Qué es ExamLab ─────────────────
contentSlide({
  kicker: "Visión general",
  title: "Una sola plataforma para toda la operación académica",
  bullets: [
    "Cursos, evaluaciones, asistencia, contenidos y comunicación — integrados.",
    "Multi-institución (multi-tenant) con marca, branding y datos aislados por institución.",
    "Tres roles con su propia experiencia: Administrador, Docente y Estudiante.",
    "Web + instalable (PWA), offline-aware, en tiempo real (notificaciones y push).",
    { t: "La IA atraviesa TODO el flujo: armar, enseñar, evaluar y dar feedback.", ai: true },
  ],
  note: "El objetivo de fondo: devolverle tiempo al docente para que se concentre en enseñar.",
});

// ───────────────── 3. HERO: la IA que ahorra tiempo ─────────────────
{
  const s = pptx.addSlide();
  s.background = { color: AIBG };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 1.5, fill: { color: AI }, line: { type: "none" } });
  s.addText("EL DIFERENCIADOR", { x: 0.6, y: 0.28, w: 11, h: 0.3, fontSize: 11, color: "D1FAE5", charSpacing: 2 });
  s.addText("La IA que te ahorra horas de trabajo", { x: 0.6, y: 0.58, w: 12, h: 0.8, fontSize: 28, bold: true, color: WHITE, fontFace: "Calibri" });
  const cards = [
    { t: "Generar evaluaciones", d: "Exámenes, talleres y proyectos a partir de un tema. La IA redacta preguntas y rúbricas." },
    { t: "Calificar entregas", d: "Corrige automáticamente con retroalimentación — incluido código (ZIP) y diagramas." },
    { t: "Crear contenido", d: "Material didáctico (PPTX / Markdown) y preguntas de banco generadas con IA." },
    { t: "Tutor del curso", d: "Responde dudas del estudiante leyendo el material real del curso, 24/7." },
  ];
  cards.forEach((c, i) => {
    const x = 0.6 + (i % 2) * 6.15;
    const y = 1.9 + Math.floor(i / 2) * 2.35;
    s.addShape(pptx.ShapeType.roundRect, { x, y, w: 5.9, h: 2.1, fill: { color: WHITE }, line: { color: AI, width: 1.25 }, rectRadius: 0.1, shadow: { type: "outer", blur: 4, offset: 2, color: "A7F3D0", opacity: 0.5 } });
    s.addText("✨", { x: x + 0.25, y: y + 0.22, w: 0.8, h: 0.6, fontSize: 22 });
    s.addText(c.t, { x: x + 1.05, y: y + 0.25, w: 4.7, h: 0.5, fontSize: 17, bold: true, color: INK, valign: "middle", fontFace: "Calibri" });
    s.addText(c.d, { x: x + 0.3, y: y + 0.9, w: 5.35, h: 1.05, fontSize: 12.5, color: "334155", valign: "top", fontFace: "Calibri" });
  });
  s.addText("De horas a minutos: la IA arma y corrige; el docente revisa y ajusta.", { x: 0.6, y: 6.7, w: 12, h: 0.4, fontSize: 14, italic: true, bold: true, color: AI, align: "center" });
  footer(s, AI);
}

// ───────────────── 4. Generación con IA ─────────────────
contentSlide({
  kicker: "IA · Creación",
  title: "Generación de evaluaciones y contenido",
  tag: "IA",
  accent: AI,
  bullets: [
    { t: "Preguntas de examen, taller y proyecto a partir del tema o el material del curso.", ai: true },
    { t: "Archivos de proyecto, preguntas de banco y juegos Kahoot, generados automáticamente.", ai: true },
    "Contenido didáctico: presentaciones (.pptx) y guías (.md) listas para la clase.",
    "Modo sincrónico (al instante en el formulario) o asincrónico (cola de generación).",
    "Prompts personalizables por institución y por curso, con plantilla base segura.",
  ],
  note: "El docente describe; la IA produce un borrador editable — nunca parte de cero.",
});

// ───────────────── 5. Calificación + antifraude ─────────────────
contentSlide({
  kicker: "IA · Evaluación",
  title: "Calificación automática y detección de fraude",
  tag: "IA",
  accent: AI,
  bullets: [
    { t: "Califica entregas con retroalimentación por criterio — texto, código (ZIP) y diagramas.", ai: true },
    { t: "Detección de copia entre estudiantes (similitud) y análisis de entregas sospechosas.", ai: true },
    "Proctoring en exámenes: pantalla completa, advertencias, bloqueo de navegación.",
    "Reintentos automáticos ante errores transitorios; cola con reproceso manual.",
    "El docente mantiene el control: revisa, ajusta la nota y publica.",
  ],
  note: "Menos tiempo corrigiendo, más equidad y trazabilidad en cada nota.",
});

// ───────────────── 6. Evaluación y clases ─────────────────
contentSlide({
  kicker: "Operación del aula",
  title: "Evaluaciones, clases y asistencia",
  bullets: [
    "Exámenes con temporizador, mezcla de preguntas y navegación configurable.",
    "Talleres y proyectos con sustentación, enlace al repositorio y trabajo en grupo.",
    "Tablero/cronograma del curso: sesiones, contenidos y entregas en una línea de tiempo.",
    "Asistencia con QR rotativo (auto check-in del estudiante) y registro en vivo.",
    "Ejecución de código en el navegador: Java y Python, incluso interfaces gráficas.",
  ],
  note: "Sincroniza con Google/Microsoft Calendar y trae las grabaciones de cada clase solo.",
});

// ───────────────── 7. Comunicación y participación ─────────────────
contentSlide({
  kicker: "Comunidad",
  title: "Comunicación y participación",
  accent: PRIMARY2,
  bullets: [
    "Mensajería 1-a-1, difusión a cursos y mensajes programados.",
    "Foros por curso y etiquetado de contenido con #.",
    "Encuestas tipo Doodle (cupos) y Kahoot en vivo con ranking en tiempo real.",
    "Notificaciones en la app y push, aunque la pestaña esté cerrada.",
    "Pizarra de sesión compartida en vivo y notebooks ejecutables.",
  ],
});

// ───────────────── 8. Gestión institucional ─────────────────
contentSlide({
  kicker: "Administración",
  title: "Gestión institucional de punta a punta",
  bullets: [
    "Estructura académica: carreras, asignaturas y periodos.",
    "Cortes y pesos de notas configurables; libro de calificaciones con exportación.",
    "Certificados automáticos, reportes con datos embebidos y auditoría completa.",
    "Papelera (borrado reversible) y módulo de Soporte (PQRS) hacia la plataforma.",
    "Importación masiva de usuarios y gestión de roles y contraseñas.",
  ],
  note: "El Administrador supervisa evaluaciones, asistencia y calificaciones de su institución.",
});

// ───────────────── 9. Cierre ─────────────────
{
  const s = pptx.addSlide();
  s.background = { color: INK };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 2.2, w: W, h: 0.08, fill: { color: AI }, line: { type: "none" } });
  s.addText("La IA de ExamLab te devuelve tiempo", { x: 0.8, y: 2.5, w: 11.7, h: 1.0, fontSize: 36, bold: true, color: WHITE, fontFace: "Calibri" });
  s.addText("Menos armado de pruebas. Menos corrección manual. Más enseñanza.", {
    x: 0.82, y: 3.7, w: 11.7, h: 0.6, fontSize: 18, color: "C7D2FE", fontFace: "Calibri",
  });
  s.addText("✨  Generar · Calificar · Tutorizar · Detectar copia — automáticamente", {
    x: 0.82, y: 4.6, w: 11.7, h: 0.5, fontSize: 15, color: AI, bold: true, fontFace: "Calibri",
  });
  s.addText("ExamLab", { x: 0.82, y: 6.1, w: 6, h: 0.5, fontSize: 16, bold: true, color: WHITE });
}

const file = join(OUT_DIR, "ExamLab-Presentacion-General.pptx");
await pptx.writeFile({ fileName: file });
console.log("OK →", file);
