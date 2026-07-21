// Sube TODOS los MP4 de demo al bucket público `help-videos`, sobrescribiendo
// (x-upsert). Los tours de módulo van planos (`modulo-*.mp4`) → las URLs ya
// registradas en `platform_help_videos` sirven la versión nueva sin tocar la DB.
// Series completas y videos SA van planos también (viewables por URL). FAQ van a
// `faq/` (subfolder, como los sembró seed-faq-videos).
//
// Auth = login SuperAdmin (mismo patrón que seed-faq-videos / setup-tenant): lee
// URL/ANON de ../../../.env. NO requiere service_role key.
//
// Uso:  node docs/demos/admin/pipeline/upload-all-videos.mjs
import { readFileSync, existsSync, readdirSync } from "node:fs";

const REPO = "c:/Projects/Personal/examlab";
const DEMOS = `${REPO}/docs/demos`;
const BUCKET = "help-videos";
const SA_EMAIL = "castano.julian@correounivalle.edu.co";
const SA_PASS = "Tester#12345";

const env = {};
for (const line of readFileSync(`${REPO}/.env`, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const URL = env.VITE_SUPABASE_URL;
const ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!URL || !ANON) throw new Error("Falta VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY en .env");

const authRes = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { "Content-Type": "application/json", apikey: ANON },
  body: JSON.stringify({ email: SA_EMAIL, password: SA_PASS }),
});
const TOKEN = (await authRes.json()).access_token;
if (!TOKEN) throw new Error("Login SA falló");
const H = { apikey: ANON, Authorization: `Bearer ${TOKEN}` };

// Junta la lista de (archivoLocal, storagePath).
const jobs = [];
for (const role of ["admin", "teacher", "student", "superadmin"]) {
  const outDir = `${DEMOS}/${role}/output`;
  if (existsSync(outDir)) {
    for (const f of readdirSync(outDir).filter((x) => x.endsWith(".mp4"))) {
      jobs.push({ local: `${outDir}/${f}`, path: f }); // plano: modulo-*.mp4
    }
  }
  // Serie completa del rol.
  const serie = `${DEMOS}/${role}/serie-${role}-completa.mp4`;
  if (existsSync(serie)) jobs.push({ local: serie, path: `serie-${role}-completa.mp4` });
}
// FAQ (subfolder faq/).
const faqDir = `${DEMOS}/faq/output`;
if (existsSync(faqDir)) {
  for (const f of readdirSync(faqDir).filter((x) => x.endsWith(".mp4"))) {
    jobs.push({ local: faqDir + "/" + f, path: `faq/${f}` });
  }
}

console.log(`Subiendo ${jobs.length} videos a ${BUCKET}…`);
let ok = 0;
const fails = [];
for (const j of jobs) {
  try {
    const bytes = readFileSync(j.local);
    const r = await fetch(`${URL}/storage/v1/object/${BUCKET}/${j.path}`, {
      method: "POST",
      headers: { ...H, "Content-Type": "video/mp4", "x-upsert": "true" },
      body: bytes,
    });
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 150)}`);
    ok++;
    console.log(`  ✓ ${j.path} (${Math.round(bytes.length / 1024)} KB)`);
  } catch (e) {
    fails.push(j.path);
    console.error(`  ✗ ${j.path}: ${e.message ?? e}`);
  }
}
console.log(`\nHecho. ${ok}/${jobs.length} subidos.${fails.length ? " Fallaron: " + fails.join(", ") : ""}`);
