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
const cid = courses[0].id; // Fundamentos de Programación — donde el estudiante está matriculado

// ¿Ya existe una encuesta publicada en el curso? (evita duplicar al re-correr)
const existing = await (await fetch(`${URL}/rest/v1/polls?course_id=eq.${cid}&is_published=eq.true&select=id,title`, { headers: h })).json();
if (Array.isArray(existing) && existing.length) { console.log("Ya hay encuesta publicada:", JSON.stringify(existing)); process.exit(0); }

const pollRow = {
  course_id: cid,
  title: "¿Qué tema te gustaría repasar antes del parcial?",
  description: "Tu voto nos ayuda a priorizar la próxima clase.",
  poll_type: "single",
  results_visible_to_students: "after_close",
  allow_change_response: true,
  is_published: true,
  created_by: uid,
};
const pr = await fetch(`${URL}/rest/v1/polls`, { method: "POST", headers: h, body: JSON.stringify(pollRow) });
const pj = await pr.json().catch(() => null);
if (!pr.ok) { console.log("⚠ poll insert:", pr.status, JSON.stringify(pj)?.slice(0, 250)); process.exit(1); }
const pollId = pj[0].id;
console.log("✓ poll:", pollId);

const opts = ["Estructuras de control", "Funciones y modularidad", "Arreglos y colecciones"].map((label, i) => ({ poll_id: pollId, label, position: i }));
const or = await fetch(`${URL}/rest/v1/poll_options`, { method: "POST", headers: h, body: JSON.stringify(opts) });
console.log(or.ok ? `✓ ${opts.length} opciones` : `⚠ options ${or.status} ${JSON.stringify(await or.json().catch(()=>null))?.slice(0,200)}`);

// poll_courses: el trigger AFTER INSERT en polls crea el row ancla; upsert por si acaso.
const cr = await fetch(`${URL}/rest/v1/poll_courses`, { method: "POST", headers: hi, body: JSON.stringify([{ poll_id: pollId, course_id: cid }]) });
console.log(cr.ok ? "✓ poll_courses" : `(poll_courses ${cr.status} — probablemente ya creado por trigger)`);
console.log("Listo.");
