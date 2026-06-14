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
