/**
 * Helpers puros para el módulo de mensajería.
 *
 * Toda lógica de formato/agrupación que el componente de mensajes
 * necesita y que conviene testar sin React/Supabase.
 */

import { formatDate, formatTime } from "@/lib/format";

export interface MessageLite {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  /** Si existe, el mensaje fue editado a esa hora. */
  edited_at?: string | null;
}

/** Grupo "día" en la vista de chat: encabezado de fecha + items. */
export interface MessageDayGroup {
  /** Etiqueta humana ("Hoy", "Ayer", "30 sep 2026"). */
  label: string;
  /** YYYY-MM-DD usado como key estable. */
  dayKey: string;
  items: MessageLite[];
}

function ymdKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Devuelve etiqueta humana relativa al día de hoy:
 *   - "Hoy" si es hoy
 *   - "Ayer" si es ayer
 *   - "30 sep 2026" para días anteriores (usa formatDate)
 *
 * `now` se inyecta para los tests; en producción se pasa `new Date()`.
 */
export function relativeDayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const todayKey = ymdKey(startOfDay(now));
  const yKey = ymdKey(startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)));
  const k = ymdKey(startOfDay(d));
  if (k === todayKey) return "Hoy";
  if (k === yKey) return "Ayer";
  return formatDate(d);
}

/**
 * Agrupa mensajes por día en el orden cronológico ascendente. Mensajes
 * con timestamps inválidos se descartan.
 */
export function groupMessagesByDay(
  messages: readonly MessageLite[],
  now: Date = new Date(),
): MessageDayGroup[] {
  const sorted = [...messages]
    .filter((m) => !Number.isNaN(new Date(m.created_at).getTime()))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const out: MessageDayGroup[] = [];
  for (const m of sorted) {
    const d = new Date(m.created_at);
    const key = ymdKey(startOfDay(d));
    const last = out[out.length - 1];
    if (last && last.dayKey === key) {
      last.items.push(m);
    } else {
      out.push({ dayKey: key, label: relativeDayLabel(m.created_at, now), items: [m] });
    }
  }
  return out;
}

/** Tiempo corto "14:30" para el bubble del mensaje. */
export function formatMessageTime(iso: string): string {
  return formatTime(iso);
}

/**
 * Trunca un cuerpo de mensaje para previews en la lista de conversaciones.
 * Mantiene la primera línea (corta saltos de línea), trim, y limita a
 * `max` caracteres con ellipsis "…".
 */
export function previewBody(body: string | null | undefined, max = 80): string {
  if (!body) return "";
  const firstLine = body.split(/\r?\n/, 1)[0].trim();
  if (firstLine.length <= max) return firstLine;
  return firstLine.slice(0, max - 1) + "…";
}

/**
 * Decide si dos mensajes consecutivos del mismo sender deben pegarse
 * (sin avatar/separación entre ellos). Heurística: mismo sender + < 60s
 * de diferencia.
 */
export function shouldStackWithPrevious(curr: MessageLite, prev: MessageLite | undefined): boolean {
  if (!prev) return false;
  if (curr.sender_id !== prev.sender_id) return false;
  const dt = new Date(curr.created_at).getTime() - new Date(prev.created_at).getTime();
  return dt >= 0 && dt < 60_000;
}

/**
 * Aplica el filtro de "borrado para mí" sobre una lista de mensajes:
 * retorna solo los mensajes posteriores a `clearedAt`. Si `clearedAt`
 * es null/undefined, devuelve todos los mensajes.
 *
 * Existe el equivalente en RLS (policy SELECT de messages); este helper
 * sirve para casos donde traemos los mensajes "raw" (ej. cache local) y
 * queremos aplicar el mismo recorte en cliente.
 */
export function filterByClearedAt(
  messages: readonly MessageLite[],
  clearedAt: string | null | undefined,
): MessageLite[] {
  if (!clearedAt) return [...messages];
  return messages.filter((m) => m.created_at > clearedAt);
}

/**
 * Cuenta cuántos mensajes están "sin leer" para mí en una conversación:
 * mensajes posteriores a `lastReadAt` y enviados por OTRO usuario (no
 * tiene sentido marcar mis propios mensajes como no-leídos).
 *
 * Si `lastReadAt` es null/undefined, todos los mensajes ajenos cuentan
 * como no leídos (caso "primera apertura").
 */
