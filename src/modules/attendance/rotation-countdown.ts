/**
 * Cuenta atrás a la próxima rotación del código de check-in, en palabras.
 *
 * ── Qué arregla ───────────────────────────────────────────────────────
 * La proyección decía literalmente **"Rota en 84797s"**. Son 23 horas y media,
 * escritas en una unidad que nadie convierte de cabeza, en la pantalla que está
 * al frente del salón. Y el problema no es la estética: un número de cinco
 * dígitos ahí hace pensar que algo está mal configurado.
 *
 * Pasó a existir cuando el check-in dejó de tener un tope de minutos y aceptó
 * ventanas de días con rotación de hasta 24 h: el `{{seconds}}s` alcanzaba
 * cuando el máximo eran 600 segundos.
 *
 * PURO: sin `Date.now()`, sin i18n. Devuelve las PARTES y el caller las traduce
 * — así los tests no dependen de las claves de traducción.
 */

export interface PartesCuentaAtras {
  /** Unidad más grande que aplica. */
  unidad: "hours" | "minutes" | "seconds";
  /** Valor de esa unidad, ya redondeado para mostrar. */
  valor: number;
}

/**
 * Elige la unidad legible para una cuenta atrás en segundos.
 *
 * El corte es por LEGIBILIDAD, no por exactitud: a más de una hora, los
 * segundos exactos no le sirven a nadie —el código va a rotar cuando la clase
 * ya terminó—, y a menos de un minuto los segundos son justo lo que importa,
 * porque alguien está tecleando el código en ese momento.
 *
 * Se REDONDEA HACIA ARRIBA en horas y minutos. Con `floor`, 119 segundos se
 * mostraría como "1 minuto" y el código rotaría cuando el cartel todavía dice
 * que falta un minuto; con `ceil` el cartel nunca promete menos tiempo del que
 * hay.
 */
export function partesCuentaAtras(segundos: number | null | undefined): PartesCuentaAtras {
  const s = Math.max(0, Math.floor(Number(segundos) || 0));
  if (s >= 3600) return { unidad: "hours", valor: Math.ceil(s / 3600) };
  if (s >= 60) return { unidad: "minutes", valor: Math.ceil(s / 60) };
  return { unidad: "seconds", valor: s };
}
