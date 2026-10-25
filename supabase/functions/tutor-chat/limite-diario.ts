/**
 * Límite diario de preguntas al Asistente IA (Tutor IA), POR ESTUDIANTE y POR
 * CURSO, reiniciado cada día calendario de Bogotá (medianoche hora Colombia).
 *
 * Helpers PUROS (solo aritmética de fechas + resolución de número): sin Deno,
 * sin red. Viven en el edge para ser la fuente única; los importan:
 *   - el handler del edge (`supabase/functions/tutor-chat/index.ts`),
 *   - la pantalla del estudiante (`src/routes/app.student.tutor.$courseId.tsx`,
 *     por ruta relativa — mismo patrón que AdminModelPanel ↔ _shared/ai-vision.ts),
 *   - sus tests (`src/modules/tutor/limite-diario.test.ts`, import relativo).
 *
 * El valor configurado vive en `app_settings.tutor_daily_limit` (NULL = usar el
 * default del código). Lo edita solo la institución (Admin del tenant / SuperAdmin).
 */

/** Default del código cuando la institución no configura nada. */
export const DEFAULT_TUTOR_DAILY_LIMIT = 25;

/** Tope razonable para el valor configurable (espejo del CHECK de la migración). */
export const MAX_TUTOR_DAILY_LIMIT = 500;

/**
 * Límite EFECTIVO: el configurado si es un entero válido (1..MAX); si no
 * (NULL, 0, negativo, no entero, fuera de rango), el default del código.
 * Falla hacia el default: una institución a medio configurar funciona igual.
 */
export function resolverLimiteEfectivo(
  configurado: number | null | undefined,
): number {
  if (
    typeof configurado === "number" &&
    Number.isInteger(configurado) &&
    configurado >= 1 &&
    configurado <= MAX_TUTOR_DAILY_LIMIT
  ) {
    return configurado;
  }
  return DEFAULT_TUTOR_DAILY_LIMIT;
}

/**
 * Fecha calendario de Bogotá de `now` como "YYYY-MM-DD". Es la clave de día del
 * contador `tutor_uso_diario.dia`; debe coincidir con el `(now() AT TIME ZONE
 * 'America/Bogota')::date` que usan las funciones SQL del edge.
 */
export function fechaDiaBogota(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

/**
 * Inicio del día calendario de Bogotá que contiene `now`, como instante UTC.
 * Colombia (America/Bogota) es UTC-5 fijo —sin horario de verano desde 1993—,
 * así que la medianoche local de un día `Y-M-D` es ese día a las 05:00Z.
 */
export function inicioDelDiaBogota(now: Date): Date {
  return new Date(`${fechaDiaBogota(now)}T05:00:00.000Z`);
}

/**
 * Próxima medianoche de Bogotá (cuándo se reinicia el conteo), como instante
 * UTC: el inicio del día de Bogotá + 24h.
 */
export function proximaMedianocheBogota(now: Date): Date {
  return new Date(inicioDelDiaBogota(now).getTime() + 24 * 60 * 60 * 1000);
}

/** Preguntas que le quedan al estudiante hoy (nunca negativo). */
export function restante(limite: number, usadas: number): number {
  return Math.max(0, limite - usadas);
}
