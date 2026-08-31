/**
 * ¿Este Enter ENVÍA, o solo baja un renglón?
 *
 * En una caja de texto que se envía con Enter, el salto de línea es Shift+Enter.
 * La regla parece trivial y por eso se reimplementa a mano en cada composer —
 * hasta que a alguno se le olvida el `!e.shiftKey` y esa caja deja de poder
 * escribir más de un renglón. Pasó en el generador de SQL de la pizarra: su
 * manejador hacía `preventDefault()` en CUALQUIER Enter, así que Shift+Enter
 * enviaba en vez de bajar. Por eso la regla vive acá y no en cada pantalla.
 *
 * ── Dos cosas que no son obvias ──────────────────────────────────────────
 *
 *  - **Durante la composición de un IME, Enter NO envía.** Quien escribe en
 *    japonés/chino/coreano pulsa Enter para CONFIRMAR el candidato que el IME
 *    propone; si eso enviara, el mensaje se iría a mitad de una palabra y sin
 *    forma de evitarlo. El navegador lo avisa con `isComposing` en el evento
 *    nativo, y es el único modo de distinguirlo.
 *
 *  - **No se miran Ctrl/Cmd/Alt.** En las cajas que envían con Enter, Ctrl+Enter
 *    también envía (es lo que ya hacían el asistente y el tutor, y quien viene
 *    de las cajas que envían con Ctrl+Enter lo intenta por costumbre). Agregar
 *    `&& !e.ctrlKey` haría que ese atajo dejara de hacer nada, que es peor que
 *    enviar.
 *
 * Para las cajas donde el envío es Ctrl/Cmd+Enter y Enter siempre baja renglón
 * (mensajes, comentarios de retroalimentación, soporte) esto NO aplica: ahí el
 * manejador pregunta por el modificador y el Enter pelado no se toca.
 */

/** Lo mínimo de un evento de teclado para decidir. Un `React.KeyboardEvent` lo cumple. */
export type EventoDeTecla = {
  key?: string;
  shiftKey?: boolean;
  nativeEvent?: { isComposing?: boolean } | null;
};

export function enterEnvia(e: EventoDeTecla): boolean {
  // `key` puede llegar `undefined` en eventos sintéticos: se compara sin
  // normalizar, así que un undefined simplemente no matchea.
  if (e.key !== "Enter") return false;
  if (e.shiftKey) return false;
  if (e.nativeEvent?.isComposing) return false;
  return true;
}
