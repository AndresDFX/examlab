// Muxing data-driven con LIMPIEZA de tiempos muertos (v2):
//   (A) Recorta el pre-roll: el video arranca en la 1ª narración (elimina el
//       "punto"/cursor sobre pantalla en blanco mientras carga la app).
//   (B) Recorta la cola: termina ~TAIL ms después de la última narración
//       (elimina el "se queda en la pantalla azul" al final).
//   (C) Acelera los huecos SILENCIOSOS largos (> MAX_GAP): p.ej. la espera de
//       generación con IA (~2 min sin voz) queda como timelapse de ~COMP ms.
//   El audio (narraciones) SIEMPRE va a 1× y se re-ubica en la línea de tiempo
//   comprimida, así la sincronía voz↔pantalla dentro de cada escena se preserva.
//
// Lee scene-offsets.json (offsets + vstart) que escribe record-module.mjs.
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";

const BIN = "C:/Temp/examlab-rec/ffmpeg/ffmpeg-8.1.1-essentials_build/bin";
const FF = `${BIN}/ffmpeg.exe`, FP = `${BIN}/ffprobe.exe`;
const AUDIO = "C:/Temp/examlab-rec/audio2";
const MODULE_PATH = process.argv[2] ?? "C:/Temp/examlab-rec/modules/module-01.json";
const SPEC = JSON.parse(readFileSync(MODULE_PATH, "utf8"));
const OUTDIR = `C:/Projects/Personal/examlab/docs/demos/${SPEC.series ?? "admin"}/output`;
const N = SPEC.scenes.length;
const RAW = `C:/Temp/examlab-rec/out/${SPEC.id}-raw.webm`;
const OUT = `${OUTDIR}/${SPEC.id}.mp4`;

// Parámetros de limpieza
const GAP = 120;         // separación mínima anti-solapamiento entre narraciones
const MAX_GAP = 4500;    // hueco silencioso máximo tolerado a 1× (ms)
const COMP = 2200;       // a cuánto se comprime un hueco largo (ms) → timelapse
const TAIL = 1200;       // cola de video tras la última narración (ms)
const LEAD = 600;        // respiro de video/silencio ANTES de la 1ª narración (ms).
                         // Subido de 250 → 600: con 250 la voz arrancaba casi en
                         // t=0 y sonaba "trabada"/abrupta al iniciar. El respiro
                         // + el afade-in de abajo dan un arranque limpio.

