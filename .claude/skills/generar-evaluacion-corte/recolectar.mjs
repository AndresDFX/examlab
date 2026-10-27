#!/usr/bin/env node
/**
 * Reúne TODO lo que se le presentó a un curso en una ventana de fechas y lo
 * deja en un dossier Markdown para armar el taller o el parcial del corte.
 *
 *   node .claude/skills/generar-evaluacion-corte/recolectar.mjs \
 *     --curso <uuid> --desde 2026-09-28 --hasta 2026-10-25 [--corte-anterior <cut_uuid>]
 *
 * Solo LECTURA (service_role de .env.local, igual que scripts/db-query.mjs).
 * Escribe en privado/evaluaciones/ — está en .gitignore: las transcripciones
 * no salen del equipo (el repo es público).
 *
 * Lo que NO se lee a propósito: `content_text` de las transcripciones (voces de
 * estudiantes). Solo `teacher_text`, la misma regla del Tutor IA.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

function leerSecreto(nombre) {
  if (process.env[nombre]) return process.env[nombre];
  for (const archivo of [".env.local", ".env"]) {
    try {
      const m = readFileSync(archivo, "utf8").match(new RegExp(`^${nombre}\\s*=\\s*"?([^"\\r\\n]+)"?`, "m"));
      if (m) return m[1];
    } catch {
      /* puede no existir */
    }
  }
  return null;
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith("--") ? [...acc, [v.slice(2), a[i + 1]]] : acc), []),
);
if (!args.curso || !args.desde || !args.hasta) {
  console.error("Uso: --curso <uuid> --desde YYYY-MM-DD --hasta YYYY-MM-DD [--corte-anterior <cut_uuid>]");
  process.exit(1);
}

const URL_BASE = (leerSecreto("VITE_SUPABASE_URL") ?? leerSecreto("SUPABASE_URL")).replace(/\/$/, "");
const KEY = leerSecreto("SUPABASE_SERVICE_ROLE_KEY");
if (!KEY) {
  console.error("Falta SUPABASE_SERVICE_ROLE_KEY en .env.local");
  process.exit(3);
}

