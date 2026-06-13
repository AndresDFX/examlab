// Genera la presentación del PROGRAMA DE ALIADOS de ExamLab: invitación a
// asociarse para revender/referir la plataforma a cambio de una comisión.
// Reutiliza la paleta y el scaffolding de la presentación comercial.
//
//   node scripts/gen-presentation-aliados.mjs
//   OUT_FILE="C:/Temp/x.pptx" node scripts/gen-presentation-aliados.mjs   (override de salida)
//
// Salida: docs/demos/presentacion/ExamLab-Presentacion-Aliados.pptx
//
// NOTA: los % de comisión y los precios son VALORES DE REFERENCIA — ajústalos a
// tu política comercial antes de presentar a un posible aliado.
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
const GOLD = "B45309";        // texto ámbar para dinero/comisión
const GOLDFILL = "FEF3C7";    // fondo ámbar suave
const LIGHT = "F5F3FF";
const WHITE = "FFFFFF";
const MUTED = "64748B";

const pptx = new pptxgen();
pptx.author = "ExamLab";
pptx.company = "ExamLab";
pptx.title = "ExamLab — Programa de Aliados";
pptx.layout = "LAYOUT_WIDE";
const W = 13.333, H = 7.5;

let page = 0;
function footer(slide, accent = PRIMARY) {
  page += 1;
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: H - 0.32, w: W, h: 0.32, fill: { color: LIGHT }, line: { type: "none" } });
  slide.addText("ExamLab · Programa de Aliados", { x: 0.5, y: H - 0.34, w: 9, h: 0.3, fontSize: 9, color: MUTED, valign: "middle" });
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
  s.addText("PROGRAMA DE ALIADOS", { x: 0.82, y: 1.0, w: 11, h: 0.5, fontSize: 13, color: "E0E7FF", charSpacing: 3 });
  s.addText("ExamLab", { x: 0.8, y: 2.7, w: 11.7, h: 1.2, fontSize: 54, bold: true, color: WHITE });
  s.addText("Lleva la plataforma educativa con IA a más instituciones — y gana por cada una.", { x: 0.82, y: 3.95, w: 11.7, h: 0.7, fontSize: 21, color: "C7D2FE" });
  s.addText("Comisiones recurrentes · sin costo de entrada · materiales de venta listos.", { x: 0.82, y: 4.7, w: 11.7, h: 0.5, fontSize: 16, italic: true, color: "A5B4FC" });
}

// ───────── 2. La oportunidad ─────────
contentSlide({
  kicker: "Por qué asociarte",
  title: "La educación con IA está despegando — y el producto ya está listo",
  bullets: [
    "Miles de instituciones siguen perdiendo horas armando y calificando evaluaciones a mano.",
    { t: "ExamLab ya resuelve eso con IA: no vendes una promesa, vendes algo que funciona hoy.", ai: true },
    "Tú pones la relación y los contactos; nosotros ponemos la plataforma, la infraestructura y el soporte.",
    "No necesitas equipo técnico ni instalar nada: es 100% en la nube y en español.",
    { t: "Cada institución que entra te deja ingresos — y si es recurrente, te paga mes a mes.", ai: true },
  ],
  note: "Ser aliado es gratis: sin cuota de entrada, sin mínimos para empezar.",
});

