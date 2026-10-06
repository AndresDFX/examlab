/**
 * Lo que el proyector del check-in muestra sobre el CIERRE de la ventana.
 *
 * Un cartel redondeado a horas enteras ("Cierra en 7 horas") no sirve acá: los
 * botones +5 / +10 / +15 se guardaban pero no movían nada en pantalla, porque
 * 6 h 02 min y 6 h 17 min se leen igual. Por eso son dos datos, y los dos
 * cambian con cada +5:
 *
 *  - un reloj que baja cada segundo (`relojDeCierre`), para el salón, y
 *  - la hora exacta de cierre (`horaDeCierre`), al lado de los botones, que es
 *    justo lo que el docente está moviendo.
 *
 * PURO: sin `Date.now()` adentro ni i18n. El que llama pasa la hora actual y
 * traduce los días.
 */

export interface RelojDeCierre {
  /** Días enteros que quedan; 0 si falta menos de un día. */
  dias: number;
  /** El resto como reloj: "6:00:12", "59:07", o "03:59:12" cuando hay días. */
  reloj: string;
}

const dos = (n: number) => String(n).padStart(2, "0");

export function relojDeCierre(msRestantes: number): RelojDeCierre {
  // `floor` y no `ceil`: es un reloj que baja segundo a segundo, y tiene que
  // llegar a 0:00 justo cuando la ventana se cierra, no un segundo antes.
  const total = Math.max(0, Math.floor((Number(msRestantes) || 0) / 1000));
  const dias = Math.floor(total / 86400);
  const resto = total % 86400;
  const h = Math.floor(resto / 3600);
  const m = Math.floor((resto % 3600) / 60);
  const s = resto % 60;
  // Con días delante, las horas van con dos dígitos para que el reloj no
  // cambie de ancho al pasar de 10 a 9 horas.
  if (dias > 0) return { dias, reloj: `${dos(h)}:${dos(m)}:${dos(s)}` };
  if (h > 0) return { dias: 0, reloj: `${h}:${dos(m)}:${dos(s)}` };
  return { dias: 0, reloj: `${m}:${dos(s)}` };
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
