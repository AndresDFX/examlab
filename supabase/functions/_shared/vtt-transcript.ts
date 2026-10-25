/**
 * Convierte un archivo WebVTT (el formato de las transcripciones de Teams)
 * a texto legible «Hablante: frase».
 *
 * PURO a propósito — sin `Deno`, sin DOM, sin imports — para poder testearlo
 * bajo vitest importándolo por ruta relativa desde `src/`. Es la ÚNICA copia:
 * el edge `calendar` lo importa desde `../_shared/vtt-transcript.ts` y el test
 * `src/modules/calendar/vtt-transcript.test.ts` lo importa por su ruta
 * relativa. No dupliques la lógica en el cliente — el edge produce
 * `content_text` y la UI solo lo muestra.
 *
 * Reglas:
 *  - Une líneas consecutivas del MISMO hablante en un solo renglón.
 *  - Quita las marcas de tiempo (`00:00:00.000 --> ...`), los identificadores
 *    de cue (GUID/número) y todas las etiquetas (`<v Nombre>`, `</v>`, `<c>`…).
 *  - El hablante sale de la etiqueta `<v Nombre>`. Si un cue no la trae, el
 *    renglón va sin prefijo.
 */

export interface TranscriptCue {
  speaker: string | null;
  text: string;
}

/** Quita todas las etiquetas angulares: `<v Nombre>`, `</v>`, `<c.colorE5E5E5>`,
 *  timestamps inline `<00:00:01.000>`, etc. */
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Teams escribe los acentos como entidades (`Casta&#241;o`): sin decodificar,
 *  el hablante no coincide con el nombre del docente y el texto sale con códigos. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTIDADES[e.toLowerCase()] ?? m;
  });
}

/** Extrae el nombre del hablante de la primera etiqueta `<v Nombre>`. */
function extractSpeaker(raw: string): string | null {
  const m = raw.match(/<v\s+([^>]+?)>/i);
  return m ? decodeEntities(m[1]).trim() : null;
}

/** Parsea el VTT a una lista ordenada de cues ya limpios. */
export function parseVtt(vtt: string): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  const text = vtt.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = text.split(/\n[ \t]*\n+/);
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    // Header del archivo y bloques de metadatos: se descartan.
    if (/^WEBVTT/i.test(lines[0])) continue;
    if (/^(NOTE|STYLE|REGION)\b/i.test(lines[0])) continue;
    // La línea de tiempo contiene "-->". Puede haber un identificador de cue
    // (GUID o número) en la(s) línea(s) anteriores — se ignoran.
    const tsIdx = lines.findIndex((l) => l.includes("-->"));
    if (tsIdx === -1) continue;
    const payload = lines.slice(tsIdx + 1).join(" ");
    if (!payload.trim()) continue;
    const speaker = extractSpeaker(payload);
    const body = stripTags(payload);
    if (!body) continue;
    cues.push({ speaker, text: body });
  }
  return cues;
}

/** VTT → texto plano «Hablante: frase», uniendo renglones consecutivos del
 *  mismo hablante. Devuelve string (nunca HTML). */
export function vttToReadableText(vtt: string): string {
  const cues = parseVtt(vtt);
  const out: string[] = [];
  let curSpeaker: string | null | undefined = undefined;
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    const line = buffer.join(" ").replace(/\s+/g, " ").trim();
    out.push(curSpeaker ? `${curSpeaker}: ${line}` : line);
    buffer = [];
  };
  for (const cue of cues) {
    if (buffer.length > 0 && cue.speaker !== curSpeaker) flush();
    curSpeaker = cue.speaker;
    buffer.push(cue.text);
  }
  flush();
  return out.join("\n");
}
