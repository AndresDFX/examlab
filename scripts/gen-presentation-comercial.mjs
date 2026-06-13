// Genera una presentación PowerPoint COMERCIAL de ExamLab: propuesta de valor +
// 3 planes de suscripción por cantidad de usuarios (instituciones pequeña,
// mediana y grande). Resalta la IA como ahorro de tiempo.
//
//   node scripts/gen-presentation-comercial.mjs
//
// Salida: docs/demos/presentacion/ExamLab-Presentacion-Comercial.pptx
//
// NOTA: los precios son VALORES DE REFERENCIA (placeholders) — ajustar a la
// política comercial real antes de presentar a un cliente.
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

const pptx = new pptxgen();
pptx.author = "ExamLab";
pptx.company = "ExamLab";
pptx.title = "ExamLab — Planes y propuesta comercial";
pptx.layout = "LAYOUT_WIDE";
const W = 13.333, H = 7.5;

let page = 0;
function footer(slide, accent = PRIMARY) {
  page += 1;
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: H - 0.32, w: W, h: 0.32, fill: { color: LIGHT }, line: { type: "none" } });
  slide.addText("ExamLab · Plataforma educativa con IA", { x: 0.5, y: H - 0.34, w: 9, h: 0.3, fontSize: 9, color: MUTED, valign: "middle" });
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

// ───────── 1. Portada comercial ─────────
{
  const s = pptx.addSlide();
  s.background = { color: INK };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 2.5, fill: { color: PRIMARY }, line: { type: "none" } });
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 2.5, w: W, h: 0.08, fill: { color: AI }, line: { type: "none" } });
  s.addText("ExamLab", { x: 0.8, y: 2.7, w: 11.7, h: 1.2, fontSize: 54, bold: true, color: WHITE });
  s.addText("La plataforma educativa con IA — planes para tu institución", { x: 0.82, y: 3.95, w: 11.7, h: 0.6, fontSize: 22, color: "C7D2FE" });
  s.addText("Pequeña, mediana o grande: hay un plan a tu medida.", { x: 0.82, y: 4.6, w: 11.7, h: 0.5, fontSize: 16, italic: true, color: "A5B4FC" });
  s.addText("PROPUESTA COMERCIAL", { x: 0.82, y: 1.0, w: 11, h: 0.5, fontSize: 13, color: "E0E7FF", charSpacing: 3 });
}

// ───────── 2. Por qué ExamLab (hook comercial) ─────────
contentSlide({
  kicker: "Por qué ExamLab",
  title: "Tus docentes pierden horas armando y calificando",
  bullets: [
    "Crear exámenes, talleres y proyectos consume tiempo cada semana.",
    "Calificar entregas a mano es lento y poco trazable.",
    "El material de clase y el seguimiento quedan dispersos en varias herramientas.",
    { t: "ExamLab automatiza con IA lo repetitivo: generar, calificar, tutorizar y detectar copia.", ai: true },
    { t: "Resultado: tus docentes recuperan horas y tu institución gana control.", ai: true },
  ],
  note: "Una sola plataforma, en español, lista para tu institución — sin instalar nada.",
});

// ───────── 3. Lo que incluye ─────────
contentSlide({
  kicker: "La plataforma",
  title: "Todo lo que tu institución necesita",
  accent: PRIMARY2,
  bullets: [
    "Cursos, cronograma y contenidos; exámenes, talleres y proyectos.",
    { t: "Generación de evaluaciones y material con IA, y calificación automática con feedback.", ai: true },
    { t: "Tutor IA del curso y detección de copia entre estudiantes.", ai: true },
    "Asistencia con QR, calendario sincronizado, mensajería, foros y encuestas en vivo.",
    "Certificados, reportes, libro de calificaciones y auditoría — multi-institución.",
  ],
});

