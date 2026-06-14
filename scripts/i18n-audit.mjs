// Auditoría i18n (uso interno, no se commitea como parte de la app):
//  - parity es/en
//  - claves literales t("a.b") usadas en código pero ausentes en es.json
import fs from "node:fs";
import path from "node:path";

const flat = (o, p = "", out = {}) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? p + "." + k : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flat(v, key, out);
    else out[key] = v;
  }
  return out;
};

const es = flat(JSON.parse(fs.readFileSync("src/i18n/locales/es.json", "utf8")));
const en = flat(JSON.parse(fs.readFileSync("src/i18n/locales/en.json", "utf8")));
const esK = new Set(Object.keys(es));
const enK = new Set(Object.keys(en));

console.log("es:", esK.size, "en:", enK.size);
console.log("es-not-en:", [...esK].filter((k) => !enK.has(k)).length);
console.log("en-not-es:", [...enK].filter((k) => !esK.has(k)).length);

const files = [];
const walk = (d) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = path.join(d, f.name);
    if (f.isDirectory()) {
      if (!/node_modules|\.git/.test(fp)) walk(fp);
    } else if (/\.(ts|tsx)$/.test(f.name) && !/\.test\./.test(f.name)) files.push(fp);
  }
};
walk("src");

// Plural-aware: i18next resuelve t("x", {count}) contra x_one/x_other/etc.
const PLURAL = ["_one", "_other", "_zero", "_two", "_few", "_many"];
const present = (key) => esK.has(key) || PLURAL.some((s) => esK.has(key + s));

const reKey = /(?:\bi18n\.)?\bt\(\s*["']([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)["']/g;
const missing = {};
let totalCalls = 0;
for (const fp of files) {
  const src = fs.readFileSync(fp, "utf8");
  let m;
  while ((m = reKey.exec(src))) {
    const key = m[1];
    totalCalls++;
    if (!present(key)) {
      const tail = src.slice(m.index, m.index + 280);
      const hasDefault = /defaultValue\s*:/.test(tail);
      const rec = (missing[key] = missing[key] || { count: 0, withDefault: 0, files: new Set() });
      rec.count++;
      if (hasDefault) rec.withDefault++;
      rec.files.add(fp.split(path.sep).join("/"));
    }
  }
}
const entries = Object.entries(missing);
const noDefault = entries.filter(([, v]) => v.withDefault < v.count);
console.log("\nliteral t() scanned:", totalCalls);
console.log("distinct missing keys:", entries.length);
console.log("missing keys with >=1 call lacking defaultValue (RAW KEY shown):", noDefault.length);
console.log("\n--- raw-key risks (key | calls | woDefault | first file) ---");
noDefault
  .sort((a, b) => b[1].count - a[1].count)
  .forEach(([k, v]) => console.log(`${k} | ${v.count} | ${v.count - v.withDefault} | ${[...v.files][0]}`));
