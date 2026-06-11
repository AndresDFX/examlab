// Driver: procesa una LISTA de módulos en serie (voz → grabar → mux).
// El scratch (audio2/, scene-offsets.json) es compartido y se sobrescribe por
// módulo, así que los 3 pasos de un módulo DEBEN completarse antes del siguiente.
// Uso:  node make.mjs t03 t04 t05 ...
import { execFileSync } from "node:child_process";
const D = "C:/Temp/examlab-rec";
const ids = process.argv.slice(2);
if (!ids.length) { console.error("Uso: node make.mjs <id> [id...]"); process.exit(1); }
const fails = [];
for (const id of ids) {
  const m = `${D}/modules/module-${id}.json`;
  console.log(`\n========================= ${id} =========================`);
  try {
    execFileSync("python", [`${D}/gen-voice.py`, m], { stdio: "inherit" });
    execFileSync("node", [`${D}/record-module.mjs`, m], { stdio: "inherit" });
    execFileSync("node", [`${D}/build-mux.mjs`, m], { stdio: "inherit" });
  } catch (e) {
    console.error(`✗ ${id} FALLÓ: ${e.message}`);
    fails.push(id);
  }
}
console.log(`\nALL DONE. ${ids.length - fails.length}/${ids.length} ok.${fails.length ? " Fallaron: " + fails.join(", ") : ""}`);
