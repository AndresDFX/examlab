// Concatena TODOS los módulos de un rol en una "serie completa" reproducible.
// Antes las serie-<rol>-completa.mp4 se armaban a mano; esto las deriva de los
// MP4 ya generados en docs/demos/<rol>/output (orden por nombre = orden del curso).
//
// Uso:  node build-serie.mjs admin student teacher
//
// Requisitos: los módulos individuales ya generados por make.mjs/build-mux.mjs.
//
// SALIDA ÚNICA `serie-<rol>-completa.mp4`, RE-ENCODED a tamaño web (no `-c copy`).
// WHY re-encode y no copy lossless: el concat lossless de las series largas
// (docente/estudiante) daba 56-81 MB → NO cabe en el límite ~50 MB del upload
// estándar de Supabase Storage, así que hacía falta un segundo archivo
// `serie-<rol>-web.mp4` comprimido a mano SOLO para subir → dos archivos por rol
// y confusión sobre "cuál es la final". Ahora build-serie produce directamente
// UN archivo comprimido (CRF 30 + faststart) que es a la vez el que se revisa,
// el que se sube y el que linkean los correos. Ese archivo ES la serie final.
// (Los módulos ya vienen de build-mux en libx264 yuv420p 30fps; re-encodear el
// concat a CRF 30 preserva la sincronía voz↔pantalla y baja el peso ~2-3×.)
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
  console.log(`\n=== ${role}: ${files.length} módulos → serie-${role}-completa.mp4 (web) ===`);
  files.forEach((f) => console.log("  + " + f));
  // Re-encode a tamaño web (CRF 30 + faststart) → un solo archivo subible.
  // -pix_fmt yuv420p por compat máxima; -movflags +faststart mueve el moov al
  // inicio para streaming progresivo desde Storage.
  execFileSync(
    FF,
    [
      "-y", "-loglevel", "error", "-stats",
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-c:v", "libx264", "-crf", "30", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      out,
    ],
    { stdio: "inherit" },
  );
  console.log(`✓ ${out}`);
}
