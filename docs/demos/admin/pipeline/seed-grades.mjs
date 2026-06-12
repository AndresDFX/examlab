import { readFileSync } from "node:fs";
const env = {};
for (const l of readFileSync("c:/Projects/Personal/examlab/.env", "utf8").split("\n")) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const URL = env.VITE_SUPABASE_URL, ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const INFO = JSON.parse(readFileSync("C:/Temp/examlab-rec/tenant-info.json", "utf8"));
const tok = (await (await fetch(`${URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email: INFO.adminCreds.email, password: INFO.adminCreds.password }) })).json()).access_token;
const h = { apikey: ANON, Authorization: `Bearer ${tok}`, "Content-Type": "application/json", Prefer: "return=representation" };
const meRes = await (await fetch(`${URL}/rest/v1/profiles?institutional_email=eq.${encodeURIComponent(INFO.adminCreds.email)}&select=id`, { headers: h })).json();
const uid = meRes[0].id;
// Curso default de "Mis Notas": order period desc, name asc → "Arquitectura de Software"
const courses = await (await fetch(`${URL}/rest/v1/courses?tenant_id=eq.${INFO.tenantId}&select=id,name,grade_scale_max&order=name.asc`, { headers: h })).json();
const course = courses[0];
console.log("Curso:", course.name, "(escala 0-" + course.grade_scale_max + ")");

async function post(table, row) {
  const r = await fetch(`${URL}/rest/v1/${table}`, { method: "POST", headers: h, body: JSON.stringify(row) });
  const j = await r.json().catch(() => null);
  if (!r.ok) { console.log(`⚠ ${table} ${r.status}: ${JSON.stringify(j)?.slice(0, 260)}`); return null; }
  return Array.isArray(j) ? j[0] : j;
}

// 1) Corte (todo el peso a talleres para simplificar)
const cut = await post("grade_cuts", {
  course_id: course.id, name: "Corte 1", position: 0,
  weight: 100, exam_weight: 0, workshop_weight: 100, project_weight: 0, attendance_weight: 0,
  start_date: "2026-02-01", end_date: "2026-06-30",
});
if (!cut) process.exit(1);
console.log("✓ corte:", cut.id);

// 2) Taller externo asignado al corte
const ws = await post("workshops", {
  course_id: course.id, title: "Taller en clase — Patrones de diseño", description: "Actividad práctica presencial.",
  is_external: true, cut_id: cut.id, weight: 100, max_score: course.grade_scale_max ?? 5,
  status: "published", created_by: uid,
});
if (!ws) process.exit(1);
console.log("✓ taller externo:", ws.id);

// 3) Entrega calificada del estudiante (nota en la escala del curso)
const sub = await post("workshop_submissions", {
  workshop_id: ws.id, user_id: uid, final_grade: 4.3, status: "calificado",
  teacher_feedback: "Buen dominio de los patrones; mejora la documentación.",
});
console.log(sub ? "✓ entrega calificada (4,3)" : "(entrega falló)");
console.log("Listo.");
