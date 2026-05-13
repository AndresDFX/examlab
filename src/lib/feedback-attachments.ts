/**
 * Helpers puros para adjuntos de feedback_comments.
 *
 * - Sanea nombres de archivo antes de subirlos al bucket (reemplaza
 *   caracteres inseguros, conserva extensión).
 * - Construye el path final en el bucket con el layout que esperan las
 *   RLS policies: `<user_id>/<comment_id>/<safe_filename>`.
 * - Decide un ícono semántico (key) según el MIME type para que la UI
 *   no tenga que repetir la lógica en cada render.
 * - Formatea tamaños en bytes a "1,2 MB" / "350 KB" / "12 B".
 *
 * Lógica pura, sin Supabase, para que sea testeable.
 */

/** Tamaño máximo aceptado por archivo (alineado con la migración). */
export const FEEDBACK_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

/** Cantidad máxima de archivos por comment. La UI hace bloqueo blando;
 *  la DB no impone límite. Pensado para evitar que un usuario suba 200
 *  archivos por accidente. */
export const FEEDBACK_ATTACHMENT_MAX_COUNT = 8;

export interface AttachmentRow {
  id: string;
  comment_id: string;
  path: string;
  name: string;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_by: string;
  created_at: string;
}

/**
 * Sanea un nombre de archivo: deja solo `[A-Za-z0-9._-]`, colapsa el
 * resto a `_`. Preserva la extensión (último `.xxx`). Si el resultado
 * quedara vacío, devuelve `archivo.bin`.
 *
 * Idempotente: aplicar dos veces da el mismo resultado.
 */
export function safeAttachmentName(name: string): string {
  if (!name || typeof name !== "string") return "archivo.bin";
  // Separa nombre/extensión por el ÚLTIMO punto (ej. "foo.tar.gz" → "foo.tar" + ".gz").
  const dot = name.lastIndexOf(".");
  const rawBase = dot > 0 ? name.slice(0, dot) : name;
  const rawExt = dot > 0 ? name.slice(dot) : "";
  const base = rawBase.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const ext = rawExt.replace(/[^A-Za-z0-9.]+/g, "");
  const safeBase = base || "archivo";
  return ext ? `${safeBase}${ext}` : safeBase;
}

/**
 * Construye el path en el bucket. Layout requerido por las RLS:
 * `<user_id>/<comment_id>/<safe_filename>`.
 *
 * @throws si userId o commentId son strings vacíos. Estos siempre deben
 *         venir de UUIDs reales — si están vacíos es un bug del caller.
 */
export function buildAttachmentPath(
  userId: string,
  commentId: string,
  filename: string,
): string {
  if (!userId) throw new Error("userId requerido para buildAttachmentPath");
  if (!commentId) throw new Error("commentId requerido para buildAttachmentPath");
  return `${userId}/${commentId}/${safeAttachmentName(filename)}`;
}

/** Categorías de ícono que la UI mapea a un lucide-icon. Mantenemos el
 *  set chico — todo lo desconocido cae a "file". */
export type AttachmentIconKind = "image" | "pdf" | "doc" | "zip" | "code" | "file";

/**
 * Decide la categoría de ícono a partir del MIME type. Usa el name como
 * fallback cuando el MIME viene null o vacío (ej. comments importados
 * sin metadata).
 */
export function attachmentIconKind(
  mime: string | null | undefined,
  name?: string,
): AttachmentIconKind {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf") return "pdf";
  if (m.includes("zip") || m.includes("rar") || m.includes("7z") || m.includes("tar"))
    return "zip";
  if (m.startsWith("text/") || m.includes("json") || m.includes("javascript")) return "code";
  if (m.includes("msword") || m.includes("officedocument") || m.includes("opendocument"))
    return "doc";
  // Fallback por extensión cuando el MIME no es informativo
  const ext = (name ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (["doc", "docx", "odt", "rtf"].includes(ext)) return "doc";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "zip";
  if (["js", "ts", "tsx", "jsx", "py", "java", "c", "cpp", "cs", "go", "rs", "md", "json"].includes(ext))
    return "code";
  return "file";
}

/**
 * Formatea bytes a string corto en es-CO. Acepta null/undefined → "—".
 * - 0..999       → "N B"
 * - 1KB..999KB   → "N KB"
 * - 1MB..        → "N,N MB"
 */
export function formatAttachmentSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  // Una decimal con coma (es-CO). Math.round * 10 / 10 evita problemas de toFixed.
  const mbOne = Math.round(mb * 10) / 10;
  return `${String(mbOne).replace(".", ",")} MB`;
}

/**
 * Valida que un File esté dentro de los límites del bucket. Devuelve
 * `null` si está OK, o un string con el motivo de rechazo (en es-CO)
 * para mostrar al usuario.
 */
export function validateAttachmentFile(
  file: { name: string; size: number },
): string | null {
  if (!file.name || file.name.trim().length === 0) return "El archivo no tiene nombre.";
  if (file.size <= 0) return "El archivo está vacío.";
  if (file.size > FEEDBACK_ATTACHMENT_MAX_BYTES) {
    return `El archivo supera el máximo de ${formatAttachmentSize(FEEDBACK_ATTACHMENT_MAX_BYTES)}.`;
  }
  return null;
}
