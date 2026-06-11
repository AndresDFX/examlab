import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync("c:/Projects/Personal/examlab/.env", "utf8").split("\n")) { const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const URL = env.VITE_SUPABASE_URL, ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const INFO = JSON.parse(readFileSync("C:/Temp/examlab-rec/tenant-info.json", "utf8"));
const TID = INFO.tenantId;
const token = (await (await fetch(`${URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email: INFO.adminCreds.email, password: INFO.adminCreds.password }) })).json()).access_token;
const h = { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation,resolution=ignore-duplicates" };

const me = (await (await fetch(`${URL}/rest/v1/profiles?institutional_email=eq.${encodeURIComponent(INFO.adminCreds.email)}&select=id`, { headers: h })).json())?.[0];
const courses = await (await fetch(`${URL}/rest/v1/courses?tenant_id=eq.${TID}&select=id,name`, { headers: h })).json();
if (!me || !Array.isArray(courses) || !courses.length) { console.log("Sin user/cursos:", { me: !!me, courses: courses?.length }); process.exit(0); }

const rows = courses.map((c) => ({ course_id: c.id, user_id: me.id }));
const r = await fetch(`${URL}/rest/v1/course_teachers`, { method: "POST", headers: h, body: JSON.stringify(rows) });
const j = await r.json().catch(() => null);
console.log(r.ok ? `✓ docente asignado a ${courses.length} cursos` : `⚠ ${r.status} ${JSON.stringify(j)}`);
