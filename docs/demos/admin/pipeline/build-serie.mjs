// Concatena TODOS los módulos de un rol en una "serie completa" reproducible.
// Antes las serie-<rol>-completa.mp4 se armaban a mano; esto las deriva de los
// MP4 ya generados en docs/demos/<rol>/output (orden por nombre = orden del curso).
//
// Uso:  node build-serie.mjs admin student teacher
//
// Requisitos: los módulos individuales ya generados por make.mjs/build-mux.mjs.
// Como todos salen de build-mux con los MISMOS parámetros (libx264 yuv420p 30fps
// + aac 160k), el concat demuxer con `-c copy` es lossless y rápido.
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";

const BIN = "C:/Temp/examlab-rec/ffmpeg/ffmpeg-8.1.1-essentials_build/bin";
const FF = `${BIN}/ffmpeg.exe`;
const REPO = "C:/Projects/Personal/examlab/docs/demos";

const roles = process.argv.slice(2);
if (!roles.length) {
  console.error("Uso: node build-serie.mjs <rol> [rol...]  (admin | student | teacher)");
  process.exit(1);
}

for (const role of roles) {
  const dir = `${REPO}/${role}/output`;
  const files = readdirSync(dir)
    .filter((f) => /^modulo-.*\.mp4$/.test(f))
    .sort(); // nombres zero-padded (modulo-01, modulo-s01, modulo-t01) → orden correcto
  if (!files.length) {
    console.error(`✗ ${role}: sin módulos en ${dir}`);
    continue;
  }
  const listPath = `C:/Temp/examlab-rec/_serie-${role}.txt`;
  writeFileSync(listPath, files.map((f) => `file '${dir}/${f}'`).join("\n") + "\n");
  const out = `${REPO}/${role}/serie-${role}-completa.mp4`;
  console.log(`\n=== ${role}: ${files.length} módulos → serie-${role}-completa.mp4 ===`);
  files.forEach((f) => console.log("  + " + f));
  execFileSync(FF, ["-y", "-loglevel", "error", "-stats", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", out], { stdio: "inherit" });
  console.log(`✓ ${out}`);
}
