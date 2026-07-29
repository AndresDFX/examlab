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

/*
 * Limpieza de escapes ANSI.
 *
 * El transcript que se PERSISTE es crudo a propósito (es la evidencia de la
 * sesión: cada byte que salió del serial del guest, incluidos los escapes que
 * pintan el prompt y la salida de `ls`). La limpieza se hace al LEER, no al
 * guardar — filtrar al escribir sería irreversible.
 *
 * Sin esto, los consumidores que NO son una terminal (el `<pre>` de las vistas
 * de revisión y el prompt de calificación con IA) muestran/leen basura tipo
 * `ESC[1;32mroot@examlab ESC[0m:~#`.
 */

/**
 * Secuencias "de cadena": OSC (`ESC ]`, ej. título de la ventana) y sus primas
 * DCS/APC/PM/SOS. Terminan en BEL (`\x07`) o ST (`ESC \`); si la sesión se
 * cortó a mitad, el `$` las consume hasta el final. Va PRIMERO porque su cuerpo
 * puede contener bytes que las otras regex confundirían con secuencias sueltas.
 */
const STRING_SEQ_RE = /\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\|$)/g;
/** CSI: `ESC [` + parámetros + intermedios + byte final (@-~). Cubre SGR (color), cursor, borrado. */
const CSI_RE = /\x1b\[[0-9;:?<>=!]*[ -/]*[@-~]/g;
/** CSI truncada al final del transcript (se cortó antes del byte final). */
const CSI_PARTIAL_RE = /\x1b\[[0-9;:?<>=!]*[ -/]*$/;
/** nF de dos caracteres: `ESC` + intermedio (0x20-0x2F) + final (0x30-0x7E). Ej. `ESC ( B` (charset). */
const NF_RE = /\x1b[ -/][0-~]/g;
/** Fe de dos caracteres restantes: `ESC` + (@-Z o \ ] ^ _). Ej. `ESC M` (reverse index). */
const FE_RE = /\x1b[@-Z\\-_]/g;
/** Controles sueltos que no aportan texto: BEL, backspace, ESC huérfano, DEL… Preserva \t \n \r. */
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Colapsa los retornos de carro DENTRO de una línea.
 *
 * BusyBox (y readline, y las barras de progreso) usan `\r` para REESCRIBIR la
 * línea actual: en una terminal el texto posterior tapa al anterior. En un
 * `<pre>` un `\r` suelto no borra nada, así que la línea queda pegada
 * ("10%20%30%") — y lo mismo lee la IA. Nos quedamos con el ÚLTIMO segmento no
 * vacío, que es lo que el alumno realmente vio (un `\r` final de línea no debe
 * vaciarla). No emulamos el sobreescrito parcial (segmento corto sobre uno
 * largo): es un caso marginal y el crudo persistido sigue siendo la evidencia.
 */
function collapseCarriageReturns(line: string): string {
  if (!line.includes("\r")) return line;
  const segments = line.split("\r");
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i] !== "") return segments[i];
  }
  return "";
}

/**
 * Quita los escapes ANSI de un texto de terminal y normaliza CRLF/CR, para que
 * lo lea un humano en un `<pre>` o el modelo de IA que califica.
 *
 * Tolerante: cualquier entrada que no sea string devuelve "".
 */
export function stripAnsi(input: unknown): string {
  if (typeof input !== "string" || input === "") return "";
  const plain = input
    .replace(STRING_SEQ_RE, "")
    .replace(CSI_RE, "")
    .replace(CSI_PARTIAL_RE, "")
    .replace(NF_RE, "")
    .replace(FE_RE, "")
    .replace(CONTROL_RE, "");
  return plain.replace(/\r\n/g, "\n").split("\n").map(collapseCarriageReturns).join("\n");
}

/**
 * Texto LEGIBLE del transcript para vistas de revisión (docente/alumno).
 * Devuelve `null` si `raw` NO es una respuesta v86 — así el caller muestra el
 * `raw` tal cual (respuestas de otros tipos no se tocan).
 */
export function v86TranscriptForDisplay(raw: unknown): string | null {
  const parsed = parseV86Answer(raw);
  if (!parsed) return null;
  return stripAnsi(parsed.transcript).trim() || stripAnsi(parsed.commands.join("\n")).trim() || null;
}
