// Sube las PRESENTACIONES y los MANUALES al bucket público `help-docs`, con los
// nombres CANÓNICOS que embeben los correos de docs/demos/correos/ (ver el índice
// _ENLACES-demos.md). Sobrescribe por nombre (x-upsert) para que los enlaces de
// los correos sean estables.
//
// WHY existe este script: estos archivos se subían A MANO, así que el repo podía
// tener una presentación corregida y el correo seguir sirviendo la vieja
// (verificado: presentacion-general.pptx y presentacion-modelo-modular.pptx en
// Storage eran del 18-jul, sin el cambio "tenant" → "institución"). Es el mismo
// problema que upload-all-videos.mjs resuelve para los .mp4.
//
// OJO con `presentacion-comercial.pptx`: el enlace del correo NO lleva versión en
// el nombre y la presentación VIGENTE es la v3 (así está publicada hoy). Si sale
// una v4, cambiá el mapeo acá — no el nombre del enlace.
//
// Auth = login SuperAdmin (mismo patrón que upload-all-videos.mjs). Lee URL/ANON
// de ../../../.env. NO requiere service_role key.
//
// Uso:  node docs/demos/admin/pipeline/upload-help-docs.mjs
import { readFileSync, existsSync } from "node:fs";

const REPO = "c:/Projects/Personal/examlab";
const DEMOS = `${REPO}/docs/demos`;
const BUCKET = "help-docs";
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

// (archivo local, nombre en Storage, content-type)
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const JOBS = [
  // Presentaciones comerciales
  [`${DEMOS}/presentacion/ExamLab-Presentacion-General.pptx`, "presentacion-general.pptx", PPTX],
  [`${DEMOS}/presentacion/ExamLab-Presentacion-Comercial-v3.pptx`, "presentacion-comercial.pptx", PPTX],
  [`${DEMOS}/presentacion/ExamLab-Presentacion-Aliados.pptx`, "presentacion-aliados.pptx", PPTX],
  [`${DEMOS}/presentacion/ExamLab-Presentacion-Comercial-Administrada.pptx`, "presentacion-comercial-administrada.pptx", PPTX],
  [`${DEMOS}/presentacion/ExamLab-Presentacion-Independientes.pptx`, "presentacion-independientes.pptx", PPTX],
  [`${DEMOS}/presentacion/ExamLab-Presentacion-Modelo-Modular.pptx`, "presentacion-modelo-modular.pptx", PPTX],
  // Manuales (los genera scripts/gen-manual-pdfs.mjs)
  [`${DEMOS}/manual/pdf/manual.pdf`, "manual.pdf", "application/pdf"],
  [`${DEMOS}/manual/pdf/manual-administrador.pdf`, "manual-administrador.pdf", "application/pdf"],
  [`${DEMOS}/manual/pdf/manual-docente.pdf`, "manual-docente.pdf", "application/pdf"],
  [`${DEMOS}/manual/pdf/manual-estudiante.pdf`, "manual-estudiante.pdf", "application/pdf"],
];

const authRes = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { "Content-Type": "application/json", apikey: ANON },
  body: JSON.stringify({ email: SA_EMAIL, password: SA_PASS }),
});
const TOKEN = (await authRes.json()).access_token;
if (!TOKEN) throw new Error("Login SA falló");
const H = { apikey: ANON, Authorization: `Bearer ${TOKEN}` };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mismo patrón de reintentos que upload-all-videos.mjs: el uplink es flaky.
async function uploadWithRetry(local, path, type) {
  const bytes = readFileSync(local);
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await fetch(`${URL}/storage/v1/object/${BUCKET}/${path}`, {
        method: "POST",
        headers: { ...H, "Content-Type": type, "x-upsert": "true" },
        body: bytes,
      });
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 150)}`);
      return { kb: Math.round(bytes.length / 1024), attempt };
    } catch (e) {
      lastErr = e;
      if (attempt < 5) await sleep(attempt * 2500);
    }
  }
  throw lastErr;
}

const pending = JOBS.filter(([local, path]) => {
  if (existsSync(local)) return true;
  console.warn(`  ⚠ sin fuente local: ${path} (esperaba ${local})`);
  return false;
});

console.log(`Subiendo ${pending.length} documentos a ${BUCKET}…`);
let ok = 0;
const fails = [];
for (const [local, path, type] of pending) {
  try {
    const { kb, attempt } = await uploadWithRetry(local, path, type);
    ok++;
    console.log(`  ✓ ${path} (${kb} KB)${attempt > 1 ? ` [intento ${attempt}]` : ""}`);
  } catch (e) {
    fails.push(path);
    console.error(`  ✗ ${path}: ${e.message ?? e}`);
  }
  await sleep(300);
}
console.log(`\nHecho. ${ok}/${pending.length} subidos.${fails.length ? " Fallaron: " + fails.join(", ") : ""}`);
