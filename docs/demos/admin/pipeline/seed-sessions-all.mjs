import { readFileSync } from "node:fs";
const env = {};
for (const l of readFileSync("c:/Projects/Personal/examlab/.env", "utf8").split("\n")) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const URL = env.VITE_SUPABASE_URL, ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const INFO = JSON.parse(readFileSync("C:/Temp/examlab-rec/tenant-info.json", "utf8"));
const tok = (await (await fetch(`${URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email: INFO.adminCreds.email, password: INFO.adminCreds.password }) })).json()).access_token;
const h = { apikey: ANON, Authorization: `Bearer ${tok}`, "Content-Type": "application/json", Prefer: "return=representation" };
const meRes = await (await fetch(`${URL}/rest/v1/profiles?institutional_email=eq.${encodeURIComponent(INFO.adminCreds.email)}&select=id`, { headers: h })).json();
const me = meRes[0];
const courses = await (await fetch(`${URL}/rest/v1/courses?tenant_id=eq.${INFO.tenantId}&select=id,name`, { headers: h })).json();
for (const c of courses) {
  const have = await (await fetch(`${URL}/rest/v1/attendance_sessions?course_id=eq.${c.id}&select=id`, { headers: h })).json();
  if (Array.isArray(have) && have.length >= 2) { console.log(`· ${c.name}: ya tiene ${have.length} sesiones`); continue; }
  const rows = [
    { course_id: c.id, session_date: "2026-06-12", start_time: "08:00:00", duration_minutes: 120, title: "Clase 1 — Introducción", created_by: me.id },
    { course_id: c.id, session_date: "2026-06-13", start_time: "08:00:00", duration_minutes: 120, title: "Clase 2 — Conceptos básicos", created_by: me.id },
  ];
  const r = await fetch(`${URL}/rest/v1/attendance_sessions`, { method: "POST", headers: h, body: JSON.stringify(rows) });
  console.log(r.ok ? `✓ ${c.name}: +2 sesiones` : `⚠ ${c.name}: ${r.status}`);
}
console.log("Listo.");
