// Inventario de literales en español hardcodeados (no vía t()) en la UI.
// Heurística: detecta atributos de texto + nodos de texto JSX que contengan
// caracteres acentuados o palabras-función del español (alta precisión).
import fs from "node:fs";
import path from "node:path";

const SP_ACCENT = /[áéíóúñÁÉÍÓÚÑ¿¡]/;
const SP_WORDS =
  /\b(el|la|los|las|un|una|unos|unas|de|del|que|con|sin|para|por|como|más|este|esta|estos|estas|tu|tus|su|sus|ver|crear|eliminar|borrar|guardar|buscar|cancelar|aceptar|nuevo|nueva|todos|todas|sí|no|cargar|cerrar|abrir|enviar|agregar|añadir|quitar|seleccionar|filtrar|editar|descargar|subir|generar)\b/i;
const isSpanish = (s) => SP_ACCENT.test(s) || (s.split(/\s+/).length >= 2 && SP_WORDS.test(s));

const files = [];
const walk = (d) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = path.join(d, f.name);
    if (f.isDirectory()) {
      if (!/node_modules|\.git/.test(fp)) walk(fp);
    } else if (/\.tsx$/.test(f.name) && !/\.test\./.test(f.name)) files.push(fp);
  }
};
walk("src");

// Atributos de texto que el usuario ve.
const ATTRS = ["title", "placeholder", "aria-label", "label", "description", "alt", "confirmLabel", "cancelLabel", "emptyText", "subtitle", "tooltip"];
const reAttr = new RegExp(`\\b(${ATTRS.join("|")})=("([^"<{]*)"|'([^'<{]*)')`, "g");
// Texto JSX entre tags: >  texto  <  (sin {expresiones}, sin código).
// Excluir saltos de línea y caracteres típicos de código para no capturar
// fragmentos de TS (generics, useState, etc.) que rodean a `>`/`<`.
const reText = />\s*([A-Za-zÁÉÍÓÚÑáéíóúñ¿¡][^<>{}\n=();[\]`]*?)\s*</g;

const byFile = {};
let attrCount = 0,
  textCount = 0;
for (const fp of files) {
  const src = fs.readFileSync(fp, "utf8");
  const rel = fp.split(path.sep).join("/");
  const hits = [];
  let m;
  while ((m = reAttr.exec(src))) {
    const val = (m[3] ?? m[4] ?? "").trim();
    if (val.length >= 3 && isSpanish(val)) {
      hits.push({ kind: m[1], text: val });
      attrCount++;
    }
  }
  while ((m = reText.exec(src))) {
    const val = m[1].trim();
    // descartar: vacío, solo símbolos, contiene `t(` o `{`, números, etc.
    if (val.length < 4 || /[{}]/.test(val) || /^[\d\s.,:;/–—-]+$/.test(val)) continue;
    if (isSpanish(val)) {
      hits.push({ kind: "TEXT", text: val });
      textCount++;
    }
  }
  if (hits.length) byFile[rel] = hits;
}

const ranked = Object.entries(byFile).sort((a, b) => b[1].length - a[1].length);
console.log(`files with hardcoded ES: ${ranked.length} | attr hits: ${attrCount} | text hits: ${textCount} | total: ${attrCount + textCount}`);
console.log("\n--- top files (count) ---");
ranked.slice(0, 40).forEach(([f, h]) => console.log(`${String(h.length).padStart(3)}  ${f}`));
