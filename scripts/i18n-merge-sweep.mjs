// Mergea los fragmentos del sweep (src/i18n/_sweep/*.json) dentro de
// es.json / en.json. Cada fragmento: { es: {dottedKey: val}, en: {dottedKey: val} }.
// Reporta colisiones (no debería haber: namespaces únicos por archivo).
import fs from "node:fs";
import path from "node:path";

const SWEEP = "src/i18n/_sweep";
if (!fs.existsSync(SWEEP)) {
  console.log("no _sweep dir — nada que mergear");
  process.exit(0);
}

const setPath = (obj, dotted, value) => {
  const parts = dotted.split(".");
  const last = parts.pop();
  let n = obj;
  for (const p of parts) {
    if (typeof n[p] !== "object" || n[p] == null) n[p] = {};
    n = n[p];
  }
  const existed = last in n;
  n[last] = value;
  return existed;
};

const frags = fs.readdirSync(SWEEP).filter((f) => f.endsWith(".json"));
const locales = { es: JSON.parse(fs.readFileSync("src/i18n/locales/es.json", "utf8")), en: JSON.parse(fs.readFileSync("src/i18n/locales/en.json", "utf8")) };
let added = { es: 0, en: 0 };
const collisions = [];
for (const fr of frags) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(SWEEP, fr), "utf8"));
  } catch (e) {
    console.warn("fragmento inválido (skip):", fr, e.message);
    continue;
  }
  for (const lang of ["es", "en"]) {
    const m = data[lang] || {};
    for (const [k, v] of Object.entries(m)) {
      if (typeof v !== "string") continue;
      const existed = setPath(locales[lang], k, v);
      if (existed) collisions.push(`${lang}:${k}`);
      else added[lang]++;
    }
  }
}
fs.writeFileSync("src/i18n/locales/es.json", JSON.stringify(locales.es, null, 2) + "\n", "utf8");
fs.writeFileSync("src/i18n/locales/en.json", JSON.stringify(locales.en, null, 2) + "\n", "utf8");
console.log(`fragments: ${frags.length} | es +${added.es} | en +${added.en} | collisions: ${collisions.length}`);
if (collisions.length) console.log("COLLISIONS:\n" + collisions.slice(0, 40).join("\n"));
