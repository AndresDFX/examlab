/**
 * (De)serialización de la respuesta de la consola Linux REAL (v86).
 *
 * A diferencia del simulador determinista (que serializaba el objeto `System`
 * final + historial para poder auto-calificar por estado), un VM real no se
 * puede introspeccionar como estructura JS. La "respuesta" del alumno es el
 * TRANSCRIPT de su sesión de terminal (lo que se vio en pantalla) + la lista
 * de comandos que tecleó. El docente lo revisa manualmente (no hay
 * auto-calificación por aserciones contra un Linux real).
 */

export interface V86Answer {
  /** Texto acumulado de la consola serial (salida + eco de comandos). */
  transcript: string;
  /** Líneas de comando que el alumno envió (para lectura rápida del docente). */
  commands: string[];
}

const MAX_TRANSCRIPT = 200_000; // tope defensivo para no inflar answer_text

export function serializeV86Answer(answer: V86Answer): string {
  const transcript = (answer.transcript || "").slice(-MAX_TRANSCRIPT);
  return JSON.stringify({ v86: 1, transcript, commands: answer.commands ?? [] });
}

/** Tolerante: devuelve null si `raw` no es una respuesta v86 válida. */
export function parseV86Answer(raw: unknown): V86Answer | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || obj.v86 !== 1) return null;
    const transcript = typeof obj.transcript === "string" ? obj.transcript : "";
    const commands = Array.isArray(obj.commands)
      ? obj.commands.filter((c): c is string => typeof c === "string")
      : [];
    return { transcript, commands };
  } catch {
    return null;
  }
}

/** ¿La respuesta está "en blanco"? (sin comandos y sin transcript útil). */
export function isV86AnswerBlank(raw: unknown): boolean {
  const parsed = parseV86Answer(raw);
  if (!parsed) return true;
  return parsed.commands.length === 0 && parsed.transcript.trim().length === 0;
}
