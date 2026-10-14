/**
 * Lo que el proyector del check-in muestra sobre el CIERRE de la ventana.
 *
 * Un cartel redondeado a horas enteras ("Cierra en 7 horas") no sirve acá: los
 * botones +5 / +10 / +15 se guardaban pero no movían nada en pantalla, porque
 * 6 h 02 min y 6 h 17 min se leen igual. Por eso son dos datos, y los dos
 * cambian con cada +5:
 *
 *  - lo que le queda a la ventana (`relojDeCierre`), para el salón, y
 *  - la hora exacta de cierre (`horaDeCierre`), al lado de los botones, que es
 *    justo lo que el docente está moviendo.
 *
 * El tiempo restante va CON UNIDADES ("5 h 58 min"), no como reloj. Como reloj
 * («5:58:36») no decía si eran horas o minutos, y al lado del «El código cambia
 * en 2 minutos» se leía como otra cuenta de minutos (reportado el 2026-10-13).
 * Con minutos de precisión cada +5 se sigue viendo: 5 h 58 min pasa a 6 h 3 min.
 *
 * PURO: sin `Date.now()` adentro ni i18n. El que llama pasa la hora actual y
 * traduce los días; "h", "min" y "s" se escriben igual en español y en inglés.
 */

export interface RelojDeCierre {
  /** Días enteros que quedan; 0 si falta menos de un día. */
  dias: number;
  /**
   * El resto, con unidades: "5 h 58 min", "6 h", "59 min" o, en el último
   * minuto, "45 s". Vacío cuando quedan días exactos (lo dicen los días).
   */
  reloj: string;
}

export function relojDeCierre(msRestantes: number): RelojDeCierre {
  // `floor` y no `ceil`: es un plazo para el salón, y nunca puede prometer más
  // tiempo del que queda. «4 min» con 4:59 por delante apura de más; «5 min»
  // con 4:01 haría llegar tarde a alguien. La cuenta del código (rotation-countdown.ts)
  // redondea al revés A PROPÓSITO: ahí lo caro es que el código cambie antes de lo
  // anunciado mientras alguien lo teclea.
  const total = Math.max(0, Math.floor((Number(msRestantes) || 0) / 1000));
  const dias = Math.floor(total / 86400);
  const resto = total % 86400;
  const h = Math.floor(resto / 3600);
  const m = Math.floor((resto % 3600) / 60);
  const s = resto % 60;
  if (h > 0) return { dias, reloj: m > 0 ? `${h} h ${m} min` : `${h} h` };
  if (m > 0) return { dias, reloj: `${m} min` };
  // Los segundos solo en el último minuto, y nunca detrás de días.
  return { dias, reloj: dias > 0 ? "" : `${s} s` };
}

/** True si las dos fechas caen el mismo día del calendario LOCAL. */
export function mismoDiaLocal(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * La hora de cierre, con la fecha delante solo cuando NO es hoy: "01:59" o
 * "06 oct, 01:59". Sin la fecha, un check-in que cierra pasada la medianoche
 * diría "01:59" y se leería como hace unas horas.
 */
export function horaDeCierre(
  cierre: Date,
  ahora: Date,
  fmt: { hora: (d: Date) => string; dia: (d: Date) => string },
): string {
  return mismoDiaLocal(cierre, ahora) ? fmt.hora(cierre) : `${fmt.dia(cierre)}, ${fmt.hora(cierre)}`;
}
