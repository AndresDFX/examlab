// Muxing data-driven: combina el video crudo con las narraciones (mp3),
// colocando cada una en su instante = (offset de escena + Δ del arranque),
// con pasada anti-solapamiento. Lee scene-offsets.json (offsets + vstart).
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";

const BIN = "C:/Temp/examlab-rec/ffmpeg/ffmpeg-8.1.1-essentials_build/bin";
const FF = `${BIN}/ffmpeg.exe`, FP = `${BIN}/ffprobe.exe`;
const AUDIO = "C:/Temp/examlab-rec/audio2";
const OUTDIR = "C:/Projects/Personal/examlab/docs/demos/admin/output";
const MODULE_PATH = process.argv[2] ?? "C:/Temp/examlab-rec/modules/module-01.json";
const SPEC = JSON.parse(readFileSync(MODULE_PATH, "utf8"));
const N = SPEC.scenes.length;
const RAW = `C:/Temp/examlab-rec/out/${SPEC.id}-raw.webm`;
const OUT = `${OUTDIR}/${SPEC.id}.mp4`;
const GAP = 120;

const { offsets, vstart } = JSON.parse(readFileSync("C:/Temp/examlab-rec/scene-offsets.json", "utf8"));
const durMs = (f) => Math.round(parseFloat(execFileSync(FP, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim()) * 1000);

const dur = [];
for (let i = 1; i <= N; i++) dur.push(durMs(`${AUDIO}/scene-${i}.mp3`));

// Pasada anti-solapamiento: cada narración arranca en max(offset, fin_anterior+GAP).
const place = [];
let prevEnd = -Infinity;
for (let i = 0; i < N; i++) {
  const start = Math.max(offsets[i], prevEnd + GAP);
  place.push(start);
  prevEnd = start + dur[i];
}
// Δ del arranque del video (medido en la grabación) → instante real en el video.
const videoDelay = place.map((p) => p + vstart);
console.log("Δ (vstart):", vstart, "ms");
videoDelay.forEach((d, i) => console.log(`  scene ${i + 1}: delay=${d}ms  dur=${dur[i]}ms  end=${d + dur[i]}ms`));

const inputs = [];
for (let i = 1; i <= N; i++) inputs.push("-i", `${AUDIO}/scene-${i}.mp3`);
const filters = videoDelay.map((d, i) => `[${i + 1}]adelay=${d}:all=1[a${i + 1}]`);
const mixIn = videoDelay.map((_, i) => `[a${i + 1}]`).join("");
const filterComplex = `${filters.join(";")};${mixIn}amix=inputs=${N}:normalize=0:dropout_transition=0[aout]`;

mkdirSync(OUTDIR, { recursive: true });
const args = [
  "-y", "-loglevel", "error", "-stats",
  "-i", RAW, ...inputs,
  "-filter_complex", filterComplex,
  "-map", "0:v", "-map", "[aout]",
  "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30",
  "-c:a", "aac", "-b:a", "160k",
  OUT,
];
console.log("\nEjecutando ffmpeg...");
execFileSync(FF, args, { stdio: "inherit" });
console.log(`\n✓ ${OUT}`);
