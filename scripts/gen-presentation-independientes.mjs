// Genera una presentación PowerPoint COMERCIAL de ExamLab para DOCENTES
// INDEPENDIENTES: profesores particulares, tutores y creadores de cursos que
// enseñan por su cuenta (sin una institución detrás). Un único plan accesible
// de $10 USD/mes, con la MISMA potencia de IA que los planes institucionales.
//
//   node scripts/gen-presentation-independientes.mjs
//
// Salida: docs/demos/presentacion/ExamLab-Presentacion-Independientes.pptx
//
// Modelada sobre gen-presentation-comercial.mjs para mantener la misma
// identidad visual (paleta, header, footer, grid de funciones). La diferencia
// es la audiencia (1 docente, no una institución) y la slide de precio.
//
// NOTA: los precios son VALORES DE REFERENCIA (placeholders) — ajustar a la
// política comercial real antes de publicar.
import pptxgen from "pptxgenjs";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs", "demos", "presentacion");
mkdirSync(OUT_DIR, { recursive: true });

const INK = "1E1B4B";
const PRIMARY = "4F46E5";
const PRIMARY2 = "7C3AED";
const AI = "059669";
const AIBG = "ECFDF5";
const LIGHT = "F5F3FF";
const WHITE = "FFFFFF";
const MUTED = "64748B";
const GOLD = "FACC15";

const pptx = new pptxgen();
pptx.author = "ExamLab";
pptx.company = "ExamLab";
pptx.title = "ExamLab — Plan Docente Independiente";
pptx.layout = "LAYOUT_WIDE";
const W = 13.333, H = 7.5;

let page = 0;
function footer(slide, accent = PRIMARY) {
  page += 1;
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: H - 0.32, w: W, h: 0.32, fill: { color: LIGHT }, line: { type: "none" } });
  slide.addText("ExamLab · Plan Docente Independiente", { x: 0.5, y: H - 0.34, w: 9, h: 0.3, fontSize: 9, color: MUTED, valign: "middle" });
  slide.addText(`${page}`, { x: W - 1.0, y: H - 0.34, w: 0.5, h: 0.3, fontSize: 9, color: accent, align: "right", valign: "middle", bold: true });
}
function contentSlide({ kicker, title, bullets, accent = PRIMARY, note = null }) {
  const s = pptx.addSlide();
  s.background = { color: WHITE };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 1.35, fill: { color: accent }, line: { type: "none" } });
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 1.35, w: W, h: 0.06, fill: { color: PRIMARY2 }, line: { type: "none" } });
  if (kicker) s.addText(kicker.toUpperCase(), { x: 0.6, y: 0.22, w: 11, h: 0.3, fontSize: 11, color: "E0E7FF", charSpacing: 2 });
  s.addText(title, { x: 0.6, y: 0.5, w: 12, h: 0.7, fontSize: 26, bold: true, color: WHITE });
  const items = bullets.map((b) => (typeof b === "string"
    ? { text: b, options: { bullet: { code: "2022" }, color: INK, fontSize: 16, paraSpaceAfter: 10 } }
    : { text: b.t, options: { bullet: { code: "2022" }, color: b.ai ? AI : INK, fontSize: 16, bold: !!b.ai, paraSpaceAfter: 10 } }));
  s.addText(items, { x: 0.7, y: 1.75, w: 12, h: note ? 4.2 : 5.2, valign: "top", lineSpacingMultiple: 1.05 });
  if (note) {
    s.addShape(pptx.ShapeType.roundRect, { x: 0.7, y: 6.0, w: 11.9, h: 0.85, fill: { color: AIBG }, line: { color: AI, width: 1 }, rectRadius: 0.08 });
    s.addText([{ text: "✨  ", options: { color: AI, fontSize: 14, bold: true } }, { text: note, options: { color: INK, fontSize: 13, italic: true } }], { x: 0.95, y: 6.0, w: 11.4, h: 0.85, valign: "middle" });
  }
  footer(s, accent);
  return s;
}