// ───────── 4. PLANES (la slide clave) ─────────
{
  const s = pptx.addSlide();
  s.background = { color: WHITE };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 1.15, fill: { color: PRIMARY }, line: { type: "none" } });
  s.addText("PLANES DE SUSCRIPCIÓN", { x: 0.6, y: 0.18, w: 11, h: 0.3, fontSize: 11, color: "E0E7FF", charSpacing: 2 });
  s.addText("Un plan para cada tamaño de institución", { x: 0.6, y: 0.46, w: 12, h: 0.6, fontSize: 24, bold: true, color: WHITE });

  const tiers = [
    { name: "Esencial", target: "Institución pequeña", price: "$99", est: "Hasta 250", doc: "Hasta 20", adm: "3", accent: PRIMARY2, hl: false,
      feats: ["IA: generar y calificar", "Asistencia con QR", "Mensajería y foros"] },
    { name: "Profesional", target: "Institución mediana", price: "$299", est: "Hasta 1.500", doc: "Hasta 80", adm: "6", accent: AI, hl: true,
      feats: ["Todo lo de Esencial", "Tutor IA + antifraude", "Calendario + reportes"] },
    { name: "Institucional", target: "Institución grande", price: "$699", est: "Hasta 6.000", doc: "Hasta 300", adm: "12", accent: PRIMARY, hl: false,
      feats: ["Todo lo de Profesional", "Multi-sede + branding", "Soporte prioritario"] },
  ];
  tiers.forEach((t, i) => {
    const x = 0.55 + i * 4.18;
    const w = 3.95;
    const y = 1.45, h = 5.25;
    if (t.hl) {
      s.addShape(pptx.ShapeType.roundRect, { x: x - 0.08, y: y - 0.18, w: w + 0.16, h: h + 0.36, fill: { color: AIBG }, line: { color: t.accent, width: 2.5 }, rectRadius: 0.12, shadow: { type: "outer", blur: 6, offset: 3, color: "A7F3D0" } });
      s.addText("MÁS POPULAR", { x: x + w / 2 - 1.0, y: y - 0.48, w: 2.0, h: 0.36, fontSize: 10, bold: true, color: WHITE, align: "center", valign: "middle", fill: { color: t.accent }, rectRadius: 0.08, shape: pptx.ShapeType.roundRect });
    } else {
      s.addShape(pptx.ShapeType.roundRect, { x, y, w, h, fill: { color: WHITE }, line: { color: "CBD5E1", width: 1.25 }, rectRadius: 0.12 });
    }
    s.addShape(pptx.ShapeType.rect, { x: x + 0.0, y, w, h: 0.12, fill: { color: t.accent }, line: { type: "none" } });
    s.addText(t.name, { x: x + 0.25, y: y + 0.28, w: w - 0.5, h: 0.5, fontSize: 22, bold: true, color: INK });
    s.addText(t.target, { x: x + 0.25, y: y + 0.82, w: w - 0.5, h: 0.35, fontSize: 12.5, color: MUTED });
    s.addText([{ text: t.price, options: { fontSize: 32, bold: true, color: t.accent } }, { text: "  /mes", options: { fontSize: 13, color: MUTED } }], { x: x + 0.25, y: y + 1.2, w: w - 0.5, h: 0.6 });
    // capacidades
    const cap = [
      { k: "Estudiantes", v: t.est },
      { k: "Docentes", v: t.doc },
      { k: "Administradores", v: t.adm },
    ];
    cap.forEach((c, j) => {
      const cy = y + 2.0 + j * 0.5;
      s.addText(c.k, { x: x + 0.28, y: cy, w: 2.1, h: 0.4, fontSize: 12.5, color: "334155", valign: "middle" });
      s.addText(c.v, { x: x + w - 1.75, y: cy, w: 1.5, h: 0.4, fontSize: 13, bold: true, color: INK, align: "right", valign: "middle" });
    });
    s.addShape(pptx.ShapeType.line, { x: x + 0.28, y: y + 3.55, w: w - 0.56, h: 0, line: { color: "E2E8F0", width: 1 } });
    const fitems = t.feats.map((f) => ({ text: f, options: { bullet: { code: "2713" }, color: "334155", fontSize: 11.5, paraSpaceAfter: 6 } }));
    s.addText(fitems, { x: x + 0.3, y: y + 3.7, w: w - 0.55, h: 1.4, valign: "top" });
  });
  s.addText("Valores de referencia (USD) — ajustar a la política comercial. Capacidad por institución.", { x: 0.55, y: H - 0.62, w: 12.2, h: 0.3, fontSize: 9.5, italic: true, color: MUTED, align: "center" });
  footer(s, PRIMARY);
}