async function q(ruta) {
  const res = await fetch(`${URL_BASE}/rest/v1/${ruta}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${ruta} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
const inList = (ids) => `(${ids.join(",")})`;
const TOPE_TEXTO = 12000;
const recortar = (t, n = TOPE_TEXTO) => (t && t.length > n ? `${t.slice(0, n)}\n…[recortado ${t.length - n} caracteres]` : t ?? "");

/** El texto que se escribió dentro de un dibujo de Excalidraw (cajas, notas, etiquetas). */
function textoDeEscena(scene) {
  let s = scene;
  if (typeof s === "string") {
    try {
      s = JSON.parse(s);
    } catch {
      return "";
    }
  }
  const els = s?.elements ?? [];
  const textos = els.filter((e) => e && !e.isDeleted && e.type === "text" && e.text?.trim()).map((e) => e.text.trim());
  const imagenes = els.filter((e) => e && !e.isDeleted && e.type === "image").length;
  const trazos = els.filter((e) => e && !e.isDeleted && e.type === "freedraw").length;
  const extra = [imagenes && `${imagenes} imagen(es) pegada(s)`, trazos && `${trazos} trazo(s) a mano`].filter(Boolean);
  return [textos.join(" · "), extra.length ? `[además: ${extra.join(", ")} — no legibles como texto]` : ""]
    .filter(Boolean)
    .join("\n");
}

const curso = (await q(`courses?select=id,name,code,tenant_id,period_id,subject_id&id=eq.${args.curso}`))[0];
if (!curso) throw new Error("Curso no encontrado");
const cortes = await q(`grade_cuts?select=id,name,start_date,end_date,weight&course_id=eq.${curso.id}&order=start_date`);

const sesiones = await q(
  `attendance_sessions?select=id,session_date,start_time,title,session_type,content_id,content_class_index,content_file_paths,whiteboard_scene,recording_url&course_id=eq.${curso.id}&deleted_at=is.null&session_date=gte.${args.desde}&session_date=lte.${args.hasta}&order=session_date`,
);
const ids = sesiones.map((s) => s.id);
const out = [];
const p = (...l) => out.push(...l);

p(`# Dossier — ${curso.name}`, "", `Ventana: ${args.desde} a ${args.hasta} · ${sesiones.length} sesiones`, "");
p("## Cortes del curso", ...cortes.map((c) => `- ${c.name}: ${c.start_date} a ${c.end_date} (${c.weight} %) — id ${c.id}`), "");

const [transcripciones, snippets, pizarrasSesion] = ids.length
  ? await Promise.all([
      q(`session_transcripts?select=session_id,teacher_text,teacher_speakers&session_id=in.${inList(ids)}`),
      q(`session_code_snippets?select=session_id,title,language,source_code,position&session_id=in.${inList(ids)}&order=position`),
      q(`whiteboards?select=id,name,attendance_session_id&attendance_session_id=in.${inList(ids)}&deleted_at=is.null`),
    ])
  : [[], [], []];

// Pizarras del curso tocadas en la ventana (las standalone no siempre van amarradas a una sesión).
const pizarrasCurso = await q(
  `whiteboards?select=id,name,attendance_session_id,updated_at,created_at&course_id=eq.${curso.id}&deleted_at=is.null&updated_at=gte.${args.desde}`,
);
const pizarras = [...new Map([...pizarrasSesion, ...pizarrasCurso].map((w) => [w.id, w])).values()];
const paginas = pizarras.length
  ? await q(
      `whiteboard_pages?select=whiteboard_id,position,name,page_type,text_content,code_language,code_source,last_stdout,sql_setup,sql_answer,diagram_source,console_transcript,scene_json&whiteboard_id=in.${inList(pizarras.map((w) => w.id))}&order=position`,
    )
  : [];

// Material: el del tablero por sesión + el asignado al curso.
const asignados = await q(`content_course_assignments?select=content_id&course_id=eq.${curso.id}`);
const delCurso = await q(`generated_contents?select=id&course_id=eq.${curso.id}&deleted_at=is.null`);
const contentIds = [
  ...new Set([
    ...sesiones.map((s) => s.content_id),
    ...asignados.map((a) => a.content_id),
    ...delCurso.map((c) => c.id),
  ].filter(Boolean)),
];
const material = contentIds.length
  ? await q(`generated_contents?select=id,display_name,topic,files&id=in.${inList(contentIds)}&deleted_at=is.null`)
  : [];
const materialPorId = new Map(material.map((m) => [m.id, m]));

for (const s of sesiones) {
  p(`## Sesión ${s.session_date} ${s.start_time ?? ""} — ${s.title ?? "(sin título)"} [${s.session_type ?? "?"}]`, "");
  const tr = transcripciones.filter((t) => t.session_id === s.id && t.teacher_text?.trim());
  p(`### Lo que dijo el docente (transcripción)`, tr.length ? recortar(tr.map((t) => t.teacher_text).join("\n\n")) : "_Sin transcripción._", "");

  const m = s.content_id && materialPorId.get(s.content_id);
  if (m) {
    const archivos = (m.files ?? []).filter(
      (f) => !s.content_file_paths?.length || s.content_file_paths.includes(f.path),
    );
    p(`### Material: ${m.display_name ?? m.topic} (clase ${s.content_class_index ?? "—"})`);
    for (const f of archivos) {
      p(`- **${f.name ?? f.path}**${f.body ? "" : " — sin texto en línea (Office/PDF/imagen: abrirlo si hace falta)"}`);
      if (f.body) p("```", recortar(String(f.body), 6000), "```");
    }
    p("");
  }

  const sn = snippets.filter((x) => x.session_id === s.id);
  if (sn.length) {
    p("### Código mostrado en clase");
    for (const x of sn) p(`- ${x.title ?? "snippet"} (${x.language})`, "```" + (x.language ?? ""), recortar(x.source_code, 4000), "```");
    p("");
  }
  const esc = textoDeEscena(s.whiteboard_scene);
  if (esc) p("### Pizarra de la sesión (texto escrito)", esc, "");
}

// Material del curso que no quedó amarrado a una sesión: entra si su nombre
// nombra una clase de la ventana («Clase 7», «Sesión 8»); el resto se lista.
const clasesVentana = new Set(
  sesiones.flatMap((s) => [...String(s.title ?? "").matchAll(/(?:clases?|sesi[oó]n)\s*(\d+)(?:\s*(?:y|a|-)\s*(\d+))?/gi)].flatMap((m) => [m[1], m[2]]).filter(Boolean)),
);
const yaUsados = new Set(sesiones.map((s) => s.content_id));
const sueltos = material.filter((m) => !yaUsados.has(m.id));
if (sueltos.length) {
  p("## Material del curso (no amarrado a una sesión)", "");
  for (const m of sueltos) {
    p(`### ${m.display_name ?? m.topic}`);
    for (const f of m.files ?? []) {
      const n = String(f.name ?? f.path).match(/(?:clase|sesi[oó]n)[\s_-]*0*(\d+)/i)?.[1];
      const entra = n && clasesVentana.has(n);
      p(`- **${f.name ?? f.path}**${entra ? "" : " — fuera de la ventana o sin número de clase"}${f.body ? "" : " — sin texto en línea"}`);
      if (entra && f.body) p("```", recortar(String(f.body), 6000), "```");
    }
    p("");
  }
}

if (pizarras.length) {
  p("## Pizarras del curso", "");
  for (const w of pizarras) {
    p(`### ${w.name}${w.attendance_session_id ? " (amarrada a una sesión)" : ""}`);
    for (const pg of paginas.filter((x) => x.whiteboard_id === w.id)) {
      p(`#### Hoja ${pg.position + 1}: ${pg.name ?? ""} [${pg.page_type}]`);
      if (pg.page_type === "drawing") p(textoDeEscena(pg.scene_json) || "_Sin texto escrito._");
      if (pg.text_content) p(recortar(pg.text_content, 6000));
      if (pg.code_source) p("```" + (pg.code_language ?? ""), recortar(pg.code_source, 4000), "```");
      if (pg.last_stdout) p("Salida:", "```", recortar(pg.last_stdout, 1500), "```");
      if (pg.sql_setup || pg.sql_answer) {
        // sql_answer se guarda como el JSON de una respuesta bd_sql ({bdSql, sql, …}).
        let sql = pg.sql_answer ?? "";
        try {
          sql = JSON.parse(sql).sql ?? sql;
        } catch {
          /* texto plano */
        }
        p("```sql", recortar(`${pg.sql_setup ?? ""}\n${sql}`, 6000), "```");
      }
      if (pg.diagram_source) p("```mermaid", recortar(pg.diagram_source, 3000), "```");
      if (pg.console_transcript) p("Consola:", "```", recortar(String(pg.console_transcript), 2000), "```");
      p("");
    }
  }
}

// Corte anterior: qué se evaluó y cómo le fue al curso pregunta por pregunta.
if (args["corte-anterior"]) {
  const cut = args["corte-anterior"];
  p("## Evaluación del corte anterior", "");
  const examenes = await q(
    `exams?select=id,title,status,weight,is_external,parent_exam_id&course_id=eq.${curso.id}&cut_id=eq.${cut}&deleted_at=is.null`,
  );
  for (const e of examenes) {
    p(`### Examen: ${e.title} (${e.weight ?? 0} %, ${e.status}${e.parent_exam_id ? ", recuperación" : ""})`);
    const preguntas = await q(`questions?select=id,type,content,points,position&exam_id=eq.${e.id}&order=position`);
    const subs = await q(`submissions?select=answers&exam_id=eq.${e.id}&status=in.(completado,sospechoso)`);
    const acum = new Map();
    for (const s of subs)
      for (const b of s.answers?.__breakdown ?? []) {
        const a = acum.get(b.qid) ?? { earned: 0, points: 0, n: 0 };
        a.earned += Number(b.earned) || 0;
        a.points += Number(b.points) || 0;
        a.n += 1;
        acum.set(b.qid, a);
      }
    p(`${subs.length} intentos finalizados.`);
    for (const qq of preguntas) {
      const a = acum.get(qq.id);
      const rend = a && a.points ? `${Math.round((a.earned / a.points) * 100)} % de acierto (${a.n})` : "sin datos";
      p(`- [${qq.type}] ${String(qq.content).replace(/\s+/g, " ").slice(0, 220)} — **${rend}**`);
    }
    p("");
  }
  const wc = await q(`workshop_courses?select=workshop_id,weight&course_id=eq.${curso.id}&cut_id=eq.${cut}`);
  const anclas = await q(`workshops?select=id&course_id=eq.${curso.id}&cut_id=eq.${cut}&deleted_at=is.null`);
  const tids = [...new Set([...wc.map((x) => x.workshop_id), ...anclas.map((x) => x.id)])];
  if (tids.length) {
    const talleres = await q(`workshops?select=id,title,status,weight,is_external&id=in.${inList(tids)}&deleted_at=is.null`);
    for (const t of talleres) {
      const peso = wc.find((x) => x.workshop_id === t.id)?.weight ?? t.weight ?? 0;
      p(`### Taller: ${t.title} (${peso} %, ${t.status}${t.is_external ? ", externo" : ""})`);
      const preguntas = await q(`workshop_questions?select=type,content&workshop_id=eq.${t.id}&order=position`);
      for (const qq of preguntas) p(`- [${qq.type}] ${String(qq.content).replace(/\s+/g, " ").slice(0, 220)}`);
      p("");
    }
  }
}

const dir = "privado/evaluaciones";
mkdirSync(dir, { recursive: true });
const archivo = `${dir}/dossier-${(curso.code ?? curso.id).replace(/[^\w-]+/g, "_")}-${args.desde}_${args.hasta}.md`;
writeFileSync(archivo, out.join("\n"), "utf8");
console.log(`${archivo} · ${sesiones.length} sesiones · ${transcripciones.length} transcripciones · ${pizarras.length} pizarras · ${material.length} materiales`);