// ───────── 1. Portada ─────────
{
  const s = pptx.addSlide();
  s.background = { color: INK };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 2.5, fill: { color: PRIMARY }, line: { type: "none" } });
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 2.5, w: W, h: 0.08, fill: { color: AI }, line: { type: "none" } });
  s.addText("PARA DOCENTES INDEPENDIENTES", { x: 0.82, y: 1.0, w: 11, h: 0.5, fontSize: 13, color: "E0E7FF", charSpacing: 3 });
  s.addText("ExamLab", { x: 0.8, y: 2.7, w: 11.7, h: 1.2, fontSize: 54, bold: true, color: WHITE });
  s.addText("Tu propia aula con IA — por $10 al mes", { x: 0.82, y: 3.95, w: 11.7, h: 0.6, fontSize: 22, color: "C7D2FE" });
  s.addText("Clases particulares, tutorías o tu curso online: enseña como una institución, sin serlo.", { x: 0.82, y: 4.6, w: 11.7, h: 0.5, fontSize: 16, italic: true, color: "A5B4FC" });
}

// ───────── 2. Por qué ExamLab (hook) ─────────
contentSlide({
  kicker: "Por qué ExamLab",
  title: "Tú enseñas. La IA hace lo repetitivo.",
  bullets: [
    "Armar exámenes y talleres desde cero, cada semana, quita tiempo de enseñar.",
    "Calificar a mano es lento y el feedback a tus estudiantes llega tarde.",
    "WhatsApp, Drive, Forms y Excel: tus clases viven dispersas en cinco herramientas.",
    { t: "ExamLab genera, califica y tutoriza con IA —y detecta copia— en una sola plataforma.", ai: true },
    { t: "Recuperas horas para dar más clases, o simplemente para descansar.", ai: true },
  ],
  note: "En español, sin instalar nada y lista en minutos. Tu marca, tu aula, tus estudiantes.",
});

// ───────── 3. Lo que incluye ─────────
contentSlide({
  kicker: "La plataforma",
  title: "Todo lo que necesitas para tus clases",
  accent: PRIMARY2,
  bullets: [
    "Crea cursos, sube tu material y organiza el cronograma de clases.",
    { t: "Genera exámenes, talleres y proyectos con IA, y califícalos automáticamente con feedback.", ai: true },
    { t: "Tutor IA que responde a tus estudiantes con base en TU material; detección de copia.", ai: true },
    "Asistencia con QR, calendario, mensajería, foros, encuestas y Kahoot en vivo.",
    "Certificados con tu marca, reportes y libro de calificaciones.",
  ],
});

