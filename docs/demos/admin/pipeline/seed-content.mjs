import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync("c:/Projects/Personal/examlab/.env", "utf8").split("\n")) { const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const URL = env.VITE_SUPABASE_URL, ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const INFO = JSON.parse(readFileSync("C:/Temp/examlab-rec/tenant-info.json", "utf8"));
const TID = INFO.tenantId;
const token = (await (await fetch(`${URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email: INFO.adminCreds.email, password: INFO.adminCreds.password }) })).json()).access_token;
const h = { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation" };
const hi = { ...h, Prefer: "return=representation,resolution=ignore-duplicates" };

const me = (await (await fetch(`${URL}/rest/v1/profiles?institutional_email=eq.${encodeURIComponent(INFO.adminCreds.email)}&select=id`, { headers: h })).json())?.[0];
const courses = await (await fetch(`${URL}/rest/v1/courses?tenant_id=eq.${TID}&select=id,name&order=created_at.asc`, { headers: h })).json();
if (!me || !courses?.length) { console.log("Sin user/cursos"); process.exit(0); }
const course = courses[0];
const uid = me.id, cid = course.id;
console.log(`Curso destino: ${course.name} (${cid})`);

async function post(table, rows, ignoreDup = false) {
  const r = await fetch(`${URL}/rest/v1/${table}`, { method: "POST", headers: ignoreDup ? hi : h, body: JSON.stringify(rows) });
  const j = await r.json().catch(() => null);
  console.log(r.ok ? `  ✓ ${table}: ${Array.isArray(j) ? j.length : 1}` : `  ⚠ ${table} ${r.status} ${JSON.stringify(j)?.slice(0, 200)}`);
  return r.ok ? j : null;
}

// --- Exámenes ---
const start = "2026-06-20T14:00:00.000Z", end = "2026-06-20T16:00:00.000Z";
await post("exams", [
  { course_id: cid, title: "Parcial 1 — Fundamentos", description: "Evaluación de los conceptos del primer corte.", start_time: start, end_time: end, time_limit_minutes: 90, navigation_type: "libre", created_by: uid },
  { course_id: cid, title: "Quiz — Estructuras de control", description: "Evaluación corta sobre condicionales y ciclos.", start_time: start, end_time: end, time_limit_minutes: 30, navigation_type: "secuencial", created_by: uid },
]);

// --- Talleres ---
await post("workshops", [
  { course_id: cid, title: "Taller 1 — Algoritmos básicos", description: "Resolución de problemas con pseudocódigo.", instructions: "Entregar el algoritmo y su explicación.", max_score: 100, status: "draft", created_by: uid, due_date: end },
]);

// --- Proyectos ---
await post("projects", [
  { course_id: cid, title: "Proyecto Final — Sistema de gestión", description: "Construcción de una aplicación con sustentación.", max_score: 100, status: "draft", created_by: uid },
]);

// --- Sesiones de asistencia ---
await post("attendance_sessions", [
  { course_id: cid, session_date: "2026-06-12", start_time: "08:00:00", duration_minutes: 120, title: "Clase 1 — Introducción", created_by: uid },
  { course_id: cid, session_date: "2026-06-13", start_time: "08:00:00", duration_minutes: 120, title: "Clase 2 — Variables y tipos", created_by: uid },
]);

// --- Pizarra ---
await post("whiteboards", [
  { owner_id: uid, name: "Diagrama de flujo — Login", description: "Esquema del flujo de autenticación.", course_id: cid },
]);

console.log("Listo.");
