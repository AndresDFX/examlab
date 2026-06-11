/**
 * Subida rápida de contenido desde el TABLERO del docente (CourseBoardDialog),
 * sin pasar por el módulo de Contenidos ni su formulario completo.
 *
 * Reusa el mismo destino que `UploadExternalContentDialog`:
 *   - Fila en `generated_contents` (status='done', is_published=true) anclada
 *     al curso (course_id), kind de archivos "uploaded".
 *   - Archivos en el bucket `generated-contents`, path
 *     `${userId}/${contentId}/${slugifyFilename(name)}`.
 *   - Texto inline en `files[].body` para código/notebooks (visor/runner de la
 *     sesión los lee sin round-trip a Storage).
 *   - Fila en `content_course_assignments` (junction N-N) para el curso.
 *
 * INVARIANTE: las constantes de extensiones/límites y el flujo de upload van en
 * paralelo con [src/modules/contents/UploadExternalContentDialog.tsx]. Si una
 * cambia (extensiones aceptadas, tope de tamaño, inline body), sincronizar la
 * otra.
 */
import { supabase } from "@/integrations/supabase/client";
import { slugifyFilename } from "@/modules/contents/upload-external-helpers";
import { stripNotebookOutputs } from "@/modules/code/notebook";

export const BOARD_CONTENT_BUCKET = "generated-contents";
export const BOARD_ACCEPTED_EXTENSIONS = [
  ".pdf",
  ".pptx",
  ".docx",
  ".xlsx",
  ".md",
  ".txt",
  ".csv",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".svg",
  ".zip",
  ".java",
  ".py",
  ".js",
  ".ipynb",
];
const INLINE_BODY_EXTENSIONS = [".java", ".py", ".js", ".ipynb"];
const MAX_FILE_SIZE_MB = 25;
const MAX_TOTAL_SIZE_MB = 100;
const MAX_INLINE_BODY_CHARS = 500_000;

const NAME_RE = /^Contenidos #(\d+)\b/i;

/**
 * Próximo nombre auto para un contenido subido desde el tablero:
 * `"Contenidos #N - <curso>"`, donde N = max(#existentes que matchean el
 * patrón) + 1. PURO (sin I/O) para poder testearlo. El caller pasa los
 * display_name ya existentes del curso (incluyendo los soft-deleted, para que
 * N no choque con el índice único `(teacher_id, lower(display_name))`).
 */
export function nextBoardContentName(existingDisplayNames: string[], courseName: string): string {
  let max = 0;
  for (const n of existingDisplayNames) {
    const m = (n ?? "").match(NAME_RE);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v > max) max = v;
    }
  }
  return `Contenidos #${max + 1} - ${courseName}`;
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

export type BoardUploadResult = {
  contentId: string | null;
  displayName: string;
  uploaded: number;
  /** Archivos descartados por validación (extensión/tamaño). */
  skipped: { name: string; reason: "ext" | "size" | "total" }[];
  /** Archivos que pasaron validación pero fallaron al subir a Storage. */
  failed: string[];
  /** Mensaje de error fatal (no se creó nada). */
  error?: string;
};

/**
 * Sube N archivos como UN contenido del curso. Devuelve un resumen para que el
 * caller arme el toast. Best-effort por archivo: los que fallan se reportan,
 * los demás suben. Si NINGÚN archivo válido sube, borra la fila huérfana.
 */
export async function uploadBoardContent(params: {
  userId: string;
  courseId: string;
  courseName: string;
  files: File[];
  displayName: string;
  language?: string;
}): Promise<BoardUploadResult> {
  const { userId, courseId, courseName, files, displayName, language = "es" } = params;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;

  // 1) Validación de extensión + tamaño (per-file y total).
  const skipped: BoardUploadResult["skipped"] = [];
  const valid: File[] = [];
  let totalBytes = 0;
  for (const f of files) {
    if (!BOARD_ACCEPTED_EXTENSIONS.includes(extOf(f.name))) {
      skipped.push({ name: f.name, reason: "ext" });
      continue;
    }
    if (f.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      skipped.push({ name: f.name, reason: "size" });
      continue;
    }
    if (totalBytes + f.size > MAX_TOTAL_SIZE_MB * 1024 * 1024) {
      skipped.push({ name: f.name, reason: "total" });
      continue;
    }
    totalBytes += f.size;
    valid.push(f);
  }

  if (valid.length === 0) {
    return {
      contentId: null,
      displayName,
      uploaded: 0,
      skipped,
      failed: [],
      error: "no_valid_files",
    };
  }

  // 2) Crear la fila del contenido (sin archivos todavía). Quick-upload del
  //    tablero → material individual, publicado, anclado al curso.
  const { data: inserted, error: insErr } = await db
    .from("generated_contents")
    .insert({
      teacher_id: userId,
      display_name: displayName,
      topic: displayName,
      mode: "material_individual",
      language,
      course_id: courseId,
      status: "done",
      is_published: true,
      files: [],
    })
    .select("id")
    .single();

  if (insErr || !inserted?.id) {
    return {
      contentId: null,
      displayName,
      uploaded: 0,
      skipped,
      failed: [],
      error: insErr?.message ?? "insert_failed",
    };
  }
  const contentId = inserted.id as string;

  // 3) Subir cada archivo válido a Storage + texto inline para código/notebooks.
  const uploaded: Array<{ name: string; path: string; kind: string; body?: string }> = [];
  const failed: string[] = [];
  for (const f of valid) {
    const path = `${userId}/${contentId}/${slugifyFilename(f.name)}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upErr } = await (supabase.storage as any)
      .from(BOARD_CONTENT_BUCKET)
      .upload(path, f, { upsert: false, contentType: f.type || undefined });
    if (upErr) {
      failed.push(f.name);
      continue;
    }
    const lower = f.name.toLowerCase();
    let body: string | undefined;
    if (INLINE_BODY_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      try {
        let text = await f.text();
        if (lower.endsWith(".ipynb")) text = stripNotebookOutputs(text);
        body = text.length > MAX_INLINE_BODY_CHARS ? text.slice(0, MAX_INLINE_BODY_CHARS) : text;
      } catch {
        /* sin body — degrada a descargable */
      }
    }
    uploaded.push({ name: f.name, path, kind: "uploaded", ...(body !== undefined ? { body } : {}) });
  }

  if (uploaded.length === 0) {
    // Todo falló al subir → borrar la fila para no dejarla huérfana.
    await db.from("generated_contents").delete().eq("id", contentId);
    return { contentId: null, displayName, uploaded: 0, skipped, failed, error: "all_uploads_failed" };
  }

  // 4) Guardar el listado de archivos subidos.
  await db.from("generated_contents").update({ files: uploaded }).eq("id", contentId);

  // 5) Junction N-N con el curso (el ancla `course_id` ya está; esto lo hace
  //    visible por el flujo de assignments). Best-effort.
  await db
    .from("content_course_assignments")
    .insert({ content_id: contentId, course_id: courseId, created_by: userId });

  void courseName; // (queda disponible para futuros usos del resumen)
  return { contentId, displayName, uploaded: uploaded.length, skipped, failed };
}
