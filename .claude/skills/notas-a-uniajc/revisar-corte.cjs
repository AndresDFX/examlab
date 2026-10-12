// Revisión (SOLO LECTURA) de lo que hay que dejar resuelto en ExamLab antes de leer las
// notas de un corte y pasarlas a la universidad. No escribe nada: dice qué falta y por qué.
//
//   node .claude/skills/notas-a-uniajc/revisar-corte.cjs --corte=1 [--solo=LB141F]
//
// Seis revisiones por curso del periodo (cursos.json):
//   1. Cola de calificación: qué trabajo se procesa y cuál se CANCELA (ya tiene nota).
//   2. Entregas del corte sin nota que no están en la cola.
//   3. Puntajes que parecen registrados como fracción (0,32 en vez de 7 de 22, o 1 en vez de 22).
//   4. Reclamos abiertos con la última palabra del estudiante.
//   5. Sin ninguna asistencia en el corte: de dónde sale su nota (trabajo propio o no).
//   6. Entregas reabiertas que nadie volvió a entregar.
// Lee con la service_role de .env.local (solo GET), igual que scripts/db-query.mjs.
const { CONFIG, leerEnv, argumentos, carpetaDelCorte, archivoCsv, leerCsv, cursosElegidos } = require("./comun.cjs");
const fs = require("fs");

const { opciones } = argumentos();
const CORTE = Number(opciones.corte || 1);
const SB = leerEnv(".env", "VITE_SUPABASE_URL");
const KEY = leerEnv(".env.local", "SUPABASE_SERVICE_ROLE_KEY");
const SIN_ENTREGAR = ["en_progreso", "iniciado", "borrador", "draft", "pendiente", "no_entregado"]; // entrega-hecha.ts
const entrego = (status) => !status || !SIN_ENTREGAR.includes(String(status).trim());
const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });

async function get(ruta) {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const r = await fetch(`${SB}/rest/v1/${ruta}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${desde}-${desde + 999}`, "Range-Unit": "items" } });
    const t = await r.text();
    if (!r.ok) throw new Error(`${ruta.slice(0, 80)} → ${r.status} ${t.slice(0, 160)}`);
    const j = JSON.parse(t);
    filas.push(...j);
    if (j.length < 1000) return filas;
  }
}
const lista = (ids) => [...new Set(ids)].join(",");
async function enLotes(ids, fn) {
  const out = [];
  const u = [...new Set(ids)];
  for (let i = 0; i < u.length; i += 80) out.push(...(await fn(u.slice(i, i + 80))));
  return out;
}

