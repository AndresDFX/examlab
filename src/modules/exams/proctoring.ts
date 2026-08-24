/**
 * Proctoring helpers: warning types, human-readable labels, and the rule that
 * flips a submission into "sospechoso" when the warning count crosses the
 * configured threshold.
 *
 * Two sets of warning keys exist historically:
 *  - Spanish keys emitted by the student take flow ("pestaña", "copiar", ...)
 *  - English keys used by the monitor dialog ("blur", "copy", ...)
 * Both are mapped here so existing submissions render correctly.
 */

export const MAX_WARNINGS = 3;

export type WarningType =
  // Spanish keys (take flow)
  | "pestaña"
  | "copiar"
  | "pegar"
  | "cortar"
  | "menu"
  // English keys (historical / monitor)
  | "blur"
  | "visibility_hidden"
  | "fullscreen_exit"
  | "copy"
  | "paste"
  | "context_menu"
  // Soft signal: intento de pantallazo. NO suma strike — se registra
  // para que el docente lo vea en el monitor de advertencias.
  | "screenshot_attempt"
  | (string & {});

export interface WarningEvent {
  type: WarningType;
  /** ISO string or epoch ms — take flow writes ISO, older records wrote ms */
  at?: string | number;
  ts?: number;
  questionIdx?: number | null;
}

/** Human-readable Spanish label for a warning type. */
export function warningLabel(type: WarningType): string {
  switch (type) {
    case "pestaña":
    case "blur":
      return "Salida de pestaña/ventana";
    case "visibility_hidden":
      return "Pestaña oculta";
    case "fullscreen_exit":
      return "Salida de pantalla completa";
    case "copiar":
    case "copy":
      return "Intento de copiar";
    case "pegar":
    case "paste":
      return "Intento de pegar";
    case "cortar":
      return "Intento de cortar";
    case "menu":
    case "context_menu":
      return "Menú contextual";
    case "screenshot_attempt":
      return "Intento de pantallazo";
    default:
      return String(type);
  }
}

/**
 * ¿Este tipo de evento SUMÓ un strike al contador?
 *
 * `__warning_events` mezcla DOS clases de evento y eso no se ve en el array:
 *
 *   · Los que suman strike, que son EXACTAMENTE los tres con los que se llama
 *     `recordWarning` en la pantalla de toma: `pestaña`, `fullscreen_exit` y
 *     `visibility_hidden`.
 *   · Las señales BLANDAS, que se registran solo para que el docente las vea:
 *     `copiar`/`pegar`/`cortar` (por `recordCopyAlert`) y `screenshot_attempt`
 *     (por `recordScreenshotAttempt`). El comentario de esas funciones dice
 *     literal "NO suma strike" — antes sumaban y se cambió a pedido de varios
 *     docentes.
 *
 * Sin esta distinción, borrar una advertencia desde el monitor decrementaba el
 * contador para CUALQUIER evento: perdonar un "Intento de copiar" regalaba un
 * strike que nunca existió y, si eso bajaba del umbral, podía DES-SUSPENDER a
 * un alumno.
 *
 * Es una ALLOWLIST y no una denylist, a propósito. Un tipo desconocido —o uno
 * nuevo que alguien agregue mañana— cae a "no suma": el contador no baja y el
 * docente LO VE, y tiene "Limpiar todas" como salida. Con denylist, un tipo
 * blando nuevo caería a "suma" y el perdón de más sería invisible.
 *
 * Las claves históricas en inglés (`blur`, `copy`, `paste`, `context_menu`,
 * `menu`) quedan FUERA aunque alguna pudo haber sumado en su momento: se yerra
 * hacia no-perdonar, porque no perdonar es visible y tiene alternativa,
 * mientras que perdonar de más es invisible y toca el expediente del alumno.
 */
const TIPOS_QUE_SUMAN_STRIKE = new Set<string>([
  "pestaña",
  "fullscreen_exit",
  "visibility_hidden",
]);

export function isStrikeEvent(type: string | null | undefined): boolean {
  return !!type && TIPOS_QUE_SUMAN_STRIKE.has(type);
}

/**
 * Single source of truth for "is this submission suspicious?".
 * The UI shows warning N/MAX; a submission crosses into sospechoso at N >= MAX.
 */
export function shouldMarkSuspicious(warnings: number, max: number = MAX_WARNINGS): boolean {
  return warnings >= max;
}

/** Normalizes either `ev.at` (ISO/ms) or `ev.ts` (ms) to epoch ms for display. */
export function warningEventTimestamp(ev: WarningEvent): number | null {
  if (typeof ev.ts === "number") return ev.ts;
  if (typeof ev.at === "number") return ev.at;
  if (typeof ev.at === "string") {
    const n = Date.parse(ev.at);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}
