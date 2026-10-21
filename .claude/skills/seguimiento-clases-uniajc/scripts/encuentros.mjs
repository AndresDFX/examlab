#!/usr/bin/env node
/**
 * Arma la tabla de encuentros dictados en el periodo a partir de ExamLab, para el formulario
 * «Seguimientos a programas» de la UNIAJC (una respuesta por encuentro). Solo LEE la base.
 *
 *   node .claude/skills/seguimiento-clases-uniajc/scripts/encuentros.mjs
 *
 * Escribe en la carpeta privada del periodo (lleva nombres de estudiantes: nunca al repo):
 *   encuentros.json  — lo que lee el script de envío
 *   encuentros.md    — la tabla para que el docente la revise
 * y aplica encima `ajustes.json` (decisiones del docente por encuentro, clave "<curso>|<fecha>").
 *
 * Qué queda «listo» y qué queda «revisar» es la parte que importa: el título de una sesión es lo
 * PLANEADO, no lo que pasó. En 2026-2 había sesiones llamadas «Parcial 1» en las que no se
 * presentó ningún examen (el parcial se movió a otra fecha) y sesiones sin una sola marca de
 * asistencia. Esas no se mandan sin que el docente diga qué pasó.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const CFG = JSON.parse(readFileSync(path.join(DIR, "..", "cursos.json"), "utf8"));
const env = readFileSync(".env.local", "utf8") + "\n" + readFileSync(".env", "utf8");
const KEY = env.match(/^SUPABASE_SERVICE_ROLE_KEY\s*=\s*"?([^"\r\n]+)"?/m)[1];
const URL_ = env.match(/^VITE_SUPABASE_URL\s*=\s*"?([^"\r\n]+)"?/m)[1];
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function get(p) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${URL_}/rest/v1/${p}`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

const PRESENTE = new Set(["presente", "tarde", "present", "late"]);
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const bogota = (iso) => new Date(new Date(iso).getTime() - 5 * 3600e3).toISOString();
const ahora = bogota(new Date().toISOString());
const hoy = ahora.slice(0, 10);
const ddmmaaaa = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

function limpiarTema(t) {
  return String(t)
    .replace(/^Sesi[oó]n\s*\d+\s*[—–-]\s*/i, "")
    .replace(/Sesi[oó]n doble\s*·\s*/i, "")
    .replace(/\s*\((solo evaluaci[oó]n|\+ diagn[oó]stico|Clases? [^)]*)\)/gi, "")
    .replace(/\s*·\s*clase aut[oó]noma.*$/i, "")
    .replace(/\s+\+\s+/g, " y ")
    .replace(/\s*·\s*/g, " y ")
    .trim();
}

function listadoOficial(ruta) {
  const txt = readFileSync(ruta, "utf8").replace(/^﻿/, "");
  const [cab, ...filas] = txt.split(/\r?\n/).filter(Boolean);
  const cols = cab.split(";");
  return filas.map((f) => Object.fromEntries(f.split(";").map((v, i) => [cols[i], v])));
}

const carpeta = CFG.carpetaPrivada;
mkdirSync(carpeta, { recursive: true });
const ledgerPath = path.join(carpeta, "enviados.jsonl");
const enviados = new Set(existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l).clave) : []);
const ajustesPath = path.join(carpeta, "ajustes.json");
const ajustes = existsSync(ajustesPath) ? JSON.parse(readFileSync(ajustesPath, "utf8")) : {};

