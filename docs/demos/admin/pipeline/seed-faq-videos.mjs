// Sube los MP4 de FAQ al bucket `help-videos` y registra/actualiza sus filas en
// `platform_help_videos` (kind='faq'). Fuente de verdad = los specs
// `modules/module-faq*.json` del repo. Idempotente (upsert por título+rol).
//
// Auth = login como SuperAdmin (mismo patrón que setup-tenant.mjs): NO requiere
// service_role key. La RLS `phv_write = is_super_admin()` permite la escritura y
// el bucket help-videos acepta la subida del SA. Lee URL/ANON de ../../../.env.
//
// Uso:  node seed-faq-videos.mjs [id ...]   (sin ids → todos los faq*)
import { readFileSync, readdirSync, existsSync } from "node:fs";

const REPO = "c:/Projects/Personal/examlab";
const MODULES = `${REPO}/docs/demos/admin/pipeline/modules`;
const OUTPUT = `${REPO}/docs/demos/faq/output`;
const BUCKET = "help-videos";
const SA_EMAIL = "castano.julian@correounivalle.edu.co";
const SA_PASS = "Tester#12345";

// .env → URL + ANON
const env = {};
for (const line of readFileSync(`${REPO}/.env`, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const URL = env.VITE_SUPABASE_URL;
const ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!URL || !ANON) throw new Error("Falta VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY en .env");

// 1) Login SuperAdmin → access_token
const authRes = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { "Content-Type": "application/json", apikey: ANON },
  body: JSON.stringify({ email: SA_EMAIL, password: SA_PASS }),
});
const auth = await authRes.json();
const TOKEN = auth.access_token;
if (!TOKEN) throw new Error(`Login SA falló: ${JSON.stringify(auth)}`);
const H = { apikey: ANON, Authorization: `Bearer ${TOKEN}` };

const onlyIds = process.argv.slice(2);
const specFiles = readdirSync(MODULES)
  .filter((f) => /^module-faq[ats]\d+\.json$/.test(f))
  .filter((f) => !onlyIds.length || onlyIds.some((id) => f === `module-${id}.json`))
  .sort();

if (!specFiles.length) throw new Error("No se encontraron specs module-faq*.json.");

let pos = 0;
let ok = 0;
const fails = [];
for (const f of specFiles) {
  const spec = JSON.parse(readFileSync(`${MODULES}/${f}`, "utf8"));
  const mp4 = `${OUTPUT}/${spec.id}.mp4`;
  const hasVideo = existsSync(mp4);
  const storagePath = `faq/${spec.id}.mp4`;
  let publicUrl = null;
  pos += 10;

  try {
    if (hasVideo) {
      const bytes = readFileSync(mp4);
      // Subida idempotente (x-upsert). El bucket es público → URL pública directa.
      const up = await fetch(`${URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
        method: "POST",
        headers: { ...H, "Content-Type": "video/mp4", "x-upsert": "true" },
        body: bytes,
      });
      if (!up.ok) throw new Error(`upload ${up.status}: ${(await up.text()).slice(0, 200)}`);
      publicUrl = `${URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;
    }

    const row = {
      title: spec.title,
      question: spec.question ?? null,
      kind: "faq",
      role: spec.role,
      route: spec.appPath ?? null,
      video_url: publicUrl,
      is_active: hasVideo, // sin MP4 aún → inactivo (el asistente no lo ofrece)
      position: pos,
    };

    // Upsert por (title, role): clave lógica estable del clip.
    const q = `title=eq.${encodeURIComponent(spec.title)}&role=eq.${encodeURIComponent(spec.role)}`;
    const existRes = await fetch(`${URL}/rest/v1/platform_help_videos?select=id&${q}`, { headers: H });
    const exist = await existRes.json();
    let res;
    if (Array.isArray(exist) && exist.length) {
      res = await fetch(`${URL}/rest/v1/platform_help_videos?id=eq.${exist[0].id}`, {
        method: "PATCH",
        headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(row),
      });
    } else {
      res = await fetch(`${URL}/rest/v1/platform_help_videos`, {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(row),
      });
    }
    if (!res.ok) throw new Error(`row ${res.status}: ${(await res.text()).slice(0, 200)}`);

    ok++;
    console.log(`✓ ${spec.id} — ${spec.role} — ${hasVideo ? "con video" : "SIN video (inactivo)"}`);
  } catch (e) {
    fails.push(spec.id);
    console.error(`✗ ${spec.id}: ${e.message ?? e}`);
  }
}
console.log(`\nHecho. ${ok}/${specFiles.length} ok.${fails.length ? " Fallaron: " + fails.join(", ") : ""}`);