// ───────── 4. EL PLAN (la slide clave) ─────────
{
  const s = pptx.addSlide();
  s.background = { color: WHITE };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 1.15, fill: { color: PRIMARY }, line: { type: "none" } });
  s.addText("UN SOLO PLAN, SIN COMPLICACIONES", { x: 0.6, y: 0.14, w: 11, h: 0.28, fontSize: 11, color: "E0E7FF", charSpacing: 2 });
  s.addText("Plan Docente Independiente", { x: 0.6, y: 0.4, w: 12, h: 0.5, fontSize: 23, bold: true, color: WHITE });
  s.addText("Todas las funciones de IA incluidas — pensado para un solo docente: tú.", { x: 0.6, y: 0.88, w: 12, h: 0.28, fontSize: 12.5, color: "E0E7FF" });

  // Dos opciones de pago del MISMO plan (mismas funciones y capacidades).
  // El anual resalta como "mejor valor" (equivale a 2 meses gratis).
  const CAP = [
    { k: "Docente", v: "1 (tú)" },
    { k: "Estudiantes", v: "Hasta 100" },
    { k: "Cursos", v: "Ilimitados" },
  ];
  const FEATS = ["Todas las funciones incluidas", "IA: generar, calificar y tutorizar", "Tu marca (branding propio)", "Soporte por correo"];
  const opts = [
    { name: "Mensual", target: "Paga mes a mes", price: "$10", unit: "  /mes", accent: PRIMARY2, hl: false, ribbon: null, sub: "Sin contratos. Cancela cuando quieras." },
    { name: "Anual", target: "Paga una vez al año", price: "$100", unit: "  /año", accent: AI, hl: true, ribbon: "MEJOR VALOR", sub: "Equivale a $8,33/mes — ahorras 2 meses." },
  ];
  const cardW = 4.25, gap = 0.6;
  const totalW = opts.length * cardW + (opts.length - 1) * gap;
  const x0 = (W - totalW) / 2;
  const y = 1.95, h = 3.95;
  opts.forEach((t, i) => {
    const x = x0 + i * (cardW + gap);
    if (t.hl) {
      s.addShape(pptx.ShapeType.roundRect, { x: x - 0.08, y: y - 0.18, w: cardW + 0.16, h: h + 0.36, fill: { color: AIBG }, line: { color: t.accent, width: 2.5 }, rectRadius: 0.12, shadow: { type: "outer", blur: 6, offset: 3, color: "A7F3D0" } });
      s.addText(t.ribbon, { x: x + cardW / 2 - 1.0, y: y - 0.32, w: 2.0, h: 0.34, fontSize: 10, bold: true, color: WHITE, align: "center", valign: "middle", fill: { color: t.accent }, rectRadius: 0.08, shape: pptx.ShapeType.roundRect });
    } else {
      s.addShape(pptx.ShapeType.roundRect, { x, y, w: cardW, h, fill: { color: WHITE }, line: { color: "CBD5E1", width: 1.25 }, rectRadius: 0.12 });
    }
    s.addShape(pptx.ShapeType.rect, { x, y, w: cardW, h: 0.12, fill: { color: t.accent }, line: { type: "none" } });
    s.addText(t.name, { x: x + 0.25, y: y + 0.26, w: cardW - 0.5, h: 0.5, fontSize: 22, bold: true, color: INK });
    s.addText(t.target, { x: x + 0.25, y: y + 0.80, w: cardW - 0.5, h: 0.35, fontSize: 12.5, color: MUTED });
    s.addText([{ text: t.price, options: { fontSize: 34, bold: true, color: t.accent } }, { text: t.unit, options: { fontSize: 13, color: MUTED } }], { x: x + 0.25, y: y + 1.18, w: cardW - 0.5, h: 0.55 });
    s.addText(t.sub, { x: x + 0.25, y: y + 1.78, w: cardW - 0.5, h: 0.32, fontSize: 10.5, italic: true, color: t.accent });
    s.addShape(pptx.ShapeType.line, { x: x + 0.28, y: y + 2.18, w: cardW - 0.56, h: 0, line: { color: "E2E8F0", width: 1 } });
    // capacidades
    CAP.forEach((c, j) => {
      const cy = y + 2.32 + j * 0.38;
      s.addText(c.k, { x: x + 0.28, y: cy, w: 2.1, h: 0.38, fontSize: 12, color: "334155", valign: "middle" });
      s.addText(c.v, { x: x + cardW - 1.85, y: cy, w: 1.6, h: 0.38, fontSize: 12.5, bold: true, color: INK, align: "right", valign: "middle" });
    });
  });

  // Columna derecha: qué incluye (común a ambas opciones)
  {
    const fx = x0 + totalW + 0.55;
    const fw = W - fx - 0.55;
    if (fw > 2.6) {
      s.addText("INCLUIDO EN AMBAS", { x: fx, y: y + 0.05, w: fw, h: 0.3, fontSize: 10.5, bold: true, color: MUTED, charSpacing: 1 });
      const fitems = FEATS.map((f) => ({ text: f, options: { bullet: { code: "2713" }, color: "334155", fontSize: 13, paraSpaceAfter: 12 } }));
      s.addText(fitems, { x: fx, y: y + 0.45, w: fw, h: 3.0, valign: "top" });
    }
  }

  // Banner "¿Creces?" → upsell a planes institucionales
  {
    const by = 6.18, bh = 0.50;
    s.addShape(pptx.ShapeType.roundRect, { x: 0.55, y: by, w: 12.23, h: bh, fill: { color: INK }, line: { type: "none" }, rectRadius: 0.1 });
    s.addText([
      { text: "¿Tu operación crece o sumas más docentes?  ", options: { fontSize: 14, bold: true, color: WHITE } },
      { text: "Pasa a un plan institucional cuando quieras.", options: { fontSize: 12.5, color: "E0E7FF" } },
    ], { x: 0.95, y: by, w: 8.6, h: bh, valign: "middle" });
    s.addText("Ver planes →", { x: 9.7, y: by + 0.09, w: 2.9, h: bh - 0.18, fontSize: 13, bold: true, color: INK, align: "center", valign: "middle", fill: { color: GOLD }, rectRadius: 0.08, shape: pptx.ShapeType.roundRect });
  }
  s.addText("Precios de referencia (USD) — incluyen plataforma, infraestructura y soporte. El API key de IA lo pones tú: con la cuenta gratuita de Gemini suele alcanzar para un docente independiente (su uso de IA no se factura en la suscripción). Ajustar a la política comercial.", { x: 0.55, y: 6.78, w: 12.2, h: 0.34, fontSize: 9, italic: true, color: MUTED, align: "center" });
  footer(s, PRIMARY);
}