// ───────── 3. Modalidades de comisión (3 tarjetas) ─────────
{
  const s = pptx.addSlide();
  s.background = { color: WHITE };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 1.15, fill: { color: PRIMARY }, line: { type: "none" } });
  s.addText("CÓMO GANAS", { x: 0.6, y: 0.14, w: 11, h: 0.28, fontSize: 11, color: "E0E7FF", charSpacing: 2 });
  s.addText("Tres formas de asociarte", { x: 0.6, y: 0.4, w: 12, h: 0.5, fontSize: 23, bold: true, color: WHITE });
  s.addText("Elige según qué tanto quieras involucrarte: solo referir, vender y acompañar, o escalar.", { x: 0.6, y: 0.88, w: 12, h: 0.28, fontSize: 12.5, color: "E0E7FF" });

  const tiers = [
    { name: "Referido", who: "Solo presentas al cliente; ExamLab cierra y opera.", pct: "10%", basis: "del primer año · pago único", accent: PRIMARY2, hl: false,
      feats: ["Cero gestión de tu parte", "Ideal para un contacto puntual", "Sin compromiso ni metas"] },
    { name: "Aliado Comercial", who: "Vendes y acompañas al cliente en el día a día.", pct: "15%", basis: "recurrente · mientras el cliente siga activo", accent: AI, hl: true,
      feats: ["Cobras también las renovaciones", "Materiales de venta + cuentas demo", "Registro de oportunidad protegido"] },
    { name: "Aliado Premium", who: "Desde 5 instituciones activas a tu nombre.", pct: "20%", basis: "recurrente · + beneficios", accent: PRIMARY, hl: false,
      feats: ["Soporte prioritario y co-branding", "Condiciones especiales por volumen", "Acompañamiento del equipo ExamLab"] },
  ];
  tiers.forEach((t, i) => {
    const x = 0.55 + i * 4.18;
    const w = 3.95;
    const y = 1.6, h = 5.15;
    if (t.hl) {
      s.addShape(pptx.ShapeType.roundRect, { x: x - 0.08, y: y - 0.18, w: w + 0.16, h: h + 0.36, fill: { color: AIBG }, line: { color: t.accent, width: 2.5 }, rectRadius: 0.12, shadow: { type: "outer", blur: 6, offset: 3, color: "A7F3D0" } });
      s.addText("MÁS ELEGIDO", { x: x + w / 2 - 1.0, y: y - 0.30, w: 2.0, h: 0.34, fontSize: 10, bold: true, color: WHITE, align: "center", valign: "middle", fill: { color: t.accent }, rectRadius: 0.08, shape: pptx.ShapeType.roundRect });
    } else {
      s.addShape(pptx.ShapeType.roundRect, { x, y, w, h, fill: { color: WHITE }, line: { color: "CBD5E1", width: 1.25 }, rectRadius: 0.12 });
    }
    s.addShape(pptx.ShapeType.rect, { x, y, w, h: 0.12, fill: { color: t.accent }, line: { type: "none" } });
    s.addText(t.name, { x: x + 0.25, y: y + 0.26, w: w - 0.5, h: 0.5, fontSize: 21, bold: true, color: INK });
    s.addText(t.who, { x: x + 0.25, y: y + 0.78, w: w - 0.5, h: 0.7, fontSize: 12, color: MUTED, valign: "top" });
    s.addText([{ text: t.pct, options: { fontSize: 40, bold: true, color: t.accent } }], { x: x + 0.25, y: y + 1.5, w: w - 0.5, h: 0.7 });
    s.addText(t.basis, { x: x + 0.27, y: y + 2.25, w: w - 0.5, h: 0.45, fontSize: 11.5, italic: true, color: "334155", valign: "top" });
    s.addShape(pptx.ShapeType.line, { x: x + 0.28, y: y + 2.78, w: w - 0.56, h: 0, line: { color: "E2E8F0", width: 1 } });
    const fitems = t.feats.map((f) => ({ text: f, options: { bullet: { code: "2713" }, color: "334155", fontSize: 11.5, paraSpaceAfter: 7 } }));
    s.addText(fitems, { x: x + 0.3, y: y + 2.92, w: w - 0.55, h: 1.95, valign: "top" });
  });
  s.addText("% de comisión de referencia — ajústalos a tu política comercial. La comisión se calcula sobre lo efectivamente cobrado al cliente.", { x: 0.55, y: H - 0.62, w: 12.2, h: 0.28, fontSize: 9, italic: true, color: MUTED, align: "center" });
  footer(s, PRIMARY);
}

