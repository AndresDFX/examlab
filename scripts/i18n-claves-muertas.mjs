/**
 * Revisión de claves de traducción que parecen MUERTAS (están en los locales y
 * nadie las usa).
 *
 * ── Por qué no alcanza con "no aparece literal en src/" ───────────────
 * Ese criterio solo produce CANDIDATAS. Una clave puede estar viva sin
 * aparecer nunca escrita entera:
 *   · armada con plantilla:      t(`audit.actionLabels.${action}`)
 *   · armada por concatenación:  t("toast." + modulo + ".guardado")
 *   · guardada en una constante: const K = "nav.courses"; … t(K)
 *   · en un mapa de claves:      { cerrada: "questionBank.type.cerrada", … }
 *   · sufijo de plural:          la clave real es `x_one` / `x_other`
 *   · con namespace partido:     t("clave", { ns: "algo" })
 * Borrar una clave viva no rompe el build ni ningún test: simplemente, el día
 * que se use, el usuario ve la clave cruda en pantalla. Por eso este script
 * NO borra: clasifica y deja el residuo para mirar a mano.
 *
 * ── Cómo clasifica ───────────────────────────────────────────────────
 *   VIVA-LITERAL    la clave completa aparece entrecomillada en src/
 *   VIVA-DINAMICA   su prefijo se arma con plantilla o concatenación
 *   VIVA-PADRE      es hoja de un objeto que se pasa entero (t devuelve rama)
 *   SOSPECHOSA      ninguna de las anteriores → candidata real a borrar
 *
 * Uso:
 *   node scripts/i18n-claves-muertas.mjs            resumen
 *   node scripts/i18n-claves-muertas.mjs --lista    todas las sospechosas
 *   node scripts/i18n-claves-muertas.mjs --ns toast solo ese namespace
 */
import fs from "node:fs";
import path from "node:path";

const RAIZ = process.cwd();

const aplanar = (o, p = "", out = {}) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) aplanar(v, key, out);
    else out[key] = v;
  }
  return out;
};

const es = aplanar(JSON.parse(fs.readFileSync("src/i18n/locales/es.json", "utf8")));

const archivos = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = path.join(d, f.name);
    if (f.isDirectory()) {
      if (!/node_modules|\.git/.test(fp)) walk(fp);
    } else if (/\.(ts|tsx)$/.test(f.name)) archivos.push(fp);
  }
})(path.join(RAIZ, "src"));
const src = archivos.map((f) => fs.readFileSync(f, "utf8")).join("\n");

// ── Sufijos de plural: la clave "real" es la base ───────────────────────
const PLURALES = ["_one", "_other", "_zero", "_two", "_few", "_many"];
const base = (k) => {
  for (const s of PLURALES) if (k.endsWith(s)) return k.slice(0, -s.length);
  return k;
};

// ── 1) Literales: cualquier "a.b.c" entrecomillado en el código ─────────
const literales = new Set();
for (const m of src.matchAll(/["'`]([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)["'`]/g)) literales.add(m[1]);

// ── 2) Prefijos dinámicos ───────────────────────────────────────────────
// a) plantilla:  t(`ns.sub.${x}`)  /  i18nKey={`ns.${x}`}
const prefijos = new Set();
for (const m of src.matchAll(/[`]([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\.\$\{/g)) prefijos.add(m[1]);
// b) concatenación:  "ns.sub." + algo
for (const m of src.matchAll(/["']([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\.["']\s*\+/g))
  prefijos.add(m[1]);
// c) plantilla que empieza por variable y termina en sufijo: `${x}.sufijo`
//    no da prefijo utilizable; se ignora a propósito (ver SOSPECHOSA).

// ── 3) Ramas completas: t("ns.sub", { returnObjects }) o el padre citado ─
// Si el código cita "a.b" y la clave es "a.b.c", la rama puede consumirse
// entera (returnObjects) o usarse como prefijo de una plantilla.
const citadoComoRama = (k) => {
  const partes = k.split(".");
  for (let i = partes.length - 1; i >= 2; i--) {
    if (literales.has(partes.slice(0, i).join("."))) return partes.slice(0, i).join(".");
  }
  return null;
};

const clasificar = (k) => {
  if (literales.has(k)) return ["VIVA-LITERAL", ""];
  for (const p of prefijos) if (k === p || k.startsWith(`${p}.`)) return ["VIVA-DINAMICA", p];
  const rama = citadoComoRama(k);
  if (rama) return ["VIVA-PADRE", rama];
  return ["SOSPECHOSA", ""];
};

const claves = [...new Set(Object.keys(es).map(base))];
const filas = claves.map((k) => {
  const [estado, por] = clasificar(k);
  return { clave: k, estado, por, texto: String(es[k] ?? es[`${k}_other`] ?? "") };
});

const conteo = filas.reduce((a, f) => ((a[f.estado] = (a[f.estado] ?? 0) + 1), a), {});
const sospechosas = filas.filter((f) => f.estado === "SOSPECHOSA");

/**
 * Dos niveles dentro de las sospechosas, porque NO tienen el mismo riesgo:
 *
 *   RENOMBRADA  existe otra clave VIVA con el texto idéntico → la cadena sigue
 *               en pantalla por la clave nueva, y esta es la sobra de un
 *               renombrado. Borrarla no le puede quitar texto a nadie.
 *   HUERFANA    su texto no existe en ninguna clave viva → o la funcionalidad
 *               se quitó (confirmado en varias: el tile «Sesiones hoy» que el
 *               propio código dice haber reemplazado, la tab «Generaciones»
 *               que el refactor de la cola de IA eliminó), o es un uso que
 *               este barrido no ve. Mirar una por una antes de tocarlas.
 */
const textosVivos = new Set(
  filas.filter((f) => f.estado !== "SOSPECHOSA" && f.texto).map((f) => f.texto),
);
for (const f of sospechosas) {
  f.nivel = f.texto && textosVivos.has(f.texto) ? "RENOMBRADA" : "HUERFANA";
}

const nsArg = process.argv.indexOf("--ns");
const filtroNs = nsArg >= 0 ? process.argv[nsArg + 1] : null;
const aMostrar = filtroNs
  ? sospechosas.filter((f) => f.clave.startsWith(`${filtroNs}.`))
  : sospechosas;

console.log(`claves distintas: ${claves.length}`);
for (const [k, v] of Object.entries(conteo).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(5)}  ${k}`);
}

const porNs = sospechosas.reduce(
  (a, f) => ((a[f.clave.split(".")[0]] = (a[f.clave.split(".")[0]] ?? 0) + 1), a),
  {},
);
const porNivel = sospechosas.reduce((a, f) => ((a[f.nivel] = (a[f.nivel] ?? 0) + 1), a), {});
console.log(`\nSOSPECHOSAS: ${sospechosas.length}`);
console.log(`  RENOMBRADA (hay otra clave viva con el MISMO texto): ${porNivel.RENOMBRADA ?? 0}`);
console.log(`  HUERFANA   (texto que no existe en ninguna clave viva): ${porNivel.HUERFANA ?? 0}`);

console.log(`\nSOSPECHOSAS por namespace (${sospechosas.length}):`);
for (const [n, c] of Object.entries(porNs)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15)) {
  console.log(`  ${String(c).padStart(5)}  ${n}`);
}

if (process.argv.includes("--lista") || filtroNs) {
  console.log(`\n--- sospechosas${filtroNs ? ` de ${filtroNs}` : ""} ---`);
  for (const f of aMostrar) console.log(`  ${f.clave}\n      ${f.texto.slice(0, 90)}`);
}
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(aMostrar, null, 1));
}
