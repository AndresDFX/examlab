import { readFileSync } from "node:fs";
const env = {};
for (const l of readFileSync("c:/Projects/Personal/examlab/.env", "utf8").split("\n")) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const URL = env.VITE_SUPABASE_URL, ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const INFO = JSON.parse(readFileSync("C:/Temp/examlab-rec/tenant-info.json", "utf8"));
const tok = (await (await fetch(`${URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email: INFO.adminCreds.email, password: INFO.adminCreds.password }) })).json()).access_token;
const h = { apikey: ANON, Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
const meRes = await (await fetch(`${URL}/rest/v1/profiles?institutional_email=eq.${encodeURIComponent(INFO.adminCreds.email)}&select=id`, { headers: h })).json();
const uid = meRes[0].id;
const courses = await (await fetch(`${URL}/rest/v1/courses?tenant_id=eq.${INFO.tenantId}&select=id,name&order=created_at.asc`, { headers: h })).json();

for (const c of courses) {
  const r = await fetch(`${URL}/rest/v1/rpc/issue_certificate`, { method: "POST", headers: h, body: JSON.stringify({ _user_id: uid, _course_id: c.id, _final_grade: 4.6 }) });
  const j = await r.json().catch(() => null);
  console.log(r.ok ? `✓ cert "${c.name}" → id ${JSON.stringify(j)}` : `⚠ "${c.name}" ${r.status}: ${JSON.stringify(j)?.slice(0, 200)}`);
}
console.log("--- certs en DB (short_code) ---");
const certs = await (await fetch(`${URL}/rest/v1/certificates?select=id,short_code,recipient_name,course_name,final_grade,issued_at&order=issued_at.desc`, { headers: h })).json();
console.log(JSON.stringify(certs, null, 1));
