/**
 * Detecta texto VISIBLE escrito directo en el código, sin pasar por `t()`.
 *
 * ── Por qué hace falta además de `i18n-audit.mjs` ─────────────────────
 * Esa auditoría mira la paridad es/en y las claves literales `t("a.b")` que se
 * usan y no existen. Hoy da 9881/9881 y cero faltantes — y aun así puede haber
 * pantallas a medio traducir, porque lo que NO ve es la cadena que nunca llamó
 * a `t()`: un `placeholder="Buscar curso…"` o un `toast.error("No se pudo
 * guardar")` no aparece como clave faltante, aparece como que todo está bien.
 * Ese es el hueco real de "i18n faltante".
 *
 * ── Qué mira ──────────────────────────────────────────────────────────
 *  1. Props que el usuario LEE: placeholder, title, aria-label, label,
 *     description, confirmLabel, cancelLabel, emptyLabel, hint, subtitle.
 *  2. `toast.success|error|info|warning("…")` con literal.
 *  3. Nodos de texto JSX: `>Texto<`.
 *
 * ── Cómo decide que es español y no un identificador ──────────────────
 * Exige señal POSITIVA de castellano: una tilde/ñ/signo de apertura, o dos o
 * más palabras funcionales (el, la, de, que, no se…). Sin eso, `"outline"` o
 * `"user_id"` entrarían como hallazgos y el reporte sería inservible.
 *
 * ── Lo que se excluye, y por qué ──────────────────────────────────────
 *  · Comentarios: este repo comenta en español a propósito y de forma extensa.
 *    Sin quitarlos, el ruido entierra todo lo demás.
 *  · `defaultValue:` dentro de un `t()`: es el respaldo legítimo del patrón
 *    `t("clave", { defaultValue: "…" })`, no texto sin traducir.
 *  · `className`, rutas, imports y `console.*`: no los lee nadie.
 *  · Tests y `scripts/`.
 */
import fs from "node:fs";
import path from "node:path";

const RAIZ = process.cwd();

/** Quita comentarios y el contenido de `className=""`, que es lo que más ruido mete. */
/**
 * Reemplaza conservando los SALTOS DE LÍNEA del texto original.
 *
 * Sin esto, quitar un comentario de 8 líneas corre todo lo que sigue 8 líneas
 * hacia arriba y el detector reporta posiciones que no existen: el primer
 * intento apuntaba a `AdminEmailSettingsPanel.tsx:299` y ahí no había nada del
 * hallazgo. Un reporte que no se puede ir a verificar no sirve para nada.
 */
const huecoConSaltos = (m) => m.replace(/[^\n]/g, " ");

function limpiar(src) {
  return (
    src
      .replace(/\/\*[\s\S]*?\*\//g, huecoConSaltos) //  /* … */  y  {/* … */}
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + " ".repeat(Math.max(0, m.length - p.length)))
      .replace(/className=\{?["'`][^"'`]*["'`]\}?/g, huecoConSaltos)
      .replace(/className=\{cn\([\s\S]*?\)\}/g, huecoConSaltos)
      // `defaultValue: "…"` es el respaldo del patrón t("clave", {defaultValue}):
      // ESO YA ES i18n. Sin quitarlo, el detector reporta como «sin traducir»
      // justamente el mecanismo de traducción, que es la peor clase de ruido.
      .replace(/defaultValue\s*:\s*(["'`])(?:\\.|(?!\1)[\s\S])*?\1/g, huecoConSaltos)
      // `<Trans>` TAMBIÉN es i18n: es el componente para texto con formato. Su
      // respaldo va en la prop `defaults=`, y la mayoría de sus usos en este repo
      // son AUTOCERRADOS (`<Trans … />`), así que buscar el par de apertura y
      // cierre no alcanza — hay que quitar la prop.
      .replace(/\bdefaults\s*=\s*(["'])(?:\\.|(?!\1)[\s\S])*?\1/g, huecoConSaltos)
      .replace(/<Trans[\s\S]*?<\/Trans>/g, huecoConSaltos)
  );
}

const TILDES = /[áéíóúÁÉÍÓÚñÑ¿¡]/;
// Incluye los VERBOS de interfaz de la version anterior (ver, crear, guardar…):
// solos no alcanzan, pero con dos coincidencias delatan una frase de UI.
const FUNCIONALES =
  /\b(el|la|los|las|un|una|de|del|al|que|con|para|por|sin|sobre|este|esta|estos|estas|no|se|su|sus|tu|más|menos|todo|todos|cuando|donde|hay|ya|aún|solo|sólo)\b/gi;

/** Señal POSITIVA de castellano: tilde/ñ, o dos o más palabras funcionales. */
function pareceEspanol(s) {
  const txt = s.trim();
  if (txt.length < 6) return false;
  if (!/[a-zA-ZáéíóúñÁÉÍÓÚÑ]/.test(txt)) return false;
  if (/^[A-Z0-9_]+$/.test(txt)) return false; // CONSTANTE_ASI
  if (/^[a-z0-9_.-]+$/.test(txt) && !txt.includes(" ")) return false; // identificador/ruta
  if (TILDES.test(txt)) return true;
  return (txt.match(FUNCIONALES) ?? []).length >= 2;
}

// Props que el usuario LEE. `alt`, `emptyText` y `tooltip` vienen de la version
// anterior de este script (commit d963a71f): se conservan para no perder
// cobertura al reescribirlo.
const PROPS = [
  "placeholder",
  "title",
  "aria-label",
  "ariaLabel",
  "label",
  "description",
  "confirmLabel",
  "cancelLabel",
  "emptyLabel",
  "emptyText",
  "alt",
  "tooltip",
  "hint",
  "subtitle",
  "etiquetaTodos",
];

const archivos = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = path.join(d, f.name);
    if (f.isDirectory()) {
      if (!/node_modules|\.git|__snapshots__/.test(fp)) walk(fp);
    } else if (/\.tsx?$/.test(f.name) && !/\.test\./.test(f.name)) archivos.push(fp);
  }
})(path.join(RAIZ, "src"));

