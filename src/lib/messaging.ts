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
