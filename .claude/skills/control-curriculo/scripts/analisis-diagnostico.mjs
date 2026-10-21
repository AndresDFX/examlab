// Solo lectura. Correr desde la raíz del repo (lee la service_role de .env.local).
import { readFileSync, writeFileSync } from "node:fs";

const env = readFileSync(".env.local", "utf8") + "\n" + readFileSync(".env", "utf8");
const key = env.match(/^SUPABASE_SERVICE_ROLE_KEY\s*=\s*"?([^"\r\n]+)"?/m)[1];
const url = env.match(/^VITE_SUPABASE_URL\s*=\s*"?([^"\r\n]+)"?/m)[1];
const H = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

async function get(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${url}/rest/v1/${path}`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
async function rpc(fn, body) {
  const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function pool(items, n, f) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; res[k] = await f(items[k], k); }
  }));
  return res;
}

const CURSOS = {
  "b5499e08-0d90-4d4e-a8cb-944d2ba05013": "Arquitectura 6303C",
  "f23b6519-c8a9-4766-80f6-f56605310512": "Bases de Datos II 641A-2",
  "98d592d6-6209-5033-aacb-c9de0d01373b": "Introduccion LB141F",
  "f75be96a-65d5-56f9-aa41-63a3e2189a3c": "Introduccion SB141B",
  "c3952827-9737-500b-8326-374a37f1981b": "Introduccion SB141C",
  "44fc55a6-b610-4c5f-befa-f58bc307068f": "Programacion II 341C",
  "f23b2c3f-4559-435f-a9ae-155a46d899f1": "Seminario de Sistemas 341C",
};
const HOY = new Date().toISOString().slice(0, 10);
const resultado = {};

for (const [cid, nombre] of Object.entries(CURSOS)) {
  const enr = await get(`course_enrollments?select=user_id,created_at&course_id=eq.${cid}`);
  const ids = enr.map((e) => e.user_id);
  const roles = await get(`user_roles?select=user_id,role&user_id=in.(${ids.join(",")})`);
  const staff = new Set(roles.filter((r) => r.role !== "Estudiante").map((r) => r.user_id));
  const perfiles = await get(`profiles?select=id,full_name,documento,institutional_email,is_active,deleted_at,estado&id=in.(${ids.join(",")})`);
  const P = Object.fromEntries(perfiles.map((p) => [p.id, p]));
  const estudiantes = ids.filter((u) => !staff.has(u));

  const exams = await get(`exams?select=id,title,status,is_external,parent_exam_id,makeup_kind,recovery_rule,cut_id,created_at,deleted_at&course_id=eq.${cid}&deleted_at=is.null`);
  const diag = exams.find((e) => /diagn/i.test(e.title) && !e.parent_exam_id);
  const p1 = exams.find((e) => /^(Parcial 1|Evaluaci[oó]n de Corte 1)$/i.test(e.title.trim()));
  const recs = exams.filter((e) => e.parent_exam_id === p1?.id && e.status !== "draft").sort((a, b) => a.created_at.localeCompare(b.created_at));

  // Diagnóstica: nota de cada estudiante + desempeño por pregunta.
  const diagNotas = await pool(estudiantes, 8, async (u) => (await rpc("exam_attempts_raw_grade", { p_exam_id: diag.id, p_user_id: u }))[0]);
  const qs = await get(`questions?select=id,type,content,points,position&exam_id=eq.${diag.id}&order=position`);
  const subs = await get(`submissions?select=user_id,status,answers,created_at&exam_id=eq.${diag.id}&status=in.(completado,sospechoso)&order=created_at.desc`);
  const ultima = {};
  for (const s of subs) if (estudiantes.includes(s.user_id) && !ultima[s.user_id]) ultima[s.user_id] = s;
  const porPregunta = qs.map((q) => {
    let earned = 0, points = 0, n = 0;
    for (const s of Object.values(ultima)) {
      const b = (s.answers?.__breakdown ?? []).find((x) => x.qid === q.id);
      if (!b) continue;
      earned += Number(b.earned ?? 0); points += Number(b.points ?? q.points ?? 0); n++;
    }
    return { pos: q.position, tipo: q.type, pregunta: q.content.slice(0, 160), n, logro: points ? +(earned / points).toFixed(2) : null };
  });

  // Parcial 1: original, recuperaciones y nota efectiva.
  const par = await pool(estudiantes, 8, async (u) => {
    const o = (await rpc("exam_attempts_raw_grade", { p_exam_id: p1.id, p_user_id: u }))[0];
    const r = [];
    for (const x of recs) r.push({ tipo: x.makeup_kind, ...(await rpc("exam_attempts_raw_grade", { p_exam_id: x.id, p_user_id: u }))[0] });
    const ef = await rpc("exam_effective_raw_grade", { p_exam_id: p1.id, p_user_id: u });
    return { u, o, r, ef };
  });

  // Asistencia del corte del parcial (regla de la nota: sesión dada = alguna marca y fecha cumplida).
  const ses = await get(`attendance_sessions?select=id,session_date,cut_id&course_id=eq.${cid}&deleted_at=is.null&cut_id=eq.${p1.cut_id}`);
  const recsAsis = ses.length ? await get(`attendance_records?select=session_id,user_id,status&session_id=in.(${ses.map((s) => s.id).join(",")})`) : [];
  const dadas = ses.filter((s) => s.session_date <= HOY && recsAsis.some((r) => r.session_id === s.id)).map((s) => s.id);
  const asist = (u) => {
    const pres = recsAsis.filter((r) => r.user_id === u && dadas.includes(r.session_id) && ["presente", "tarde", "present", "late"].includes(String(r.status).toLowerCase())).length;
    return dadas.length ? +(pres / dadas.length).toFixed(2) : null;
  };

  resultado[nombre] = {
    curso: cid,
    matriculados: estudiantes.length,
    staffExcluidos: ids.length - estudiantes.length,
    diagnostica: { examen: diag.title, id: diag.id, notas: diagNotas.map((g, i) => ({ u: estudiantes[i], ...g })), porPregunta },
    parcial: { examen: p1.title, id: p1.id, recuperaciones: recs.map((r) => `${r.makeup_kind}: ${r.title}`), filas: par },
    sesionesDadasCorte: dadas.length,
    estudiantes: estudiantes.map((u) => ({ u, nombre: P[u]?.full_name, documento: P[u]?.documento, activo: P[u]?.is_active, estado: P[u]?.estado, asistencia: asist(u) })),
  };
  console.log(nombre, "listo");
}
writeFileSync(process.argv[2], JSON.stringify(resultado, null, 1));
