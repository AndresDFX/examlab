/**
 * Validación pura de rangos fecha/hora inicio → fin para los forms del front.
 *
 * Regla de negocio (goal #10): en TODO par INICIO + FIN la fecha/hora de fin
 * NO puede ser inferior a la de inicio; pueden ser IGUALES.
 *
 * `isValidDateRange` es deliberadamente tolerante con los valores faltantes:
 * si falta inicio o fin (null / "" / undefined) NO hay rango que validar, así
 * que devuelve `true` (el form decide aparte si los campos son requeridos).
 * Tampoco penaliza valores no parseables (NaN) — devuelve `true` para no
 * bloquear por un dato malo que otra validación atrapará.
 *
 * Compara por timestamp (`new Date(x).getTime()`), NO lexicográficamente, para
 * tolerar pares donde un extremo viene como ISO de la DB (`...T08:00:00+00:00`)
 * y el otro como el formato del DateTimePicker (`YYYY-MM-DDTHH:MM`) — caso real
 * al editar (el form arranca con el valor crudo de la DB y solo se reescribe al
 * formato del picker cuando el docente toca ese campo). Para que la comparación
 * sea coherente, en cada form pasar AMBOS extremos en el mismo "espacio": o los
 * dos crudos del form, o los dos ya normalizados a ISO antes de persistir.
 *
 * Acepta lo que producen los inputs nativos / DateTimePicker (`YYYY-MM-DD`,
 * `YYYY-MM-DDTHH:MM`), ISO completo, `Date`, o timestamps numéricos.
 */
export type DateRangeInput = string | number | Date | null | undefined;

/** Convierte el input a ms epoch, o NaN si está vacío/nullish/no parseable. */
function toMs(value: DateRangeInput): number {
  if (value == null || value === "") return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}

/**
 * `true` si el rango es válido: falta alguno de los extremos (nada que validar),
 * alguno no parsea, o `end >= start` (iguales permitido). `false` SOLO cuando
 * ambos están presentes, parsean, y `end < start`.
 */
export function isValidDateRange(start: DateRangeInput, end: DateRangeInput): boolean {
  const s = toMs(start);
  const e = toMs(end);
  if (Number.isNaN(s) || Number.isNaN(e)) return true;
  return e >= s;
}

// ──────────────────────────────────────────────────────────────────────
// Tope de la fecha FIN de una actividad a la fecha FIN de su curso.
//
// Regla (goal): si una actividad (examen/taller/proyecto) está asociada a un
// curso con fecha fin, su fecha fin NUNCA debe superar la del curso. Al elegir
// el curso en el form se topa automáticamente; si ya era menor, se deja igual.
// Esto NO reemplaza la validación inicio < fin (esa sigue aplicando aparte).
//
// `courses.end_date` es una columna DATE (`YYYY-MM-DD`, sin hora). La
// interpretamos como el FIN de ese día en hora LOCAL (es-CO) — coherente con el
// resto de la app, que formatea/compara en local. Así "vence el 30 sep" admite
// una actividad que cierra el 30 sep 23:59 pero no el 1 oct 00:00.
// ──────────────────────────────────────────────────────────────────────

/** `YYYY-MM-DDTHH:MM` en hora LOCAL — el formato que consume `<input
 *  type="datetime-local">` / `DateTimePicker`. */
function toLocalDatetimeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Instante (Date local) del FIN del día de `courseEnd`. Para un DATE puro
 * (`YYYY-MM-DD`) devuelve ese día a las 23:59 local; si trae hora, la respeta.
 * `null` si está vacío o no parsea.
 */
export function courseEndOfDay(courseEnd: DateRangeInput): Date | null {
  if (courseEnd == null || courseEnd === "") return null;
  if (typeof courseEnd === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(courseEnd.trim());
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 0, 0);
  }
  const ms = toMs(courseEnd);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Topa `activityEnd` (valor del input, normalmente `YYYY-MM-DDTHH:MM` local) al
 * fin de día de `courseEnd`. Devuelve:
 *   • el valor original sin tocar si no hay courseEnd, si la actividad no tiene
 *     fin, o si su fin ya está dentro del curso;
 *   • el fin de día del curso en formato `YYYY-MM-DDTHH:MM` local si lo excede.
 */
export function capEndToCourseEnd(
  activityEnd: string | null | undefined,
  courseEnd: DateRangeInput,
): string {
  const current = activityEnd ?? "";
  const max = courseEndOfDay(courseEnd);
  if (!max) return current;
  const curMs = toMs(current);
  if (Number.isNaN(curMs) || curMs <= max.getTime()) return current;
  return toLocalDatetimeInput(max);
}

/**
 * De una lista de `end_date` de cursos, devuelve el `end_date` (crudo) del que
 * termina ANTES — para que la actividad multi-curso quepa dentro de TODOS. Los
 * vacíos/no parseables se ignoran. `null` si ninguno sirve.
 */
export function earliestCourseEnd(ends: Array<DateRangeInput>): string | null {
  let best: { ms: number; raw: string } | null = null;
  for (const e of ends) {
    const d = courseEndOfDay(e);
    if (!d) continue;
    if (best === null || d.getTime() < best.ms) {
      best = { ms: d.getTime(), raw: typeof e === "string" ? e : toLocalDatetimeInput(d) };
    }
  }
  return best ? best.raw : null;
}
