// Genera la lista de archivos .tsx con literales ES hardcodeados + un
// namespace único por archivo (para el workflow de de-hardcodeo). Imprime JSON.
import fs from "node:fs";
import path from "node:path";

const SP_ACCENT = /[áéíóúñÁÉÍÓÚÑ¿¡]/;
const SP_WORDS =
  /\b(el|la|los|las|un|una|de|del|que|con|sin|para|por|como|más|este|esta|tu|su|ver|crear|eliminar|borrar|guardar|buscar|cancelar|aceptar|nuevo|nueva|todos|todas|cargar|cerrar|abrir|enviar|agregar|quitar|seleccionar|editar|descargar|generar|hay|aún|debes|sesión|asistencia|docente|estudiante|curso|nota)\b/i;
const isSp = (s) => SP_ACCENT.test(s) || (s.split(/\s+/).length >= 2 && SP_WORDS.test(s));
const reAttr = /\b(title|placeholder|aria-label|label|description|alt)=("([^"<{]*)"|'([^'<{]*)')/;
const reText = />\s*([A-Za-zÁÉÍÓÚÑáéíóúñ¿¡][^<>{}\n=();[\]`]*?)\s*</;

const DONE = new Set([
  "src/routes/app.videos.tsx",
  "src/routes/app.student.attendance.tsx",
  "src/shared/components/BulkPasswordDialog.tsx",
]);

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

const hasHardcoded = (src) => {
  for (const line of src.split("\n")) {
    let m = reAttr.exec(line);
    if (m) {
      const v = (m[3] ?? m[4] ?? "").trim();
      if (v.length >= 3 && isSp(v)) return true;
    }
    m = reText.exec(line);
    if (m) {
      const v = m[1].trim();
      if (v.length >= 4 && !/[{}]/.test(v) && !/^[\d\s.,:;/–—-]+$/.test(v) && isSp(v)) return true;
    }
  }
  return false;
};

const camel = (s) =>
  s
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1)))
    .join("");

const used = new Set();
const out = [];
for (const fp of files) {
  const rel = fp.split(path.sep).join("/");
  if (DONE.has(rel)) continue;
  const src = fs.readFileSync(fp, "utf8");
  if (!hasHardcoded(src)) continue;
  // namespace: slug del path (sin src/, sin ext) → único, prefijo hc para no
  // chocar con namespaces existentes y para identificar el sweep.
  const slug = rel.replace(/^src\//, "").replace(/\.tsx$/, "");
  let ns = "hc_" + camel(slug);
  let i = 2;
  while (used.has(ns)) ns = "hc_" + camel(slug) + i++;
  used.add(ns);
  out.push({ file: rel, ns });
}
console.log(JSON.stringify(out));
