import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync("c:/Projects/Personal/examlab/.env", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/); if (m) env[m[1]] = m[2];
}
const URL = env.VITE_SUPABASE_URL, ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const INFO = JSON.parse(readFileSync("C:/Temp/examlab-rec/tenant-info.json", "utf8"));
const TID = INFO.tenantId;
const token = (await (await fetch(`${URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email: INFO.adminCreds.email, password: INFO.adminCreds.password }) })).json()).access_token;
const h = { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation" };

const exist = await (await fetch(`${URL}/rest/v1/certificates?select=id&limit=1`, { headers: h })).json();
if (Array.isArray(exist) && exist.length > 0) { console.log("Ya hay certificados — no siembro."); process.exit(0); }

const course = (await (await fetch(`${URL}/rest/v1/courses?tenant_id=eq.${TID}&select=id,name,period&limit=1`, { headers: h })).json())?.[0];
const studs = await (await fetch(`${URL}/rest/v1/profiles?tenant_id=eq.${TID}&select=id,full_name,institutional_email&limit=4`, { headers: h })).json();
const picks = (studs || []).filter((s) => /@demoglobalcorp\.test$/.test(s.institutional_email || "")).slice(0, 2);
if (!course || picks.length === 0) { console.log("Sin curso/estudiantes para sembrar:", { course: !!course, studs: studs?.length }); process.exit(0); }

const rows = picks.map((s, i) => ({
  course_id: course.id, course_name: course.name, course_period: course.period ?? "2026-I",
  user_id: s.id, student_full_name: s.full_name,
  final_grade: 4.5 - i * 0.3, grade_scale_max: 5, passing_grade: 3,
  short_code: `DEMO-${String(1001 + i)}`, payload_hash: `demo-hash-${i + 1}`,
  university_name: INFO.tenant.name, signature_name: "Dirección Académica", signature_title: "Director",
  teacher_names: ["Laura Gómez"],
}));
const r = await fetch(`${URL}/rest/v1/certificates`, { method: "POST", headers: h, body: JSON.stringify(rows) });
const j = await r.json();
console.log(r.ok ? `✓ ${j.length} certificados (${picks.map((p) => p.full_name).join(", ")})` : `⚠ ${r.status} ${JSON.stringify(j)}`);
