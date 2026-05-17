/**
 * Builder de archivos .ics (iCalendar RFC 5545).
 *
 * Pure function — sin acceso a red, sin Date.now() interno, sin
 * dependencias. Toda la entrada es explícita para que sea testeable.
 *
 * Decisiones:
 *  - Todas las fechas se serializan en UTC con sufijo Z. Los clientes
 *    (Google/Apple/Outlook) las convierten a la zona del usuario.
 *  - Eventos sin hora (talleres/proyectos con due_date pero sin hora
 *    específica) se emiten como ALL-DAY usando DATE en vez de DATETIME.
 *  - El folding de líneas a 75 octetos se hace al final, no a mano por
 *    cada campo.
 *  - UID es estable por evento (no aleatorio) para que el cliente
 *    detecte updates en vez de duplicar.
 *
 * Compartido entre el edge function (Deno) y los tests del cliente.
 * No usar APIs del DOM ni de Node.
 */

export interface IcsEvent {
  /**
   * Identificador único estable para el evento. Sugerido:
   *   `${kind}-${id}@examlab` (ej: `exam-uuid@examlab`).
   * Si cambian start/summary, manda el MISMO uid para que el cliente
   * actualice el evento existente.
   */
  uid: string;
  /** Resumen corto (1ra línea del evento). */
  summary: string;
  /** Descripción larga (multilínea OK). */
  description?: string;
  /** Inicio. Si `allDay=true`, se serializa como DATE (yyyymmdd). */
  start: Date;
  /** Fin. Para all-day, debe ser el día SIGUIENTE (convención iCal). */
  end?: Date;
  /** Si true, evento de día completo (sin hora). */
  allDay?: boolean;
  /** URL opcional asociada al evento (ej: link a la entrega). */
  url?: string;
  /** Ubicación física o virtual (meeting_url para sesiones). */
  location?: string;
  /** Categoría/clasificación para el cliente (ej: "EXAM"). */
  category?: string;
}

export interface BuildIcsOptions {
  /** Nombre del calendario que se muestra en el cliente. */
  calendarName: string;
  /** Identificador del producto (RFC 5545 §3.7.3). */
  prodId?: string;
  /** Zona horaria del usuario (informativa; las fechas siguen en UTC). */
  timezone?: string;
  events: readonly IcsEvent[];
  /** Fecha de generación (DTSTAMP). Inyectable para tests. */
  now?: Date;
}

/**
 * Construye el texto completo del archivo .ics.
 * Salida: string con CRLF (RFC 5545) y line-folding.
 */
export function buildIcs(opts: BuildIcsOptions): string {
  const prodId = opts.prodId ?? "-//ExamLab//ES";
  const now = opts.now ?? new Date();
  const tz = opts.timezone ?? "America/Bogota";

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${prodId}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(opts.calendarName)}`,
    `X-WR-TIMEZONE:${tz}`,
    `NAME:${escapeText(opts.calendarName)}`,
  ];

  for (const ev of opts.events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.uid}`);
    lines.push(`DTSTAMP:${formatUtc(now)}`);
    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${formatDate(ev.start)}`);
      if (ev.end) {
        lines.push(`DTEND;VALUE=DATE:${formatDate(ev.end)}`);
      }
    } else {
      lines.push(`DTSTART:${formatUtc(ev.start)}`);
      if (ev.end) {
        lines.push(`DTEND:${formatUtc(ev.end)}`);
      }
    }
    lines.push(`SUMMARY:${escapeText(ev.summary)}`);
    if (ev.description) {
      lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
    }
    if (ev.url) {
      lines.push(`URL:${ev.url}`);
    }
    if (ev.location) {
      lines.push(`LOCATION:${escapeText(ev.location)}`);
    }
    if (ev.category) {
      lines.push(`CATEGORIES:${ev.category}`);
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  // Line folding RFC 5545: max 75 octets por línea; continuación con
  // espacio inicial. Aplicamos al final para no tener que pensar en
  // cada campo individualmente.
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Formatea Date a "yyyymmddThhmmssZ" en UTC. */
export function formatUtc(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mi = d.getUTCMinutes().toString().padStart(2, "0");
  const ss = d.getUTCSeconds().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

/** Formatea Date a "yyyymmdd" (para all-day events). */
export function formatDate(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/**
 * Escape de texto según RFC 5545 §3.3.11:
 *   - `\\` → `\\\\`
 *   - `;`  → `\\;`
 *   - `,`  → `\\,`
 *   - newlines (LF) → `\\n`
 */
export function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\n");
}

/**
 * Folding a max 75 octetos. Cuenta por bytes UTF-8 (no por chars).
 * Continuación con espacio inicial (RFC 5545 §3.1).
 */
export function foldLine(line: string): string {
  const MAX = 75;
  // Encode una sola vez para contar bytes y luego cortar por bytes.
  const enc = new TextEncoder();
  const bytes = enc.encode(line);
  if (bytes.length <= MAX) return line;

  const dec = new TextDecoder();
  const chunks: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + MAX, bytes.length);
    // Asegurar que no cortamos a mitad de un char UTF-8: si el byte
    // siguiente es continuación (10xxxxxx), retrocedemos.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push(dec.decode(bytes.subarray(start, end)));
    start = end;
  }
  return chunks.join("\r\n ");
}
