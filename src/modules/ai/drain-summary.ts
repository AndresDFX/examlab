/**
 * Resumen del drenaje de las colas de IA ("Procesar todas").
 *
 * Existe por un defecto medido: el panel acumulaba los pendientes con
 * `remaining = g?.remainingPending ?? 0` leyendo SOLO la respuesta del worker
 * de CALIFICACIÓN. El de generación no devolvía ese campo, así que con la cola
 * de generación llena el bucle cortaba en la primera pasada y el toast decía
 * "Listo: procesadas 0. No quedan tareas en espera." — un éxito que no hizo
 * nada, que es peor que un error.
 *
 * Todo acá es puro (sin React, sin red) para poder fijar por test la regla que
 * se violó: ningún resultado con `procesadas === 0` sale en tono de éxito.
 */

export interface RespuestaDeDrenaje {
  processed?: number | null;
  failed?: number | null;
  remainingPending?: number | null;
  deferred?: number | null;
  deferredIncluded?: number | null;
  includeDeferredIgnored?: boolean;
}

export interface ResumenDeDrenaje {
  procesadas: number;
  fallidas: number;
  /** Pendientes que quedan en las DOS colas, según la ÚLTIMA pasada. */
  pendientes: number;
  /** Pendientes que quedaron sin tocar porque su institución los difiere. */
  diferidas: number;
  /** Procesadas que se habrían excluido de no pedirlo explícitamente. */
  diferidasIncluidas: number;
  /** El flag llegó de alguien sin permiso de gestión y se ignoró. */
  flagIgnorado: boolean;
  /**
   * ¿Algún worker reportó cuántos pendientes quedan? El panel y las edge se
   * despliegan por separado, así que existe una ventana en la que el panel ya
   * está vivo y el worker viejo NO devuelve `remainingPending`. Contarlo como 0
   * dispara «No había tareas en espera» con la cola llena — la misma frase
   * falsa que este módulo vino a eliminar. Sin dato se dice que no se pudo
   * confirmar, no se inventa un cero.
   */
  pendientesConocidas: boolean;
}

export const RESUMEN_VACIO: ResumenDeDrenaje = {
  procesadas: 0,
  fallidas: 0,
  pendientes: 0,
  diferidas: 0,
  diferidasIncluidas: 0,
  flagIgnorado: false,
  pendientesConocidas: false,
};

const num = (v: number | null | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Acumula una pasada del bucle. `procesadas` / `fallidas` se SUMAN (cada pasada
 * reporta trabajos distintos: uno que ya falló sale de 'pending'), pero
 * `pendientes` es una FOTO — se reemplaza por el último valor de las dos colas,
 * no se suma. Un worker viejo que no devuelva `remainingPending` cuenta 0: no se
 * inventan pendientes que no se pueden medir.
 */
export function acumularPasada(
  prev: ResumenDeDrenaje,
  pasada: {
    calificacion: RespuestaDeDrenaje | null | undefined;
    generacion: RespuestaDeDrenaje | null | undefined;
  },
): ResumenDeDrenaje {
  const c = pasada.calificacion ?? {};
  const g = pasada.generacion ?? {};
  return {
    procesadas: prev.procesadas + num(c.processed) + num(g.processed),
    fallidas: prev.fallidas + num(c.failed) + num(g.failed),
    pendientes: num(c.remainingPending) + num(g.remainingPending),
    diferidas: num(c.deferred) + num(g.deferred),
    diferidasIncluidas:
      prev.diferidasIncluidas + num(c.deferredIncluded) + num(g.deferredIncluded),
    flagIgnorado:
      prev.flagIgnorado || c.includeDeferredIgnored === true || g.includeDeferredIgnored === true,
    pendientesConocidas:
      typeof c.remainingPending === "number" || typeof g.remainingPending === "number",
  };
}

export type MotivoDeCorte = "listo" | "sin-progreso" | "reintentos-agotados" | "continuar";

export function decidirCorte(
  r: ResumenDeDrenaje,
  ctx: { intento: number; maxIntentos: number; pendientesPrevios: number },
): MotivoDeCorte {
  if (r.pendientes === 0) return "listo";
  if (ctx.intento >= ctx.maxIntentos) return "reintentos-agotados";
  // La pasada no redujo los pendientes → reintentar no ayuda.
  if (r.pendientes >= ctx.pendientesPrevios) return "sin-progreso";
  return "continuar";
}

export interface MensajeDeDrenaje {
  clave: string;
  tono: "success" | "warning" | "info";
  valores: Record<string, number>;
}

/**
 * Qué toast mostrar. Devuelve la clave i18n, el tono y los valores de
 * interpolación — el caller agrega el sufijo de errores y llama a `toast[tono]`.
 */
export function mensajeDeDrenaje(
  r: ResumenDeDrenaje,
  motivo: MotivoDeCorte,
): MensajeDeDrenaje {
  const valores = {
    n: r.procesadas,
    remaining: r.pendientes,
    diferidas: r.diferidas > 0 ? r.diferidas : r.diferidasIncluidas,
  };
  if (r.pendientes > 0 && motivo !== "listo") {
    // Nada se procesó y lo que queda es diferido: el usuario tiene que saber
    // que su institución está configurada para más tarde, y por dónde cambiarlo.
    if (r.procesadas === 0 && r.diferidas > 0) {
      return { clave: "drainDeferredOnly", tono: "warning", valores };
    }
    return { clave: "drainExhausted", tono: "warning", valores };
  }
  if (r.procesadas === 0) {
    // "No había nada en espera" ≠ "procesé 0".
    if (r.diferidas > 0) return { clave: "drainDeferredOnly", tono: "warning", valores };
    // Sin `remainingPending` de ningún worker no se sabe si la cola está vacía.
    if (!r.pendientesConocidas) {
      return { clave: "drainPendingUnknown", tono: "warning", valores };
    }
    return { clave: "drainNothingToDo", tono: "info", valores };
  }
  if (r.diferidasIncluidas > 0) {
    return { clave: "drainDoneWithDeferred", tono: "success", valores };
  }
  return { clave: "drainDone", tono: "success", valores };
}
