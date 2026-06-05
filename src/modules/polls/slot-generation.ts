/**
 * Generación de slots de encuesta tipo Doodle.
 *
 * Modelo (V2, refactor 2026-06):
 *   - El docente agrega manualmente N FECHAS (días disponibles).
 *   - Define UNA ventana horaria compartida (timeStart → timeEnd).
 *   - Define la periodicidad (cada N min) + cupo por slot.
 *   - Para CADA fecha se generan los slots dentro de la ventana,
 *     produciendo un cross-product `fechas × slots-por-día`.
 *
 * Antes (V1) había un solo `Inicio` y `Fin` (DateTimePicker completo) que
 * podía cruzar días. Era poco intuitivo: si querías "9-12 lun, mar y mié"
 * había que poner inicio=lun 9:00 y fin=mié 12:00, pero también
 * generaba slots de lun 12:00 a lun 18:00 cruzando la noche. V2 separa
 * las fechas de la ventana horaria → un modelo más natural.
 *
 * Esta función es PURA — sin React, sin Date.now(), sin toast. La UI
 * la invoca con strings ya parseados desde inputs. Permite test
 * exhaustivo sin DOM.
 *
 * Formato de label:
 *   "<weekday corto>, <día> <mes corto> · <hora 12h>"
 *   Ej: "lun, 10 jun · 9:00 AM"
 *
 * Locale: es-CO hardcoded — consistente con `src/shared/lib/format.ts`.
 */

export interface GenerateSlotsInput {
  /** Fechas YYYY-MM-DD que el docente eligió (días disponibles).
   *  Vacío → 0 slots generados. Se dedup-ean antes de iterar. */
  dates: string[];
  /** Hora de inicio del día, formato HH:mm (24h). Ej. "09:00". */
  timeStart: string;
  /** Hora de fin del día (exclusiva), formato HH:mm. El último slot
   *  generado tiene su INICIO antes de `timeEnd`. Ej. con start 09:00,
   *  end 10:00, step 15 → genera 9:00, 9:15, 9:30, 9:45 (4 slots). */
  timeEnd: string;
  /** Periodicidad en minutos entre slots. Debe ser entero > 0. */
  stepMin: number;
  /** Cupo (max_responses) para cada slot generado. > 0. */
  cupo: number;
}

export interface GeneratedSlot {
  label: string;
  /** Como string para alinear con el shape del `DraftOption` del form
   *  (los inputs numéricos son texto hasta el parse final). */
  max_responses: string;
}

/** Parsea `HH:mm` a minutos desde medianoche. Retorna null si inválido. */
function parseTimeToMinutes(time: string): number | null {
  if (!time || typeof time !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

/** Formato 12h con AM/PM. 0 → 12 AM, 13 → 1 PM, etc. */
function formatTime12h(minutes: number): string {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const period = hh >= 12 ? "PM" : "AM";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${period}`;
}

/** Convierte "YYYY-MM-DD" a Date local (mediodía como anchor — evita
 *  cruzar zonas horarias al formatear con Intl). Retorna null si
 *  inválido. */
function parseLocalDate(dateStr: string): Date | null {
  if (!dateStr || typeof dateStr !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  // Construimos Date con día/mes/año explícitos (anchor 12:00 local) para
  // que el formato de weekday/mes use la fecha real sin sufrir desplazamientos
  // por TZ — mismo patrón que `formatDateOnly` en shared/lib/format.ts.
  const date = new Date(y, m - 1, d, 12, 0, 0, 0);
  // Validación: si la fecha "wraps" (ej. 2026-02-31 → mar 03), date.getMonth()
  // no coincide con `m - 1`. Rechazamos.
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    return null;
  }
  return date;
}

const DATE_FMT = new Intl.DateTimeFormat("es-CO", {
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** Sanea el formato regresado por Intl es-CO: a veces incluye "." al
 *  final del weekday corto ("lun." en lugar de "lun"). Lo normalizamos
 *  para tener etiquetas limpias en producción. */
function formatDateLabel(d: Date): string {
  return DATE_FMT.format(d).replace(/\./g, "");
}

/**
 * Genera los slots cross-product `fechas × slots-por-día`. Pura: misma
 * entrada → misma salida; sin side effects ni dependencias externas.
 *
 * Reglas:
 *   - Dates duplicadas se dedupean preservando el primer orden de aparición.
 *   - Dates inválidas se ignoran silenciosamente (el caller validó UI).
 *   - timeEnd <= timeStart → 0 slots (sin error — caller chequea antes).
 *   - stepMin <= 0 → 0 slots.
 *   - cupo <= 0 → se coerciona a 1 (defensa, el caller validó).
 *
 * Las fechas se procesan en el orden recibido (después de dedup).
 * Dentro de cada fecha, los slots van ascendentes por hora.
 */
export function generateSlotsForDates(input: GenerateSlotsInput): GeneratedSlot[] {
  const { dates, timeStart, timeEnd, stepMin, cupo } = input;
  if (!Array.isArray(dates) || dates.length === 0) return [];
  const startMin = parseTimeToMinutes(timeStart);
  const endMin = parseTimeToMinutes(timeEnd);
  if (startMin == null || endMin == null) return [];
  if (endMin <= startMin) return [];
  if (!Number.isFinite(stepMin) || stepMin <= 0) return [];
  const safeCupo = Math.max(1, Math.floor(cupo));
  const cupoStr = String(safeCupo);

  // Dedup preservando orden.
  const seen = new Set<string>();
  const uniqDates: string[] = [];
  for (const d of dates) {
    if (typeof d !== "string") continue;
    const trimmed = d.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    uniqDates.push(trimmed);
  }

  const out: GeneratedSlot[] = [];
  for (const dateStr of uniqDates) {
    const date = parseLocalDate(dateStr);
    if (!date) continue;
    const dateLabel = formatDateLabel(date);
    for (let m = startMin; m < endMin; m += stepMin) {
      const label = `${dateLabel} · ${formatTime12h(m)}`;
      out.push({ label, max_responses: cupoStr });
    }
  }
  return out;
}

/**
 * Calcula el cupo sugerido (ceil de matriculados / total de slots) para
 * que TODOS los matriculados quepan en al menos un slot. Si no hay
 * matriculados o el set de slots está vacío, retorna 1.
 *
 * Separada del generate principal para que la UI pueda recalcular
 * sugerencia "en vivo" mientras el docente edita fechas/horas/step
 * sin tener que ejecutar la generación completa.
 */
export function suggestSlotCupo(
  dates: string[],
  timeStart: string,
  timeEnd: string,
  stepMin: number,
  enrolledCount: number | null | undefined,
): number {
  if (!enrolledCount || enrolledCount <= 0) return 1;
  const startMin = parseTimeToMinutes(timeStart);
  const endMin = parseTimeToMinutes(timeEnd);
  if (startMin == null || endMin == null || endMin <= startMin) return 1;
  if (!Number.isFinite(stepMin) || stepMin <= 0) return 1;
  const slotsPerDay = Math.floor((endMin - startMin) / stepMin);
  if (slotsPerDay <= 0) return 1;
  // Dedup count
  const uniq = new Set(dates.filter((d) => typeof d === "string" && d.trim()));
  const totalSlots = uniq.size * slotsPerDay;
  if (totalSlots <= 0) return 1;
  return Math.max(1, Math.ceil(enrolledCount / totalSlots));
}