(async () => {
  const cursosDb = await get(`courses?select=id,name&period=eq.${encodeURIComponent(CONFIG.periodo)}&deleted_at=is.null`);
  let bloqueantes = 0;
  for (const curso of cursosElegidos(opciones.solo)) {
    const c = cursosDb.find((x) => x.name.includes(curso.libro));
    console.log(`\n══ ${curso.archivo} ══`);
    if (!c) {
      console.log(`  ✗ no encontré el curso «${curso.libro}» del periodo ${CONFIG.periodo}`);
      continue;
    }
    const cortes = await get(`grade_cuts?select=id,name,start_date,end_date&course_id=eq.${c.id}&order=start_date`);
    const corte = cortes[CORTE - 1];
    if (!corte) {
      console.log(`  ✗ el curso no tiene Corte ${CORTE}`);
      continue;
    }
    console.log(`  ${corte.name}: ${corte.start_date} → ${corte.end_date}`);
    const docentes = new Set((await get(`course_teachers?select=user_id&course_id=eq.${c.id}`)).map((x) => x.user_id));
    const matriculados = (await get(`course_enrollments?select=user_id&course_id=eq.${c.id}`)).map((x) => x.user_id).filter((u) => !docentes.has(u));

    // Actividades del corte: exámenes (con sus recuperaciones) y talleres (unión o ancla).
    const examenes = await get(`exams?select=id,title,parent_exam_id,cut_id,status,weight&course_id=eq.${c.id}&deleted_at=is.null&status=neq.draft`);
    const exDelCorte = examenes.filter((e) => e.cut_id === corte.id || examenes.some((o) => o.id === e.parent_exam_id && o.cut_id === corte.id));
    const union = await get(`workshop_courses?select=workshop_id,cut_id&course_id=eq.${c.id}`);
    const ancla = await get(`workshops?select=id&course_id=eq.${c.id}`);
    const wIds = lista([...union.map((u) => u.workshop_id), ...ancla.map((a) => a.id)]);
    const talleres = wIds ? await get(`workshops?select=id,title,cut_id,course_id,status,due_date,is_external,requires_defense,parent_workshop_id,deleted_at&id=in.(${wIds})`) : [];
    const corteDeTaller = (w) => union.find((u) => u.workshop_id === w.id)?.cut_id || (w.course_id === c.id ? w.cut_id : null);
    const tlDelCorte = talleres.filter((w) => !w.deleted_at && w.status !== "draft" && (corteDeTaller(w) === corte.id || talleres.some((o) => o.id === w.parent_workshop_id && corteDeTaller(o) === corte.id)));

    const intentos = exDelCorte.length ? await get(`submissions?select=id,user_id,exam_id,status,ai_grade,final_override_grade,answers&exam_id=in.(${lista(exDelCorte.map((e) => e.id))})`) : [];
    const entregasT = tlDelCorte.length ? await get(`workshop_submissions?select=id,user_id,workshop_id,group_id,status,ai_grade,final_grade,updated_at&workshop_id=in.(${lista(tlDelCorte.map((w) => w.id))})`) : [];

    // 1. Cola
    const cola = await get(`ai_grading_queue?select=id,target_table,target_row_id,status&course_id=eq.${c.id}&status=in.(pending,processing,failed)`);
    if (cola.length) {
      const subs = cola.filter((j) => j.target_table === "submissions").map((j) => j.target_row_id);
      const wss = cola.filter((j) => j.target_table === "workshop_submissions").map((j) => j.target_row_id);
      const conNota = new Set();
      for (const x of await enLotes(subs, (l) => get(`submissions?select=id,ai_grade,final_override_grade&id=in.(${l.join(",")})`))) if ((x.final_override_grade ?? x.ai_grade) != null) conNota.add(x.id);
      for (const x of await enLotes(wss, (l) => get(`workshop_submissions?select=id,ai_grade,final_grade,status&id=in.(${l.join(",")})`))) if (x.status === "calificado" || (x.final_grade ?? x.ai_grade) != null) conNota.add(x.id);
      const cancelar = cola.filter((j) => conNota.has(j.target_row_id));
      console.log(`  1. Cola: ${cola.length} trabajos → procesar ${cola.length - cancelar.length}, CANCELAR ${cancelar.length} (ya tienen nota)`);
      for (const j of cancelar) console.log(`     cancelar ${j.id} (${j.target_table})`);
      bloqueantes += cola.length;
    } else console.log("  1. Cola: vacía");

    // 2. Entregas sin nota fuera de la cola
    const enCola = new Set(cola.map((j) => j.target_row_id));
    const sinNota = [
      ...intentos.filter((s) => entrego(s.status) && (s.final_override_grade ?? s.ai_grade) == null),
      ...entregasT.filter((s) => {
        const w = tlDelCorte.find((x) => x.id === s.workshop_id);
        const nota = w?.requires_defense ? s.final_grade : (s.final_grade ?? s.ai_grade);
        return entrego(s.status) && nota == null;
      }),
    ].filter((s) => !enCola.has(s.id));
    console.log(`  2. Entregas sin nota fuera de la cola: ${sinNota.length}`);
    for (const s of sinNota) console.log(`     ${s.id} (${s.exam_id ? "examen" : "taller"}, ${s.status})`);
    bloqueantes += sinNota.length;

    // 3. Puntajes con forma de fracción
    const sospechosos = [];
    for (const s of intentos) for (const b of s.answers?.__breakdown ?? []) {
      const p = Number(b.points), x = Number(b.earned);
      if (p >= 5 && x > 0 && x <= 1) sospechosos.push(`examen ${s.id}: ${x} de ${p} — «${String(b.feedback ?? "").replace(/\s+/g, " ").slice(0, 90)}»`);
    }
    if (entregasT.length) {
      const qs = await get(`workshop_questions?select=id,points&workshop_id=in.(${lista(tlDelCorte.map((w) => w.id))})`);
      const pts = new Map(qs.map((q) => [q.id, Number(q.points)]));
      for (const a of await enLotes(entregasT.map((s) => s.id), (l) => get(`workshop_submission_answers?select=submission_id,question_id,ai_grade&submission_id=in.(${l.join(",")})`))) {
        const p = pts.get(a.question_id), x = Number(a.ai_grade);
        if (a.ai_grade != null && p >= 5 && x > 0 && x <= 1) sospechosos.push(`taller ${a.submission_id}: ${x} de ${p}`);
      }
    }
    console.log(`  3. Puntajes que parecen fracción (revisar a mano): ${sospechosos.length}`);
    for (const t of sospechosos) console.log(`     ${t}`);

    // 4. Reclamos abiertos con la última palabra del estudiante
    const subIds = [...intentos.map((s) => s.id), ...entregasT.map((s) => s.id)];
    const hilos = subIds.length ? await enLotes(subIds, (l) => get(`feedback_threads?select=id,closed,submission_id,feedback_comments(author_role,created_at)&closed=eq.false&submission_id=in.(${l.join(",")})`)) : [];
    const abiertos = hilos.filter((h) => {
      const cs = (h.feedback_comments || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
      return cs.length && cs[cs.length - 1].author_role !== "teacher";
    });
    console.log(`  4. Reclamos sin responder: ${abiertos.length}`);
    for (const h of abiertos) console.log(`     hilo ${h.id}`);
    bloqueantes += abiertos.length;

    // 5. Sin ninguna asistencia en el corte
    const sesiones = await get(`attendance_sessions?select=id,session_date&course_id=eq.${c.id}&cut_id=eq.${corte.id}&deleted_at=is.null`);
    const marcas = sesiones.length ? await get(`attendance_records?select=session_id,user_id,status&session_id=in.(${lista(sesiones.map((s) => s.id))})`) : [];
    const dadas = new Set(marcas.filter((m) => (sesiones.find((s) => s.id === m.session_id)?.session_date || "") <= hoy).map((m) => m.session_id));
    const asistio = new Set(marcas.filter((m) => dadas.has(m.session_id) && ["presente", "tarde"].includes(m.status)).map((m) => m.user_id));
    const csvRuta = archivoCsv(carpetaDelCorte(CORTE, opciones.carpeta), CORTE, curso);
    const csv = fs.existsSync(csvRuta) ? leerCsv(csvRuta) : [];
    const nombres = new Map((await enLotes(matriculados, (l) => get(`profiles?select=id,full_name,institutional_email&id=in.(${l.join(",")})`))).map((p) => [p.id, p]));
    const sinAsistencia = dadas.size ? matriculados.filter((u) => !asistio.has(u)) : [];
    console.log(`  5. Sin ninguna asistencia en el corte (${dadas.size} sesiones dadas): ${sinAsistencia.length}`);
    for (const u of sinAsistencia) {
      // Trabajo propio = algo que suma a la nota (la diagnóstica de 0 % no cuenta).
      const conPeso = (s) => { const e = exDelCorte.find((x) => x.id === s.exam_id); const o = e?.parent_exam_id ? exDelCorte.find((x) => x.id === e.parent_exam_id) : e; return Number(o?.weight) > 0; };
      const propio = intentos.some((s) => s.user_id === u && entrego(s.status) && conPeso(s)) || entregasT.some((s) => s.user_id === u && !s.group_id && entrego(s.status) && !tlDelCorte.find((w) => w.id === s.workshop_id)?.is_external);
      const ajena = entregasT.filter((s) => s.user_id === u && (s.group_id || tlDelCorte.find((w) => w.id === s.workshop_id)?.is_external) && (s.final_grade ?? s.ai_grade) > 0);
      const p = nombres.get(u);
      const fila = csv.find((f) => f.correo.toLowerCase() === String(p?.institutional_email).toLowerCase());
      const veredicto = ajena.length ? "TIENE NOTA DE GRUPO/EXTERNA sin asistir → ponerla en 0" : propio ? "trabajo propio en línea → conserva su nota" : "sin actividad → 0 / NP";
      console.log(`     ${p?.full_name ?? u}${fila ? ` (nota del libro ${fila.nota.toFixed(2)})` : ""}: ${veredicto}`);
      if (ajena.length) bloqueantes++;
    }

    // 6. Entregas reabiertas que nadie volvió a entregar
    const vencidos = new Set(tlDelCorte.filter((w) => w.due_date && w.due_date < new Date().toISOString()).map((w) => w.id));
    const abiertasT = entregasT.filter((s) => vencidos.has(s.workshop_id) && !entrego(s.status));
    const reabiertas = [];
    for (const s of abiertasT) {
      // El cambio de nota queda auditado con el id de la entrega: nota → null = reabierta.
      const aud = await get(`audit_logs?select=created_at,metadata&action=eq.integrity.grade_changed&entity_id=eq.${s.id}&order=created_at.desc&limit=10`);
      const borrada = aud.find((a) => a.metadata?.new_value == null && a.metadata?.old_value != null);
      if (borrada) reabiertas.push({ s, antes: borrada.metadata.old_value });
    }
    console.log(`  6. Entregas reabiertas sin volver a entregar: ${reabiertas.length}`);
    for (const { s, antes } of reabiertas) console.log(`     ${nombres.get(s.user_id)?.full_name ?? s.user_id}: tenía ${antes} (entrega ${s.id})`);
  }
  console.log(`\n${bloqueantes ? `✗ ${bloqueantes} cosas por resolver antes de leer el libro (1, 2, 4 y las notas de grupo del punto 5).` : "✓ Nada bloqueante: se puede leer el libro (revisar a mano los puntos 3, 5 y 6 si hay)."}`);
})().catch((e) => {
  console.error("ERROR", e.message);
  process.exit(1);
});