// ───────── 4. Cuánto puedes ganar (ejemplos) ─────────
{
  const s = pptx.addSlide();
  s.background = { color: WHITE };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 1.35, fill: { color: AI }, line: { type: "none" } });
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 1.35, w: W, h: 0.06, fill: { color: PRIMARY2 }, line: { type: "none" } });
  s.addText("EJEMPLOS", { x: 0.6, y: 0.22, w: 11, h: 0.3, fontSize: 11, color: "D1FAE5", charSpacing: 2 });
  s.addText("Cuánto puedes ganar", { x: 0.6, y: 0.5, w: 12, h: 0.7, fontSize: 26, bold: true, color: WHITE });

  const head = ["Modalidad", "Qué vendes", "Comisión", "Tu ingreso"].map((t) => ({ text: t, options: { bold: true, color: WHITE, fill: { color: PRIMARY }, fontSize: 13, align: "left", valign: "middle" } }));
  const mk = (a, b, c, d, gold) => [
    { text: a, options: { bold: true, color: INK, fontSize: 12.5, valign: "middle" } },
    { text: b, options: { color: "334155", fontSize: 12, valign: "middle" } },
    { text: c, options: { color: "334155", fontSize: 12, valign: "middle" } },
    { text: d, options: { bold: true, color: gold ? GOLD : AI, fontSize: 13, valign: "middle", fill: gold ? { color: GOLDFILL } : undefined } },
  ];
  const rows = [
    head,
    mk("Referido", "1 plan Institucional ($1.000/mes)", "10% del primer año", "$1.200 una vez", true),
    mk("Aliado Comercial", "1 plan Profesional ($299/mes)", "15% recurrente", "~$45/mes (~$538/año)"),
    mk("Aliado Comercial", "3 planes Institucional ($1.000/mes)", "15% recurrente", "$450/mes ($5.400/año)"),
    mk("Aliado Premium", "1 plan Institucional ($1.000/mes)", "20% recurrente", "$200/mes ($2.400/año)"),
  ];
  s.addTable(rows, { x: 0.7, y: 1.75, w: 11.93, colW: [2.6, 4.2, 2.6, 2.53], rowH: 0.72, border: { type: "solid", color: "E2E8F0", pt: 1 }, align: "left", valign: "middle", margin: 6 });
  s.addShape(pptx.ShapeType.roundRect, { x: 0.7, y: 5.6, w: 11.93, h: 0.95, fill: { color: AIBG }, line: { color: AI, width: 1 }, rectRadius: 0.08 });
  s.addText([
    { text: "Lo bueno de lo recurrente:  ", options: { color: AI, fontSize: 13, bold: true } },
    { text: "lo que cierras este año te sigue pagando el próximo, mientras el cliente renueve. Tu ingreso se acumula con cada institución nueva.", options: { color: INK, fontSize: 12.5, italic: true } },
  ], { x: 0.95, y: 5.6, w: 11.4, h: 0.95, valign: "middle" });
  s.addText("Cifras ilustrativas con precios de referencia ($99/$299/$1.000). Ajusta precios y % a tu política antes de presentarlos.", { x: 0.7, y: H - 0.6, w: 12, h: 0.26, fontSize: 9, italic: true, color: MUTED });
  footer(s, AI);
}

// ───────── 5. Reglas claras / cómo te pagamos ─────────
contentSlide({
  kicker: "Reglas claras",
  title: "Transparente y sin letra chica",
  accent: PRIMARY2,
  bullets: [
    { t: "Registro de oportunidad: el cliente que registras queda protegido 90 días — nadie más cobra por ese lead.", ai: false },
    "Te pagamos mensual o trimestral, sobre lo efectivamente cobrado al cliente.",
    "Sin cuota de entrada ni metas obligatorias para empezar.",
    "No pones infraestructura ni asumes el costo de la IA: el cliente usa su propia API key.",
    { t: "Te damos los materiales de venta: demos en video, presentaciones y cuentas de prueba.", ai: true },
  ],
  note: "Acuerdo simple por escrito: modalidad, % y forma de pago. Sin sorpresas.",
});

