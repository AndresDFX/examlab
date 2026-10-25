/**
 * Identificación de hablantes y extracción del texto del DOCENTE a partir de
 * una transcripción WebVTT de Teams.
 *
 * PURO a propósito — sin `Deno`, sin DOM, sin crypto — para poder testearlo
 * bajo vitest importándolo por ruta relativa desde `src/`. Es la ÚNICA copia:
 * el edge `calendar` lo importa desde `../_shared/transcript-speakers.ts` y el
 * test `src/modules/calendar/transcript-speakers.test.ts` por su ruta relativa.
 *
 * Los hablantes del VTT son NOMBRES PARA MOSTRAR de Teams (p. ej.
 * «JULIAN ANDRES CASTAÑO ESPINOSA»). No hay un id estable, así que la
 * decisión de quién es el docente es por NOMBRE: el edge preselecciona por
 * coincidencia con el full_name del docente y la UI deja corregir.
 */
import { parseVtt } from "./vtt-transcript.ts";

/** Normaliza un nombre: minúsculas, sin acentos, espacios colapsados. */
export function normalizarNombre(s: string): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalizarNombre(s).split(" ").filter(Boolean);
}

/** Hablantes detectados en el VTT, únicos y en orden de aparición. */
export function detectSpeakers(vtt: string): string[] {
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const cue of parseVtt(vtt)) {
    if (!cue.speaker) continue;
    const key = normalizarNombre(cue.speaker);
    if (!key || vistos.has(key)) continue;
    vistos.add(key);
    out.push(cue.speaker.trim());
  }
  return out;
}

/**
 * ¿Es el `speaker` del VTT la misma persona que `fullName`? Conservador para
 * no atribuirle al docente lo que dijo un estudiante homónimo:
 *  - un solo token (p. ej. «Ana») exige coincidencia EXACTA normalizada;
 *  - con ≥2 tokens, todos los tokens del nombre más corto deben estar en el
 *    más largo. Así «Julián Castaño» ⊆ «Julian Andres Castaño Espinosa».
 */
export function nombreCoincide(speaker: string, fullName: string): boolean {
  const a = tokens(speaker);
  const b = tokens(fullName);
  if (a.length === 0 || b.length === 0) return false;
  const [corto, largo] = a.length <= b.length ? [a, b] : [b, a];
  if (corto.length === 1) return a.join(" ") === b.join(" ");
  return corto.every((t) => largo.includes(t));
}

/** De los hablantes detectados, los que coinciden con el full_name del docente. */
export function preseleccionarDocente(
  speakers: readonly string[],
  fullName: string | null | undefined,
): string[] {
  if (!fullName || !fullName.trim()) return [];
  return speakers.filter((s) => nombreCoincide(s, fullName));
}

/**
 * Texto SOLO de las intervenciones del docente. Mantiene el orden del VTT,
 * une renglones consecutivos del docente en un párrafo y abre un párrafo
 * nuevo cuando otro hablante interrumpió en el medio. Sin prefijo de nombre
 * (es todo el docente). Devuelve string (nunca HTML).
 */
export function filtrarTextoDocente(
  vtt: string,
  teacherSpeakers: readonly string[],
): string {
  const objetivo = new Set(teacherSpeakers.map(normalizarNombre).filter(Boolean));
  if (objetivo.size === 0) return "";
  const cues = parseVtt(vtt);
  const parrafos: string[] = [];
  let buffer: string[] = [];
  let prevEraDocente = false;
  const flush = () => {
    if (buffer.length === 0) return;
    parrafos.push(buffer.join(" ").replace(/\s+/g, " ").trim());
    buffer = [];
  };
  for (const cue of cues) {
    const esDocente = !!cue.speaker && objetivo.has(normalizarNombre(cue.speaker));
    if (esDocente) {
      // Si justo antes NO hablaba el docente, hubo interrupción → nuevo párrafo.
      if (!prevEraDocente) flush();
      buffer.push(cue.text);
    }
    prevEraDocente = esDocente;
  }
  flush();
  return parrafos.filter(Boolean).join("\n");
}
