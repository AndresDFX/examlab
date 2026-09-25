/**
 * Busca notas de preguntas CERRADAS que contradigan su propia clave.
 *
 * Una pregunta cerrada es todo-o-nada y su nota es verificable sin criterio:
 * o la opción elegida es la correcta y vale sus puntos, o no lo es y vale 0.
 * Cualquier otra cosa es un error, y este script lo encuentra.
 *
 * ── Por qué hace falta ────────────────────────────────────────────────
 *
 * En septiembre de 2026, el camino de recalificación del docente ponía 0 a
 * toda pregunta cerrada. Tres estudiantes del taller «Joins en SQL» quedaron
 * con nota inferior a la que les correspondía —uno con 0 habiendo acertado las
 * dos— y otro recibió el punto de una pregunta en blanco. El código ya está
 * arreglado y `deterministic-paridad.test.ts` impide que vuelva a divergir,
 * pero un test no puede ver las notas YA ESCRITAS: el fallo lo descubrió un
 * estudiante reclamando.
 *
 * Esto cierra esa mitad. Es de SOLO LECTURA: informa y no corrige, porque
 * cambiar una nota es del docente.
 *
 * Uso:
 *   node scripts/auditar-notas-cerradas.mjs                 (toda la base)
 *   node scripts/auditar-notas-cerradas.mjs <tenant_id>     (una institución)
 *
 * Sale con código 1 si encuentra algo, para poder encadenarlo.
 */
import { execFileSync } from "node:child_process";

const q = (path) =>
  JSON.parse(
    execFileSync("node", ["scripts/db-query.mjs", path], {
      encoding: "utf8",
      maxBuffer: 1 << 26,
    }),
  );

const tenant = process.argv[2] ?? null;

/** Índice normalizado, o null. El taller guarda `selected_option` como TEXTO. */
function indice(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const cursos = q(
  `courses?select=id,name,tenant_id&deleted_at=is.null${tenant ? `&tenant_id=eq.${tenant}` : ""}`,
);
if (cursos.length === 0) {
  console.log("No hay cursos en ese alcance.");
  process.exit(0);
}
const nombreCurso = new Map(cursos.map((c) => [c.id, c.name]));
const idsCursos = cursos.map((c) => c.id).join(",");

let revisadas = 0;
const hallazgos = [];

// ── Talleres (M:N con cursos) ────────────────────────────────────────
const vistos = new Set();
for (const wc of q(`workshop_courses?select=workshop_id,course_id&course_id=in.(${idsCursos})`)) {
  if (vistos.has(wc.workshop_id)) continue;
  vistos.add(wc.workshop_id);
  const w = q(`workshops?select=id,title,deleted_at&id=eq.${wc.workshop_id}`)[0];
  if (!w || w.deleted_at) continue;

  const cerradas = q(
    `workshop_questions?select=id,position,points,options&workshop_id=eq.${w.id}&type=eq.cerrada`,
  );
  if (cerradas.length === 0) continue;

  for (const s of q(`workshop_submissions?select=id,user_id&workshop_id=eq.${w.id}`)) {
    const filas = q(
      `workshop_submission_answers?select=question_id,selected_option,ai_grade&submission_id=eq.${s.id}`,
    );
    const porPregunta = new Map(filas.map((f) => [f.question_id, f]));
    for (const p of cerradas) {
      const r = porPregunta.get(p.id);
      // Sin fila o sin nota todavía no es un error: está pendiente de calificar.
      if (!r || r.ai_grade === null || r.ai_grade === undefined) continue;
      revisadas++;
      const debe = indice(r.selected_option) === indice(p.options?.correct_index) &&
        indice(r.selected_option) !== null
          ? Number(p.points)
          : 0;
      if (Number(r.ai_grade) === debe) continue;
      const perfil = q(`profiles?select=full_name&id=eq.${s.user_id}`)[0];
      hallazgos.push({
        donde: `${w.title} · ${nombreCurso.get(wc.course_id) ?? ""}`,
        quien: perfil?.full_name ?? s.user_id,
        pregunta: p.position + 1,
        eligio: indice(r.selected_option),
        clave: indice(p.options?.correct_index),
        debe,
        tiene: Number(r.ai_grade),
      });
    }
  }
}

// ── Informe ──────────────────────────────────────────────────────────
console.log(`Respuestas cerradas con nota puesta: ${revisadas}`);
if (hallazgos.length === 0) {
  console.log("Ninguna contradice su clave.");
  process.exit(0);
}

console.log(`\nCon la nota MAL puesta: ${hallazgos.length}\n`);
const porTaller = new Map();
for (const h of hallazgos) {
  if (!porTaller.has(h.donde)) porTaller.set(h.donde, []);
  porTaller.get(h.donde).push(h);
}
for (const [donde, lista] of porTaller) {
  console.log(`  ${donde}`);
  for (const h of lista) {
    const sentido = h.debe > h.tiene ? "le falta" : "le sobra";
    console.log(
      `    ${h.quien} · P${h.pregunta}: eligió ${h.eligio ?? "nada"}, clave ${h.clave ?? "ninguna"}` +
        ` → debería ${h.debe}, tiene ${h.tiene} (${sentido})`,
    );
  }
}
console.log(
  "\nEste script NO corrige: cambiar una nota es del docente. Los que 'le falta'" +
    "\nson error de la plataforma; los que 'le sobra' bajan una nota ya publicada.",
);
process.exit(1);