// ───────── 6. El proceso en 4 pasos ─────────
{
  const s = pptx.addSlide();
  s.background = { color: WHITE };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 1.35, fill: { color: PRIMARY }, line: { type: "none" } });
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 1.35, w: W, h: 0.06, fill: { color: AI }, line: { type: "none" } });
  s.addText("CÓMO EMPIEZAS", { x: 0.6, y: 0.22, w: 11, h: 0.3, fontSize: 11, color: "E0E7FF", charSpacing: 2 });
  s.addText("En 4 pasos ya estás ganando", { x: 0.6, y: 0.5, w: 12, h: 0.7, fontSize: 26, bold: true, color: WHITE });
  const steps = [
    { n: "1", t: "Te asocias", d: "Acordamos modalidad y % por escrito. Es gratis y toma minutos." },
    { n: "2", t: "Te damos todo", d: "Acceso a demos, presentaciones y cuentas de prueba para mostrar." },
    { n: "3", t: "Presentas / vendes", d: "Registras tus oportunidades; nosotros apoyamos el cierre si lo necesitas." },
    { n: "4", t: "Cobras", d: "Recibes tu comisión — y si es recurrente, mes a mes mientras renueven." },
  ];
  steps.forEach((st, i) => {
    const x = 0.55 + i * 3.18;
    const w = 2.95, y = 1.95, h = 4.0;
    s.addShape(pptx.ShapeType.roundRect, { x, y, w, h, fill: { color: LIGHT }, line: { color: "DDD6FE", width: 1 }, rectRadius: 0.1 });
    s.addShape(pptx.ShapeType.ellipse, { x: x + w / 2 - 0.45, y: y + 0.35, w: 0.9, h: 0.9, fill: { color: i === 3 ? AI : PRIMARY }, line: { type: "none" } });
    s.addText(st.n, { x: x + w / 2 - 0.45, y: y + 0.35, w: 0.9, h: 0.9, fontSize: 30, bold: true, color: WHITE, align: "center", valign: "middle" });
    s.addText(st.t, { x: x + 0.2, y: y + 1.45, w: w - 0.4, h: 0.5, fontSize: 16, bold: true, color: INK, align: "center" });
    s.addText(st.d, { x: x + 0.25, y: y + 2.0, w: w - 0.5, h: 1.8, fontSize: 12.5, color: "334155", align: "center", valign: "top" });
  });
  footer(s, PRIMARY);
}

// ───────── 7. Por qué es fácil de vender ─────────
contentSlide({
  kicker: "Tu argumento de venta",
  title: "ExamLab se vende solo",
  accent: AI,
  bullets: [
    { t: "Ahorra horas reales a los docentes con IA (genera y califica) — beneficio inmediato y tangible.", ai: true },
    "Todo en español y en la nube: sin instalaciones, listo para cualquier institución.",
    "Multi-institución: sirve desde un colegio pequeño hasta una universidad grande.",
    "Demos en video y presentaciones listas — muestras en minutos, no en semanas.",
    "Precio competitivo y plan a la medida para los casos grandes (más de 5.000 estudiantes).",
  ],
  note: "Tú cuentas el problema (horas perdidas) y muestras el demo. El producto hace el resto.",
});

// ───────── 8. Cierre / CTA ─────────
{
  const s = pptx.addSlide();
  s.background = { color: INK };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.08, fill: { color: AI }, line: { type: "none" } });
  s.addText("¿Te asocias?", { x: 0.8, y: 2.2, w: 11.7, h: 1.0, fontSize: 44, bold: true, color: WHITE });
  s.addText("Lleva ExamLab a tu red de instituciones y gana por cada una que entre.", { x: 0.82, y: 3.4, w: 11.7, h: 0.6, fontSize: 19, color: "C7D2FE" });
  s.addShape(pptx.ShapeType.roundRect, { x: 0.82, y: 4.3, w: 6.2, h: 0.95, fill: { color: AI }, line: { type: "none" }, rectRadius: 0.1 });
  s.addText([
    { text: "Escríbeme y empezamos", options: { fontSize: 18, bold: true, color: WHITE } },
    { text: "\n[tu correo / WhatsApp aquí]", options: { fontSize: 13, color: "D1FAE5" } },
  ], { x: 1.05, y: 4.3, w: 5.8, h: 0.95, valign: "middle" });
  s.addText("Acordamos modalidad y % en una llamada corta. Sin compromiso.", { x: 0.82, y: 5.5, w: 11.7, h: 0.5, fontSize: 14, italic: true, color: "A5B4FC" });
}

const file = process.env.OUT_FILE || join(OUT_DIR, "ExamLab-Presentacion-Aliados.pptx");
await pptx.writeFile({ fileName: file });
console.log("OK →", file);