const { offsets, vstart } = JSON.parse(readFileSync("C:/Temp/examlab-rec/scene-offsets.json", "utf8"));
const durMs = (f) => Math.round(parseFloat(execFileSync(FP, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim()) * 1000);
const rawDurMs = durMs(RAW);

const dur = [];
for (let i = 1; i <= N; i++) dur.push(durMs(`${AUDIO}/scene-${i}.mp3`));

// Anti-solapamiento: cada narración arranca en max(offset, fin_anterior+GAP).
const place = [];
let prevEnd = -Infinity;
for (let i = 0; i < N; i++) {
  const start = Math.max(offsets[i], prevEnd + GAP);
  place.push(start);
  prevEnd = start + dur[i];
}

// Ventanas de audio en tiempo de FUENTE (τ_src, 0 = inicio del raw = tCtx).
const aStart = place.map((p) => p + vstart);
const aEnd = aStart.map((s, i) => s + dur[i]);

// Construir segmentos de video (en τ_src) con su factor de velocidad y calcular
// la nueva posición de cada narración en la línea de tiempo de SALIDA.
const segs = [];        // { a, b, f }  ms fuente + factor (f=1 normal, f>1 acelera)
const newStart = [];    // ms de salida donde arranca cada narración
let outMs = 0;

// Lead: pequeño trozo de video ANTES de la 1ª narración (la carátula ya montada),
// recortado a LEAD ms como máximo (elimina el pre-roll en blanco largo).
const firstLeadSrcStart = Math.max(0, aStart[0] - LEAD);
if (aStart[0] - firstLeadSrcStart > 0) {
  segs.push({ a: firstLeadSrcStart, b: aStart[0], f: 1 });
  outMs += aStart[0] - firstLeadSrcStart;
}

for (let i = 0; i < N; i++) {
  // Ventana de narración i (1×, sincronía preservada).
  segs.push({ a: aStart[i], b: aEnd[i], f: 1 });
  newStart[i] = outMs;
  outMs += aEnd[i] - aStart[i];

  // Hueco hasta la siguiente narración (o cola tras la última).
  const gapEnd = i < N - 1 ? aStart[i + 1] : Math.min(rawDurMs, aEnd[i] + TAIL);
  const gapLen = gapEnd - aEnd[i];
  if (gapLen > 0) {
    const compressible = i < N - 1 && gapLen > MAX_GAP;
    const f = compressible ? gapLen / COMP : 1;
    segs.push({ a: aEnd[i], b: gapEnd, f });
    outMs += (gapEnd - aEnd[i]) / f;
  }
}

console.log(`raw=${rawDurMs}ms vstart=${vstart}ms → salida≈${Math.round(outMs)}ms · ${segs.length} segmentos`);
const sped = segs.filter((s) => s.f > 1);
if (sped.length) sped.forEach((s) => console.log(`  ⏩ hueco ${Math.round(s.b - s.a)}ms → ${Math.round((s.b - s.a) / s.f)}ms (×${s.f.toFixed(1)})`));

// ── filter_complex ────────────────────────────────────────────────────
const sec = (ms) => (ms / 1000).toFixed(3);
// [0:v] solo puede consumirse UNA vez; hay que split-earlo en N copias antes de
// hacer un trim por segmento.
const splitOuts = segs.map((_, k) => `[s${k}]`).join("");
const vSplit = `[0:v]split=${segs.length}${splitOuts}`;
const vParts = segs.map((sg, k) => {
  const speedExpr = sg.f === 1 ? "PTS-STARTPTS" : `(PTS-STARTPTS)/${sg.f.toFixed(6)}`;
  return `[s${k}]trim=start=${sec(sg.a)}:end=${sec(sg.b)},setpts=${speedExpr}[v${k}]`;
});
const vConcatIn = segs.map((_, k) => `[v${k}]`).join("");
const vFilter = `${vSplit};${vParts.join(";")};${vConcatIn}concat=n=${segs.length}:v=1:a=0[vout]`;

// afade-in de 150ms al inicio de CADA narración: mata el "click"/garble de
// arranque de los mp3 de edge-tts (síntoma reportado: "se traba la voz al
// iniciar" y "no se entiende" en algunos arranques). Es un fade corto: no
// recorta contenido audible, solo suaviza el ataque del 1er fonema.
const aParts = newStart.map((d, i) => `[${i + 1}]afade=t=in:st=0:d=0.15,adelay=${Math.round(d)}:all=1[a${i + 1}]`);
const aMixIn = newStart.map((_, i) => `[a${i + 1}]`).join("");
// afade-in global de 120ms sobre la mezcla: cubre el priming de amix en t≈0.
const aFilter = `${aParts.join(";")};${aMixIn}amix=inputs=${N}:normalize=0:dropout_transition=0[amixraw];[amixraw]afade=t=in:st=0:d=0.12[aout]`;

const inputs = ["-i", RAW];
for (let i = 1; i <= N; i++) inputs.push("-i", `${AUDIO}/scene-${i}.mp3`);

mkdirSync(OUTDIR, { recursive: true });
const args = [
  "-y", "-loglevel", "error", "-stats",
  ...inputs,
  "-filter_complex", `${vFilter};${aFilter}`,
  "-map", "[vout]", "-map", "[aout]",
  "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30",
  "-c:a", "aac", "-b:a", "160k",
  OUT,
];
console.log("\nEjecutando ffmpeg...");
execFileSync(FF, args, { stdio: "inherit" });
console.log(`\n✓ ${OUT}`);