// ───────── 5. Comparativa por plan ─────────
{
  const s = pptx.addSlide();
  s.background = { color: WHITE };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 1.15, fill: { color: PRIMARY2 }, line: { type: "none" } });
  s.addText("COMPARATIVA", { x: 0.6, y: 0.18, w: 11, h: 0.3, fontSize: 11, color: "E9D5FF", charSpacing: 2 });
  s.addText("Qué incluye cada plan", { x: 0.6, y: 0.46, w: 12, h: 0.6, fontSize: 24, bold: true, color: WHITE });
  const rows = [
    ["Característica", "Esencial", "Profesional", "Institucional"],
    ["Cursos, exámenes, talleres y proyectos", "✓", "✓", "✓"],
    ["IA: generación de evaluaciones y contenido", "✓", "✓", "✓"],
    ["IA: calificación automática con feedback", "✓", "✓", "✓"],
    ["Asistencia con QR y mensajería", "✓", "✓", "✓"],
    ["Tutor IA del curso", "—", "✓", "✓"],
    ["Antifraude (detección de copia)", "—", "✓", "✓"],
    ["Sincronización de calendario y reportes", "—", "✓", "✓"],
    ["Multi-sede, branding y auditoría avanzada", "—", "—", "✓"],
    ["Soporte prioritario", "Email", "Email", "Prioritario"],
  ];
  const colX = [0.6, 7.2, 9.25, 11.3];
  const colW = [6.5, 2.0, 2.0, 2.0];
  const y0 = 1.45, rh = 0.5;
  rows.forEach((r, ri) => {
    const y = y0 + ri * rh;
    if (ri === 0) s.addShape(pptx.ShapeType.rect, { x: 0.5, y, w: 12.4, h: rh, fill: { color: INK }, line: { type: "none" } });
    else if (ri % 2 === 0) s.addShape(pptx.ShapeType.rect, { x: 0.5, y, w: 12.4, h: rh, fill: { color: LIGHT }, line: { type: "none" } });
    r.forEach((cell, ci) => {
      const isHead = ri === 0;
      const isCheck = cell === "✓";
      s.addText(cell, {
        x: colX[ci], y, w: colW[ci], h: rh, valign: "middle",
        align: ci === 0 ? "left" : "center",
        fontSize: isHead ? 12.5 : 12,
        bold: isHead || ci === 0,
        color: isHead ? WHITE : isCheck ? AI : cell === "—" ? "94A3B8" : INK,
      });
    });
  });
  footer(s, PRIMARY2);
}

// ───────── 6. Cierre / CTA ─────────
{
  const s = pptx.addSlide();
  s.background = { color: INK };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 2.2, w: W, h: 0.08, fill: { color: AI }, line: { type: "none" } });
  s.addText("Dale tiempo a tus docentes. Control a tu institución.", { x: 0.8, y: 2.5, w: 11.7, h: 1.0, fontSize: 32, bold: true, color: WHITE });
  s.addText("Empieza con el plan que se ajusta a tu tamaño y crece cuando lo necesites.", { x: 0.82, y: 3.7, w: 11.7, h: 0.6, fontSize: 17, color: "C7D2FE" });
  s.addText("✨  IA para generar, calificar, tutorizar y detectar copia", { x: 0.82, y: 4.5, w: 11.7, h: 0.5, fontSize: 15, color: AI, bold: true });
  s.addText("Solicita una demo · ExamLab", { x: 0.82, y: 6.0, w: 9, h: 0.5, fontSize: 16, bold: true, color: WHITE });
}

const file = join(OUT_DIR, "ExamLab-Presentacion-Comercial.pptx");
await pptx.writeFile({ fileName: file });
console.log("OK →", file);
