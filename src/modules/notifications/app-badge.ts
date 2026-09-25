/**
 * La insignia con el número de avisos sin leer sobre el ícono de la app
 * instalada (Badging API).
 *
 * Qué resuelve: hoy el conteo de no leídas solo existe DENTRO de la app, en la
 * campanita. Con la PWA cerrada —que es como está el 99% del tiempo— no hay
 * ninguna señal de que hay algo pendiente, salvo la notificación push del
 * momento, que se descarta de un manotazo y no deja rastro. La insignia es la
 * única pista persistente.
 *
 * Tres cosas que hay que saber antes de tocar esto:
 *
 *  - **Chrome para Android NO la implementa**, y eso hay que tenerlo presente
 *    antes de prometer la insignia: es el navegador de la mayoría de los
 *    estudiantes. Verificado contra la tabla de compatibilidad — «Chrome for
 *    Android: not supported», igual que Samsung Internet. Donde SÍ existe:
 *    Chrome/Edge de escritorio (81+) y Safari en iOS desde 16.4, con la app
 *    agregada a la pantalla de inicio y permiso de notificaciones.
 *  - En Android lo que se ve es el PUNTO de notificación del sistema, que
 *    depende de que haya una notificación sin descartar — no del número de no
 *    leídas. Son dos mecanismos distintos y este módulo no puede dar el
 *    segundo donde el navegador no lo ofrece.
 *  - Devuelve una promesa que RECHAZA (no lanza en línea), por ejemplo cuando
 *    el documento todavía no tiene un service worker controlándolo. Un rechazo
 *    sin `catch` sale por `unhandledrejection`, y este proyecto lo audita: se
 *    convertiría en ruido en `audit_logs`, que es justo lo que filtra
 *    `isBrowserNoise`. Por eso todo va con `catch` que traga.
 *  - Poner 0 NO limpia la insignia: según la especificación, `setAppBadge(0)`
 *    la borra, pero varias implementaciones muestran un punto. Para "no hay
 *    nada" se usa `clearAppBadge()`, que es explícito.
 *
 * Sin React y con el `navigator` inyectable → testeable.
 */

/** Lo mínimo que este módulo necesita del `navigator`. */
export interface NavegadorConInsignia {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

/** ¿Este aparato sabe dibujar la insignia? */
export function soportaInsignia(nav: NavegadorConInsignia | undefined | null): boolean {
  return typeof nav?.setAppBadge === "function" && typeof nav?.clearAppBadge === "function";
}

/**
 * Qué hay que hacer para reflejar `sinLeer`: poner el número, o limpiar.
 *
 * Se devuelve la DECISIÓN y no el efecto para poder fijarla con tests sin
 * tener que simular un `navigator` entero.
 */
export function decidirInsignia(sinLeer: number): { accion: "poner"; valor: number } | { accion: "limpiar" } {
  // Un conteo negativo o basura se trata como "nada pendiente" en vez de
  // propagar el disparate al sistema operativo.
  if (!Number.isFinite(sinLeer) || sinLeer <= 0) return { accion: "limpiar" };
  return { accion: "poner", valor: Math.floor(sinLeer) };
}

/**
 * Aplica el conteo sobre el ícono de la app. No hace nada —sin error— donde la
 * API no exista.
 */
export async function aplicarInsignia(
  sinLeer: number,
  nav: NavegadorConInsignia | undefined | null = typeof navigator !== "undefined" ? navigator : null,
): Promise<void> {
  if (!soportaInsignia(nav)) return;
  const d = decidirInsignia(sinLeer);
  try {
    if (d.accion === "limpiar") await nav!.clearAppBadge!();
    else await nav!.setAppBadge!(d.valor);
  } catch {
    // Permiso denegado, sin service worker controlando, o una implementación
    // a medias. No hay nada que el usuario pueda hacer y tampoco es un fallo
    // de la app: la insignia es un adorno, no una función.
  }
}
