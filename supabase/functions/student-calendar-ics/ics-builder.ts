// Copia del builder en src/lib/ics-builder.ts.
//
// Deno no puede importar de `../../../src/`, así que mantenemos esta
// copia en sync manualmente. Los tests de la suite del cliente
// (vitest) cubren el comportamiento — si cambias algo acá, sincroniza
// con src/lib/ics-builder.ts.

export interface IcsEvent {
  uid: string;
  summary: string;
  description?: string;
  start: Date;
  end?: Date;
  allDay?: boolean;
  url?: string;
  location?: string;
  category?: string;
}

export interface BuildIcsOptions {
  calendarName: string;
  prodId?: string;
  timezone?: string;
  events: readonly IcsEvent[];
  now?: Date;
}

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
      if (ev.end) lines.push(`DTEND;VALUE=DATE:${formatDate(ev.end)}`);
    } else {
      lines.push(`DTSTART:${formatUtc(ev.start)}`);
      if (ev.end) lines.push(`DTEND:${formatUtc(ev.end)}`);
    }
    lines.push(`SUMMARY:${escapeText(ev.summary)}`);
    if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
    if (ev.url) lines.push(`URL:${ev.url}`);
    if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
    if (ev.category) lines.push(`CATEGORIES:${ev.category}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  return lines.map(foldLine).join("\r\n") + "\r\n";
}

export function formatUtc(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mi = d.getUTCMinutes().toString().padStart(2, "0");
  const ss = d.getUTCSeconds().toString().padStart(2, "0");
  return `${y}${m}${dd}T${hh}${mi}${ss}Z`;
}

export function formatDate(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${dd}`;
}

export function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\n");
}

export function foldLine(line: string): string {
  const MAX = 75;
  const enc = new TextEncoder();
  const bytes = enc.encode(line);
  if (bytes.length <= MAX) return line;

  const dec = new TextDecoder();
  const chunks: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + MAX, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push(dec.decode(bytes.subarray(start, end)));
    start = end;
  }
  return chunks.join("\r\n ");
}