const hallazgos = [];
const add = (archivo, linea, tipo, texto) =>
  hallazgos.push({
    archivo: path.relative(RAIZ, archivo).replace(/\\/g, "/"),
    linea,
    tipo,
    texto: texto.trim().slice(0, 90),
  });

const rePropsBase = PROPS.map((p) => p.replace(/[-]/g, "\\-")).join("|");
const reProp = new RegExp(`\\b(${rePropsBase})=(?:\\{)?["']([^"']{6,})["']`, "g");
const reToast = /\btoast\.(?:success|error|info|warning)\(\s*["']([^"']{6,})["']/g;
// Nodo de texto JSX: entre `>` y `<`, sin llaves ni etiquetas adentro.
// Un nodo de texto JSX no contiene `;`, `(`, `)` ni `=`: si los trae, lo que se
// matcheó fue CÓDIGO entre un `>` de comparación y un `<` posterior — así
// entraba `setCanScrollRight(el.scrollLeft + el.clientWidth` como si fuera
// texto para el usuario.
const reTextoJsx = />\s*([^<>{}\n;()=][^<>{};()=]{5,})\s*</g;

for (const archivo of archivos) {
  const crudo = fs.readFileSync(archivo, "utf8");
  const src = limpiar(crudo);
  const lineaDe = (i) => src.slice(0, i).split("\n").length;

  for (const m of src.matchAll(reProp)) {
    if (pareceEspanol(m[2])) add(archivo, lineaDe(m.index), `prop ${m[1]}`, m[2]);
  }
  for (const m of src.matchAll(reToast)) {
    if (pareceEspanol(m[1])) add(archivo, lineaDe(m.index), "toast", m[1]);
  }
  for (const m of src.matchAll(reTextoJsx)) {
    if (pareceEspanol(m[1])) add(archivo, lineaDe(m.index), "texto JSX", m[1]);
  }
}

/**
 * Texto en español que NO es una traducción faltante. Cada uno con su motivo,
 * igual que los ACEPTADOS de `audit-ui.mjs` — y por el mismo criterio: esta
 * lista es para casos donde la regla NO APLICA, nunca para silenciar un
 * hallazgo incómodo.
 */
const ACEPTADOS = [
  {
    archivo: "src/modules/admin/AdminPromptsPanel.tsx",
    porque:
      "Son los PROMPTS por defecto que se le mandan al modelo, no interfaz. Y además " +
      "deben quedar byte-idénticos al seed de su migración y al fallback del edge " +
      "(invariante de tres lados, en CLAUDE.md): pasarlos por t() los rompería.",
  },
  {
    archivo: "src/modules/notifications/notification-email.ts",
    porque:
      "Es el pie de un CORREO, que se arma del lado del servidor y sale sin una sesión " +
      "de la que sacar el idioma. Traducir los correos es otra funcionalidad —elegir " +
      "idioma por destinatario y persistirlo—, no una clave suelta.",
  },
  {
    archivo: "src/modules/reports/signature-block.ts",
    porque:
      "Es el HTML del DOCUMENTO generado (el Acuerdo Pedagógico). El documento es un " +
      "artefacto en español que se firma e imprime; su idioma no sigue al de la app.",
  },
];

const esAceptado = (h) => ACEPTADOS.some((a) => h.archivo === a.archivo);

// ── Reporte ────────────────────────────────────────────────────────────
const restantes = hallazgos.filter((h) => !esAceptado(h));
const porArchivo = restantes.reduce((a, h) => ((a[h.archivo] = (a[h.archivo] ?? 0) + 1), a), {});
const orden = Object.entries(porArchivo).sort((a, b) => b[1] - a[1]);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(restantes, null, 1));
} else if (process.argv.includes("--resumen")) {
  console.log(
    `archivos con texto sin traducir: ${orden.length} · hallazgos: ${restantes.length}\n`,
  );
  for (const [f, n] of orden.slice(0, 25)) console.log(`  ${String(n).padStart(4)}  ${f}`);
  const porTipo = restantes.reduce((a, h) => ((a[h.tipo] = (a[h.tipo] ?? 0) + 1), a), {});
  console.log("\npor tipo:", JSON.stringify(porTipo, null, 1));
} else {
  for (const h of restantes) {
    console.log(`${h.archivo}:${h.linea}  [${h.tipo}]  ${h.texto}`);
  }
  console.log(`\nTOTAL ${restantes.length} en ${orden.length} archivos.`);
}
process.exit(0);
