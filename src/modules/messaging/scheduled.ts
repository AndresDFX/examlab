/**
 * Helpers puros de mensajes programados (scheduled messages).
 *
 * El envío real lo hace `dispatch_scheduled_messages()` (SQL + pg_cron,
 * migración 20260709000000). Acá viven la validación client-side de la
 * fecha y las etiquetas de estado para la UI.
 */

/** Mínimo lead time para programar: 1 minuto en el futuro. Por debajo de
 *  esto no tiene sentido (el cron corre cada minuto) y suele ser un error
 *  del usuario (eligió "ahora"). */
export const MIN_SCHEDULE_LEAD_MS = 60_000;

export interface ScheduleValidation {
  ok: boolean;
  error?: string;
}

/**
 * Valida la fecha/hora elegida para programar. `sendAtLocal` es el string
 * `YYYY-MM-DDTHH:mm` que emite `DateTimePicker` (hora local). Comparamos
 * contra `now` con un margen mínimo de `MIN_SCHEDULE_LEAD_MS`.
 */
export function validateScheduledSend(
  sendAtLocal: string,
  now: Date = new Date(),
): ScheduleValidation {
  if (!sendAtLocal || !sendAtLocal.trim()) {
    return { ok: false, error: "Elige fecha y hora de envío." };
  }
  const when = new Date(sendAtLocal);
  if (Number.isNaN(when.getTime())) {
    return { ok: false, error: "Fecha u hora inválida." };
  }
  if (when.getTime() - now.getTime() < MIN_SCHEDULE_LEAD_MS) {
    return { ok: false, error: "La fecha debe ser al menos 1 minuto en el futuro." };
  }
  return { ok: true };
}

export type ScheduledStatus = "pending" | "sent" | "cancelled" | "failed";

/** Etiqueta humana (es-CO) de cada estado. */
export const SCHEDULED_STATUS_LABEL: Record<ScheduledStatus, string> = {
  pending: "Programado",
  sent: "Enviado",
  cancelled: "Cancelado",
  failed: "Falló",
};

/** Convierte el string local del DateTimePicker a ISO (UTC) para guardar
 *  en `scheduled_messages.send_at` (TIMESTAMPTZ). `new Date(local)`
 *  interpreta el string como hora local del navegador. */
export function localToIso(sendAtLocal: string): string {
  return new Date(sendAtLocal).toISOString();
}