const filas = [];
for (const c of CFG.cursos) {
  // El CSV del corte sale del libro de ExamLab: quien figuraba ahí y NO en el listado de la
  // universidad quedó anotado en observaciones.json («No figura en el listado oficial»).
  const obsPath = path.join(path.dirname(c.listado), "observaciones.json");
  const obs = existsSync(obsPath) ? JSON.parse(readFileSync(obsPath, "utf8")) : {};
  // La observación es un texto o un objeto { texto, registrada }; «registrada: —» = no está en el portal.
  const fuera = new Set(Object.entries(obs).filter(([k, v]) => k.startsWith(`${c.nombre}|`) &&
    (/no figura en el listado oficial/i.test(typeof v === "string" ? v : v?.texto ?? "") || v?.registrada === "—")).map(([k]) => k.split("|")[1]));
  const oficial = listadoOficial(c.listado).filter((r) => !fuera.has(r.Documento));
  const docs = new Set(oficial.map((r) => r.Documento));
  const nombres = new Set(oficial.map((r) => norm(r.Estudiante)));

  const enr = await get(`course_enrollments?select=user_id,vocero_marcado_at,vocero_telefono&course_id=eq.${c.examlab}`);
  const perfiles = await get(`profiles?select=id,full_name,documento,institutional_email&id=in.(${enr.map((e) => e.user_id).join(",")})`);
  const P = Object.fromEntries(perfiles.map((p) => [p.id, p]));
  // Estudiante del curso = está en el listado oficial (por documento o, si no, por nombre).
  const est = perfiles.filter((p) => docs.has(p.documento) || nombres.has(norm(p.full_name)));
  const estIds = new Set(est.map((p) => p.id));
  const voc = enr.find((e) => e.vocero_marcado_at && estIds.has(e.user_id));
  const vocero = voc ? { nombre: P[voc.user_id].full_name, telefono: voc.vocero_telefono ?? "", correo: P[voc.user_id].institutional_email ?? "" } : null;

  // Exámenes presentados por día (lo que de verdad pasó, no lo planeado).
  const exams = await get(`exams?select=id,title,status&course_id=eq.${c.examlab}&deleted_at=is.null&status=neq.draft`);
  const porDia = {};
  for (const e of exams) {
    const subs = await get(`submissions?select=user_id,created_at&exam_id=eq.${e.id}`);
    const cuenta = {};
    for (const s of subs) if (estIds.has(s.user_id)) { const d = bogota(s.created_at).slice(0, 10); (cuenta[d] ??= new Set()).add(s.user_id); }
    for (const [d, us] of Object.entries(cuenta)) (porDia[d] ??= []).push({ titulo: e.title, n: us.size });
  }
  // Un examen «se presentó ese día» si lo hizo al menos un tercio del grupo: los rezagados del
  // día siguiente no convierten ese día en un encuentro.
  const examenesDelDia = (d) => (porDia[d] ?? []).filter((x) => x.n >= Math.max(3, est.length / 3));

  const ses = await get(`attendance_sessions?select=id,session_date,title,session_type,start_time,duration_minutes&course_id=eq.${c.examlab}&deleted_at=is.null&order=session_date`);
  const recs = ses.length ? await get(`attendance_records?select=session_id,user_id,status&session_id=in.(${ses.map((s) => s.id).join(",")})`) : [];
  const fechasConSesion = new Set();

  for (const s of ses) {
    // Un encuentro de hoy cuenta solo cuando ya terminó.
    const [hh, mm] = String(s.start_time ?? "23:59").split(":").map(Number);
    const finMin = hh * 60 + mm + (s.duration_minutes ?? 0);
    const ahoraMin = Number(ahora.slice(11, 13)) * 60 + Number(ahora.slice(14, 16));
    if (s.session_date > hoy || (s.session_date === hoy && ahoraMin < finMin)) continue;
    fechasConSesion.add(s.session_date);
    if (s.session_type === "autonoma") continue; // festivo: no hubo encuentro sincrónico
    const marcas = recs.filter((r) => r.session_id === s.id);
    const pres = new Set(marcas.filter((m) => estIds.has(m.user_id) && PRESENTE.has(String(m.status).toLowerCase())).map((m) => m.user_id));
    const justif = marcas.filter((m) => estIds.has(m.user_id) && /justific/i.test(m.status)).map((m) => P[m.user_id].full_name);
    const ausentes = est.filter((p) => !pres.has(p.id)).map((p) => p.full_name).sort((a, b) => a.localeCompare(b, "es"));
    const num = (s.title.match(/Sesi[oó]n\s*(\d+)/i) ?? [])[1] ?? "";
    const exDia = examenesDelDia(s.session_date);
    const evals = exDia.filter((x) => !/diagn/i.test(x.titulo));
    const diag = exDia.find((x) => /diagn/i.test(x.titulo));
    const tituloEval = /parcial|evaluaci[oó]n de corte/i.test(s.title);
    let tema = limpiarTema(s.title);
    let actividades = c.metodologia;
    if (/sesi[oó]n doble/i.test(s.title)) actividades += " Sesión doble: se desarrollaron dos temas del microcurrículo en el mismo encuentro.";
    if (evals.length) {
      tema = evals.map((x) => x.titulo).join(" y ");
      actividades = evals.map((x) => `${x.titulo}: evaluación virtual sincrónica en ExamLab, presentada por ${x.n} estudiantes.`).join(" ");
    }
    if (diag) actividades += ` Prueba diagnóstica en ExamLab (${diag.n} estudiantes).`;
    if (num === "1") actividades = "Presentación del curso y socialización del acuerdo pedagógico. " + actividades;

    const motivos = [];
    if (!marcas.length) motivos.push("no hay asistencia registrada en ExamLab");
    if (tituloEval && !evals.length) motivos.push(`la sesión se llama «${limpiarTema(s.title)}» pero ese día no se presentó ningún examen`);
    if (!marcas.length && evals.length) motivos.push(`ese día se presentó «${evals[0].titulo}» (${evals[0].n} estudiantes)`);
    if (marcas.length && evals.some((x) => x.n > pres.size)) motivos.push(`${Math.max(...evals.map((x) => x.n))} presentaron «${evals[0].titulo}» ese día y solo ${pres.size} tienen asistencia marcada`);

    const clave = `${c.nombre}|${s.session_date}`;
    filas.push({
      clave, curso: c.nombre, grupo: c.grupo, asignatura: c.asignaturaFormulario, sede: c.sede, franja: c.franja, plataforma: c.plataforma,
      fecha: s.session_date, fechaFormulario: ddmmaaaa(s.session_date), tipo: "Encuentro en la fecha estipulada",
      encuentro: `Encuentro #${num}: ${tema}`, actividades,
      matriculados: est.length, asistentes: marcas.length ? pres.size : null,
      ausentes: marcas.length ? (ausentes.length ? ausentes.join(", ") : "NA") : null,
      observaciones: "Asistencia tomada en ExamLab." + (justif.length ? ` Inasistencia justificada: ${justif.join(", ")}.` : ""),
      vocero, estado: motivos.length ? "revisar" : "listo", motivo: motivos.join("; "),
    });
  }

  // Exámenes presentados un día sin sesión registrada: un encuentro que ExamLab no tiene.
  for (const [d, xs] of Object.entries(porDia)) {
    if (d >= hoy || fechasConSesion.has(d)) continue;
    // Un quiz en línea no es un encuentro; un parcial movido de fecha sí puede serlo.
    for (const x of xs.filter((x) => x.n >= Math.max(3, est.length / 3) && /^(parcial|evaluaci[oó]n de corte)/i.test(x.titulo))) {
      filas.push({
        clave: `${c.nombre}|${d}`, curso: c.nombre, grupo: c.grupo, asignatura: c.asignaturaFormulario, sede: c.sede, franja: c.franja, plataforma: c.plataforma,
        fecha: d, fechaFormulario: ddmmaaaa(d), tipo: "Encuentro de recuperación",
        encuentro: `Encuentro #?: ${x.titulo}`, actividades: `${x.titulo}: evaluación virtual sincrónica en ExamLab, presentada por ${x.n} estudiantes.`,
        matriculados: est.length, asistentes: null, ausentes: null, observaciones: "", vocero,
        estado: "revisar", motivo: `ese día se presentó «${x.titulo}» (${x.n} estudiantes) y no hay sesión registrada en ExamLab`,
      });
    }
  }
}