// ───────── 5. Todo incluido (grid) ─────────
{
  const s = pptx.addSlide();
  s.background = { color: WHITE };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 1.35, fill: { color: PRIMARY2 }, line: { type: "none" } });
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 1.35, w: W, h: 0.06, fill: { color: AI }, line: { type: "none" } });
  s.addText("TODO INCLUIDO", { x: 0.6, y: 0.2, w: 11, h: 0.3, fontSize: 11, color: "E9D5FF", charSpacing: 2 });
  s.addText("La misma potencia que las instituciones, por $10/mes", { x: 0.6, y: 0.46, w: 12, h: 0.55, fontSize: 24, bold: true, color: WHITE });
  s.addText("Sin funciones bloqueadas ni versión recortada: tienes la plataforma completa.", { x: 0.6, y: 1.0, w: 12, h: 0.3, fontSize: 12.5, color: "E9D5FF" });

  const feats = [
    "Cursos, cronograma y tablero",
    "Exámenes, talleres y proyectos",
    "Generación de evaluaciones con IA",
    "Generación de contenido (PPTX/guías) con IA",
    "Calificación automática con retroalimentación",
    "Tutor IA del curso",
    "Detección de copia / antifraude",
    "Banco de preguntas reutilizable",
    "Asistencia con QR (auto check-in)",
    "Sincronización con Google/Microsoft Calendar",
    "Mensajería, foros y difusión",
    "Encuestas y Kahoot en vivo",
    "Certificados con tu marca y reportes",
    "Ejecución de código (Java/Python) en línea",
    "Branding propio y libro de calificaciones",
    "Notificaciones en la app y push",
  ];
  const colW = 6.0, x0 = 0.7, gap = 0.3, rh = 0.52, y0 = 1.75, perCol = Math.ceil(feats.length / 2);
  feats.forEach((f, i) => {
    const col = Math.floor(i / perCol);
    const row = i % perCol;
    const x = x0 + col * (colW + gap);
    const y = y0 + row * rh;
    s.addText("✓", { x, y, w: 0.4, h: rh, fontSize: 14, bold: true, color: AI, valign: "middle" });
    s.addText(f, { x: x + 0.42, y, w: colW - 0.42, h: rh, fontSize: 13, color: INK, valign: "middle" });
  });
  s.addShape(pptx.ShapeType.roundRect, { x: 0.7, y: 6.55, w: 11.9, h: 0.62, fill: { color: AIBG }, line: { color: AI, width: 1 }, rectRadius: 0.08 });
  s.addText([{ text: "✨  ", options: { color: AI, fontSize: 13, bold: true } }, { text: "El API key de IA lo pones tú: usas tu propia cuenta (el plan gratuito de Gemini suele bastar), sin sobrecosto de uso en tu suscripción.", options: { color: INK, fontSize: 12.5, italic: true } }], { x: 0.95, y: 6.55, w: 11.4, h: 0.62, valign: "middle" });
  footer(s, PRIMARY2);
}

// ───────── 6. Cierre / CTA ─────────
{
  const s = pptx.addSlide();
  s.background = { color: INK };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 2.2, w: W, h: 0.08, fill: { color: AI }, line: { type: "none" } });
  s.addText("Enseña con IA. Por el precio de un café a la semana.", { x: 0.8, y: 2.5, w: 11.7, h: 1.0, fontSize: 32, bold: true, color: WHITE });
  s.addText("$10 al mes. Sin contratos, sin permanencia — cancela cuando quieras.", { x: 0.82, y: 3.7, w: 11.7, h: 0.6, fontSize: 17, color: "C7D2FE" });
  s.addText("✨  IA para generar, calificar, tutorizar y detectar copia — incluida.", { x: 0.82, y: 4.5, w: 11.7, h: 0.5, fontSize: 15, color: AI, bold: true });
  s.addText("Empieza hoy · ExamLab", { x: 0.82, y: 6.0, w: 9, h: 0.5, fontSize: 16, bold: true, color: WHITE });
}

const file = process.env.OUT_FILE || join(OUT_DIR, "ExamLab-Presentacion-Independientes.pptx");
await pptx.writeFile({ fileName: file });
console.log("OK →", file);
