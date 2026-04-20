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
    default:
      return String(type);
  }
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
