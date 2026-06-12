import { readFileSync } from "node:fs";
const env = {};
for (const l of readFileSync("c:/Projects/Personal/examlab/.env", "utf8").split("\n")) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const URL = env.VITE_SUPABASE_URL, ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const INFO = JSON.parse(readFileSync("C:/Temp/examlab-rec/tenant-info.json", "utf8"));
const TID = INFO.tenantId;
const tok = (await (await fetch(`${URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email: INFO.adminCreds.email, password: INFO.adminCreds.password }) })).json()).access_token;
const h = { apikey: ANON, Authorization: `Bearer ${tok}`, "Content-Type": "application/json", Prefer: "return=representation" };
const hi = { ...h, Prefer: "return=representation,resolution=ignore-duplicates" };

const meRes = await (await fetch(`${URL}/rest/v1/profiles?institutional_email=eq.${encodeURIComponent(INFO.adminCreds.email)}&select=id`, { headers: h })).json();
const uid = meRes[0].id;
const courses = await (await fetch(`${URL}/rest/v1/courses?tenant_id=eq.${TID}&select=id,name&order=created_at.asc`, { headers: h })).json();
const cid = courses[0].id;
console.log("user_id", uid, "| curso destino", courses[0].name);

async function req(method, path, body, ig = false) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { method, headers: ig ? hi : h, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, j };
}

// 1) Matricular al estudiante en los 3 cursos
const enrRows = courses.map((c) => ({ course_id: c.id, user_id: uid }));
const e1 = await req("POST", "course_enrollments", enrRows, true);
console.log(e1.ok ? `✓ matriculado en ${courses.length} cursos` : `⚠ enroll ${e1.status} ${JSON.stringify(e1.j)?.slice(0,160)}`);

// 2) Publicar talleres y proyectos del curso
for (const tbl of ["workshops", "projects"]) {
  const u = await req("PATCH", `${tbl}?course_id=eq.${cid}&select=id`, { status: "published" });
  console.log(u.ok ? `✓ ${tbl} publicados: ${u.j?.length ?? 0}` : `⚠ ${tbl} ${u.status} ${JSON.stringify(u.j)?.slice(0,160)}`);
}

// 3) Exámenes: publicar + ventana. "Quiz" → activo ahora; "Parcial" → próximo.
const exams = await (await fetch(`${URL}/rest/v1/exams?course_id=eq.${cid}&select=id,title`, { headers: h })).json();
for (const ex of exams) {
  const active = /quiz/i.test(ex.title);
  const patch = active
    ? { status: "published", start_time: "2026-06-09T13:00:00.000Z", end_time: "2026-06-30T23:59:00.000Z" }
    : { status: "published" };
  await req("PATCH", `exams?id=eq.${ex.id}`, patch);
  // Asignar el examen al estudiante (idempotente)
  const a = await req("POST", "exam_assignments", [{ exam_id: ex.id, user_id: uid }], true);
  console.log(`  ${active ? "▶ activo" : "· próximo"}  "${ex.title}"  asignación ${a.ok ? "ok" : a.status}`);
}

console.log("Listo.");