/**
 * A partir de una lista de mensajes (potencialmente de muchas convs),
 * cuenta cuántas conversaciones tienen como ÚLTIMO mensaje uno enviado
 * por OTRO usuario distinto a `myUserId`. Útil como fallback en cliente
 * cuando no usamos la RPC `count_unanswered_conversations`, y para tests.
 *
 * Reglas:
 *   - Una conversación sin mensajes no entra al conteo (no hay nada
 *     pendiente que responder).
 *   - Solo importa el último mensaje por conv (por `created_at`).
 *   - Si `myUserId` es null/undefined, devuelve 0 (no podemos decidir).
 */
export function unansweredConversationsCount(
  messages: readonly MessageLite[],
  myUserId: string | null | undefined,
): number {
  if (!myUserId) return 0;
  const latestBySender = new Map<string, MessageLite>();
  for (const m of messages) {
    const prev = latestBySender.get(m.conversation_id);
    if (!prev || m.created_at > prev.created_at) {
      latestBySender.set(m.conversation_id, m);
    }
  }
  let n = 0;
  for (const [, m] of latestBySender) {
    if (m.sender_id !== myUserId) n += 1;
  }
  return n;
}

export function unreadCount(
  messages: readonly MessageLite[],
  lastReadAt: string | null | undefined,
  myUserId: string | null | undefined,
): number {
  if (!myUserId) return 0;
  let n = 0;
  for (const m of messages) {
    if (m.sender_id === myUserId) continue;
    if (!lastReadAt || m.created_at > lastReadAt) n += 1;
  }
  return n;
}

/**
 * Búsqueda case-insensitive sobre el body de un set de mensajes.
 * Devuelve los mensajes que matchean. Query vacío = todos.
 *
 * Para resaltado visual, el caller puede usar el helper `splitByMatch`.
 */
export function searchMessages(
  messages: readonly MessageLite[],
  query: string,
): MessageLite[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...messages];
  return messages.filter((m) => m.body.toLowerCase().includes(q));
}

/**
 * Divide un texto en segmentos `{text, isMatch}` según el query.
 * Útil para resaltado: la UI envuelve los `isMatch=true` en `<mark>`.
 *
 * El match es case-insensitive pero respeta el casing original del texto.
 */
export function splitByMatch(
  text: string,
  query: string,
): Array<{ text: string; isMatch: boolean }> {
  const q = query.trim();
  if (!q) return [{ text, isMatch: false }];
  const qLower = q.toLowerCase();
  const out: Array<{ text: string; isMatch: boolean }> = [];
  let i = 0;
  const lower = text.toLowerCase();
  while (i < text.length) {
    const idx = lower.indexOf(qLower, i);
    if (idx === -1) {
      out.push({ text: text.slice(i), isMatch: false });
      break;
    }
    if (idx > i) out.push({ text: text.slice(i, idx), isMatch: false });
    out.push({ text: text.slice(idx, idx + q.length), isMatch: true });
    i = idx + q.length;
  }
  return out;
}

/**
 * True si el mensaje fue leído por el OTRO usuario de la conversación.
 *
 * Un mensaje se considera leído cuando el destinatario abrió la conv
 * después de su `created_at` — eso dispara `mark_conversation_read` que
 * setea `<otherSide>_last_read_at = now()`. Si ese timestamp es >= el
 * `created_at` del mensaje, el receptor ya lo vio.
 *
 * Usado para:
 *   - Pintar el doble check ✓✓ tipo WhatsApp en los mensajes propios.
 *   - Decidir si el sender aún puede editarlo / borrarlo (ver
 *     `canEditOrDeleteMessage`). Espeja la lógica del RLS en DB.
 *
 * Importante: solo aplica a mensajes propios. Para mensajes ajenos el
 * "leído" no tiene sentido (los lees vos al abrir la conv, el bool de
 * "el otro lo leyó" no aplica).
 */
export function isMessageReadByOther(
  messageCreatedAt: string,
  otherSideLastReadAt: string | null | undefined,
): boolean {
  if (!otherSideLastReadAt) return false;
  return otherSideLastReadAt >= messageCreatedAt;
}

/**
 * True si el sender aún puede editar/borrar el mensaje. Mismo predicado
 * que el RLS en DB (`_message_was_read_by_other` invertido).
 *
 * Reglas:
 *   - Si no es mío (sender !== me), NUNCA puedo editar/borrar → false.
 *   - Si es mío y el otro no lo leyó → true.
 *   - Si es mío y el otro lo leyó → false (queda congelado).
 */
export function canEditOrDeleteMessage(params: {
  senderId: string;
  myUserId: string | null | undefined;
  messageCreatedAt: string;
  otherSideLastReadAt: string | null | undefined;
}): boolean {
  if (!params.myUserId) return false;
  if (params.senderId !== params.myUserId) return false;
  return !isMessageReadByOther(params.messageCreatedAt, params.otherSideLastReadAt);
}
