// Sube los MP4 de FAQ al bucket `help-videos` y registra/actualiza sus filas en
// `platform_help_videos` (kind='faq'). Fuente de verdad = los specs
// `modules/module-faq*.json` del repo. Idempotente (upsert por título+rol).
//
// Requisitos de entorno:
//   SUPABASE_URL               (ej. https://uxxpzfsfcnqiwwdxoelm.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY  (service role — bypassa RLS; NO commitear)
//
// Uso:  node seed-faq-videos.mjs [id ...]   (sin ids → todos los faq*)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const REPO = "C:/Projects/Personal/examlab";
const MODULES = `${REPO}/docs/demos/admin/pipeline/modules`;
const OUTPUT = `${REPO}/docs/demos/faq/output`;
const BUCKET = "help-videos";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el entorno.");
  process.exit(1);
}
const db = createClient(URL, KEY, { auth: { persistSession: false } });

const onlyIds = process.argv.slice(2);
const specFiles = readdirSync(MODULES)
  .filter((f) => /^module-faq[ats]\d+\.json$/.test(f))
  .filter((f) => !onlyIds.length || onlyIds.some((id) => f === `module-${id}.json`));

if (!specFiles.length) {
  console.error("No se encontraron specs module-faq*.json.");
  process.exit(1);
}

let pos = 0;
let ok = 0;
const fails = [];
for (const f of specFiles) {
  const spec = JSON.parse(readFileSync(`${MODULES}/${f}`, "utf8"));
  const mp4 = `${OUTPUT}/${spec.id}.mp4`;
  const hasVideo = existsSync(mp4);
  const storagePath = `faq/${spec.id}.mp4`;
  let publicUrl = null;

  try {
    if (hasVideo) {
      const bytes = readFileSync(mp4);
      const up = await db.storage
        .from(BUCKET)
        .upload(storagePath, bytes, { contentType: "video/mp4", upsert: true });
      if (up.error) throw up.error;
      publicUrl = db.storage.from(BUCKET).getPublicUrl(storagePath).data.publicUrl;
    }

    // Upsert por (title, role) — clave lógica estable del clip.
    const row = {
      title: spec.title,
      question: spec.question ?? null,
      kind: "faq",
      role: spec.role,
      route: spec.appPath ?? null,
      video_url: publicUrl,
      is_active: hasVideo, // sin MP4 aún → inactivo (el asistente no lo ofrece)
      position: (pos += 10),
    };
    const { data: existing } = await db
      .from("platform_help_videos")
      .select("id")
      .eq("title", spec.title)
      .eq("role", spec.role)
      .maybeSingle();
    const res = existing
      ? await db.from("platform_help_videos").update(row).eq("id", existing.id)
      : await db.from("platform_help_videos").insert(row);
    if (res.error) throw res.error;

    ok++;
    console.log(`✓ ${spec.id} — ${spec.role} — ${hasVideo ? "con video" : "SIN video (inactivo)"}`);
  } catch (e) {
    fails.push(spec.id);
    console.error(`✗ ${spec.id}: ${e.message ?? e}`);
  }
}
console.log(`\nHecho. ${ok}/${specFiles.length} ok.${fails.length ? " Fallaron: " + fails.join(", ") : ""}`);
