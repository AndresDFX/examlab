/**
 * Clasifica por qué falló una ejecución de código, para poder reaccionar
 * distinto según la causa en vez de mostrar el mensaje crudo del servidor.
 *
 * ── De dónde salen estas categorías ───────────────────────────────────
 * Del parcial del 2026-09-23, el examen más masivo con compilador que tuvo
 * la plataforma: 340 ejecuciones en 90 minutos, con picos de 11 por minuto.
 * Falló el 1,2% — cuatro veces, todas dentro de la misma ventana de seis
 * minutos, y por dos causas que **nunca habían aparecido** en los 50 fallos
 * previos del histórico (esos eran de configuración: credenciales sin poner,
 * una URL mal copiada). Estas dos son de CARGA:
 *
 *  · `No autenticado` (3 veces). No significa que el alumno no tuviera
 *    sesión: el edge valida el token llamando a `auth.getUser()`, o sea una
 *    ida a la red en el camino crítico del examen. Si esa llamada falla o el
 *    token venció justo ahí, el alumno ve «No autenticado» con su sesión
 *    perfectamente válida. Se refresca la sesión y se reintenta.
 *  · `not having enough compute resources` (1 vez). AWS Lambda se quedó sin
 *    capacidad concurrente. Es transitorio y se pasa solo: se reintenta tras
 *    una pausa corta, y si insiste se le dice al alumno que puede cambiar de
 *    compilador —la afordancia existe, pero nadie la descubre en mitad de un
 *    parcial si la pantalla no la nombra—.
 *
 * Lo que NO se reintenta: un error de compilación, un bucle infinito que
 * agotó el tiempo, un lenguaje no soportado. Ahí el problema es el código y
 * repetirlo da exactamente lo mismo, más ruido y más gasto.
 */

export type TipoDeFallo =
  /** La sesión no se pudo validar. Reintentable tras refrescarla. */
  | "sesion"
  /** El proveedor se quedó sin capacidad. Reintentable tras una pausa. */
  | "capacidad"
  /** Todo lo demás: el problema no se arregla repitiendo. */
  | "otro";

export function clasificarFalloDeEjecucion(mensaje: string | null | undefined): TipoDeFallo {
  const m = (mensaje ?? "").toLowerCase();
  if (!m) return "otro";
  // El tiempo agotado se mira ANTES que nada: su mensaje puede mencionar al
  // proveedor, y reintentar un bucle infinito es garantizar otro timeout.
  if (/tiempo de ejecuci|timed?\s*out|bucle infinito/.test(m)) return "otro";
  if (/no autenticado|not authenticated|jwt|unauthorized|401/.test(m)) return "sesion";
  if (/compute resources|too many requests|rate.?limit|throttl|429|503|service unavailable/.test(m)) {
    return "capacidad";
  }
  return "otro";
}

/** ¿Vale la pena repetir la ejecución tal cual? */
export function esReintentable(tipo: TipoDeFallo): boolean {
  return tipo === "sesion" || tipo === "capacidad";
}

/** Cuánto esperar antes de repetir. Refrescar la sesión es inmediato; que un
 *  proveedor saturado se libere, no. */
export function esperaAntesDeReintentar(tipo: TipoDeFallo): number {
  return tipo === "capacidad" ? 1200 : 0;
}
