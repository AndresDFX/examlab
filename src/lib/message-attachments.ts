/**
 * Helpers para adjuntos de mensajes (tabla `message_attachments`,
 * bucket `message-attachments`).
 *
 * Layout del bucket: `<user_id>/<message_id>/<safe_filename>`.
 *
 * Reusa los helpers genéricos de `feedback-attachments` (saneamiento,
 * íconos, formato de tamaño, validación) — son los mismos sin importar
 * el contexto del archivo. Lo único distinto es el segundo segmento del
 * path (message_id en vez de comment_id) y la tabla destino.
 */

import {
  safeAttachmentName,
  type AttachmentIconKind,
} from "@/lib/feedback-attachments";

export {
  attachmentIconKind,
  formatAttachmentSize,
  safeAttachmentName,
  validateAttachmentFile,
  FEEDBACK_ATTACHMENT_MAX_BYTES as MESSAGE_ATTACHMENT_MAX_BYTES,
  FEEDBACK_ATTACHMENT_MAX_COUNT as MESSAGE_ATTACHMENT_MAX_COUNT,
} from "@/lib/feedback-attachments";

export type { AttachmentIconKind };

/** Mismo shape que `feedback_attachments` pero apunta a message_id. */
export interface MessageAttachmentRow {
  id: string;
  message_id: string;
  path: string;
  name: string;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_by: string;
  created_at: string;
}

/**
 * Construye el path en el bucket `message-attachments`.
 *
 * @throws si userId o messageId son strings vacíos.
 */
export function buildMessageAttachmentPath(
  userId: string,
  messageId: string,
  filename: string,
): string {
  if (!userId) throw new Error("userId requerido para buildMessageAttachmentPath");
  if (!messageId) throw new Error("messageId requerido para buildMessageAttachmentPath");
  return `${userId}/${messageId}/${safeAttachmentName(filename)}`;
}
