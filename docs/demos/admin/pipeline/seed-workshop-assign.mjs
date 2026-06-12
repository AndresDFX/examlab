import { readFileSync } from "node:fs";
const env = {};
for (const l of readFileSync("c:/Projects/Personal/examlab/.env", "utf8").split("\n")) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const URL = env.VITE_SUPABASE_URL, ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const INFO = JSON.parse(readFileSync("C:/Temp/examlab-rec/tenant-info.json", "utf8"));
const tok = (await (await fetch(`${URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email: INFO.adminCreds.email, password: INFO.adminCreds.password }) })).json()).access_token;
const h = { apikey: ANON, Authorization: `Bearer ${tok}`, "Content-Type": "application/json", Prefer: "return=representation" };
const hi = { ...h, Prefer: "return=representation,resolution=ignore-duplicates" };
const meRes = await (await fetch(`${URL}/rest/v1/profiles?institutional_email=eq.${encodeURIComponent(INFO.adminCreds.email)}&select=id`, { headers: h })).json();
const uid = meRes[0].id;
const courses = await (await fetch(`${URL}/rest/v1/courses?tenant_id=eq.${INFO.tenantId}&select=id,name&order=created_at.asc`, { headers: h })).json();
const cid = courses[0].id; // Fundamentos — donde el estudiante está matriculado

// Talleres NO externos del curso (los que aparecen en la vista del estudiante)
const ws = await (await fetch(`${URL}/rest/v1/workshops?course_id=eq.${cid}&is_external=eq.false&select=id,title,status,due_date,start_date&order=created_at.asc`, { headers: h })).json();
console.log("talleres no-externos en curso:", JSON.stringify(ws));
if (!Array.isArray(ws) || ws.length === 0) { console.log("⚠ no hay taller no-externo en el curso"); process.exit(1); }
const w = ws[0];

// 1) Habilitar: published, sin start futuro, due en el futuro
const upd = { status: "published", start_date: null, due_date: "2026-06-30T23:59:00.000Z" };
const ur = await fetch(`${URL}/rest/v1/workshops?id=eq.${w.id}`, { method: "PATCH", headers: h, body: JSON.stringify(upd) });
console.log(ur.ok ? `✓ taller "${w.title}" habilitado (due 2026-06-30)` : `⚠ update ${ur.status}`);

// 2) Asignar al estudiante (idempotente)
const ar = await fetch(`${URL}/rest/v1/workshop_assignments`, { method: "POST", headers: hi, body: JSON.stringify([{ workshop_id: w.id, user_id: uid }]) });
const aj = await ar.json().catch(() => null);
console.log(ar.ok ? `✓ asignación creada (o ya existía)` : `⚠ assignment ${ar.status}: ${JSON.stringify(aj)?.slice(0, 220)}`);

// Verificación: ¿la query del estudiante lo trae?
const check = await (await fetch(`${URL}/rest/v1/workshop_assignments?user_id=eq.${uid}&select=${encodeURIComponent("workshop:workshops(id,title,status,due_date,is_external,deleted_at)")}`, { headers: h })).json();
console.log("workshop_assignments del estudiante:", JSON.stringify(check));
