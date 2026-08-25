/**
 * Ventana por defecto del check-in de asistencia. PURO y sin `Date.now()`
 * implícito: el "ahora" entra por parámetro.
 *
 * ── Por qué un módulo y no dos líneas en el componente ────────────────
 * Porque la conversión a la cadena que consume `DateTimePicker`
 * (`yyyy-MM-ddTHH:mm`) es justo donde este proyecto ya se quemó dos veces con
 * las zonas horarias. `toISOString()` devuelve UTC: en Colombia (UTC-5) eso
 * pondría la apertura CINCO HORAS ADELANTE de lo que el docente ve en su reloj,
 * y como el picker no muestra la zona, nadie lo notaría hasta que un alumno
 * dijera que el check-in "todavía no empezó". Hay que armar la cadena con los
 * getters LOCALES, y eso merece un test.
 *
 * ── Por qué el "ahora" es un parámetro ────────────────────────────────
 * Para poder testear el resultado exacto. Un `Date.now()` adentro haría que el
 * test dependa del momento en que corre, que es la clase de test que se ignora
 * cuando falla.
 */

/** Horas de ventana por defecto cuando la institución no configuró otra cosa. */
export const CHECKIN_DEFAULT_WINDOW_HOURS = 6;

/** Tope de la ventana por defecto configurable (una semana). Ver `clampWindowHours`. */
export const CHECKIN_MAX_WINDOW_HOURS = 168;

/**
 * `Date` → `yyyy-MM-ddTHH:mm` en hora LOCAL, el formato de `DateTimePicker`.
 *
 * Deliberadamente NO usa `toISOString().slice(0,16)`: eso da UTC y correría la
 * hora tantas horas como el desfase del navegador.
 */
export function toLocalDateTimeInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/**
 * Acota las horas configuradas a algo razonable.
 *
 * `null`/`undefined`/basura ⇒ el default. Un valor absurdo no se rechaza con un
 * error: se acota, porque esto alimenta un formulario y dejarlo vacío sería peor
 * que dejarlo con la ventana estándar.
 */
export function clampWindowHours(horas: unknown): number {
  const n = Number(horas);
  if (!Number.isFinite(n) || n <= 0) return CHECKIN_DEFAULT_WINDOW_HOURS;
  return Math.min(CHECKIN_MAX_WINDOW_HOURS, Math.max(1, Math.round(n * 100) / 100));
}

export interface VentanaPorDefecto {
  /** Apertura: el ahora recibido, al minuto. */
  opensAt: string;
  /** Cierre: apertura + las horas configuradas. */
  closesAt: string;
}

/**
 * Ventana sugerida al abrir el diálogo: desde AHORA hasta ahora + N horas.
 *
 * Se rellenan las dos fechas en vez de dejarlas vacías porque una ventana
 * invisible es una ventana que nadie revisa: el docente abría el check-in sin
 * saber cuándo cerraba, y descubría el default de 10 minutos cuando ya se había
 * cerrado solo. Prellenadas, quedan a la vista y se pueden cambiar.
 *
 * Los segundos se descartan (el picker trabaja al minuto), así que la ventana es
 * exactamente de N horas entre los dos valores que el docente ve.
 */
export function defaultCheckinWindow(ahora: Date, horas: unknown): VentanaPorDefecto {
  const h = clampWindowHours(horas);
  const abre = new Date(ahora.getTime());
  abre.setSeconds(0, 0);
  const cierra = new Date(abre.getTime() + h * 3600 * 1000);
  return { opensAt: toLocalDateTimeInput(abre), closesAt: toLocalDateTimeInput(cierra) };
}

/**
 * Recalcula el cierre cuando el docente mueve la apertura, manteniendo las horas
 * configuradas. Devuelve `null` si la apertura no es una fecha usable — el
 * caller deja el cierre como estaba en vez de borrarlo.
 */
export function recomputeClosesAt(opensAtLocal: string, horas: unknown): string | null {
  if (!opensAtLocal) return null;
  const abre = new Date(opensAtLocal);
  if (Number.isNaN(abre.getTime())) return null;
  const h = clampWindowHours(horas);
  return toLocalDateTimeInput(new Date(abre.getTime() + h * 3600 * 1000));
}