// Decisiones del docente encima de lo calculado; lo ya enviado nunca se vuelve a mandar.
for (const f of filas) {
  Object.assign(f, ajustes[f.clave] ?? {});
  if (enviados.has(f.clave)) f.estado = "enviado";
}
filas.sort((a, b) => a.curso.localeCompare(b.curso) || a.fecha.localeCompare(b.fecha));
writeFileSync(path.join(carpeta, "encuentros.json"), JSON.stringify(filas, null, 1));

const md = ["# Encuentros para el formulario «Seguimientos a programas»", "",
  `Generado: ${ahora.slice(0, 16).replace("T", " ")} (hora de Bogotá). Editar decisiones en \`ajustes.json\` y volver a generar.`, "",
  "| Estado | Curso | Fecha | Encuentro | Asistentes | Ausentes | Motivo |", "|---|---|---|---|---|---|---|",
  ...filas.map((f) => `| ${f.estado} | ${f.curso} | ${f.fechaFormulario} | ${f.encuentro.replace(/\|/g, "/")} | ${f.asistentes ?? "—"}/${f.matriculados} | ${f.ausentes === "NA" ? 0 : f.ausentes ? f.ausentes.split(", ").length : "—"} | ${f.motivo} |`)];
writeFileSync(path.join(carpeta, "encuentros.md"), md.join("\n") + "\n");
const cuenta = (e) => filas.filter((f) => f.estado === e).length;
console.log(`encuentros: ${filas.length} · listos ${cuenta("listo")} · por revisar ${cuenta("revisar")} · ya enviados ${cuenta("enviado")}`);
