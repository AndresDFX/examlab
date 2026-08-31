/**
 * El texto UTIL de una respuesta de chat, sin el razonamiento interno del modelo.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────
 * Los modelos `openai.gpt-oss-*` que sirve **Amazon Bedrock** por su endpoint
 * compatible con OpenAI devuelven su deliberación DENTRO de `message.content`,
 * pegada a la respuesta real y sin ningún campo aparte que la separe. Medido
 * contra Bedrock (`us-east-1`, `openai.gpt-oss-120b-1:0`) pidiendo «¿Qué es un
 * ADR? Responde en dos frases»:
 *
 *     <reasoning>We need to respond as a tutor, brief, Spanish, two
 *     sentences…</reasoning>Un ADR es un conjunto de métodos…
 *
 * SIETE edges leen `content` crudo —el tutor del curso, el asistente de
 * plataforma, la sugerencia de soporte, el generador de SQL, el de informes, el
 * de contenidos y la descripción de proyecto—, así que con Bedrock activo ese
 * texto interno se le muestra al estudiante y se inserta en los documentos
 * generados. No es estético: en el tutor ES la respuesta que el alumno lee, y en
 * el generador de SQL es código que se pega en un editor.
 *
 * Gemini y OpenAI no emiten esa marca, así que para ellos esto es un no-op: se
 * puede aplicar SIEMPRE sin preguntar por el proveedor —que además cambia por
 * institución, en runtime, desde la fila activa de `ai_model_settings`.
 *
 * ── Lo que NO hace ────────────────────────────────────────────────────────
 * No toca `tool_calls`. Los edges que piden salida estructurada (calificación,
 * generación de preguntas, detección de plagio) leen los argumentos de la
 * función, y ahí el razonamiento no se mezcla: `finish_reason` llega como
 * `tool_calls` y `arguments` es JSON puro. Verificado contra Bedrock.
 */

/** Bloque completo, incluso repetido y con saltos de línea adentro. */
const BLOQUE = /<(?:reasoning|thinking|think)\b[^>]*>[\s\S]*?<\/(?:reasoning|thinking|think)>/gi;

/**
 * Apertura SIN cierre: pasa cuando la respuesta se corta por tope de tokens.
 * Se descarta hasta el final porque no hay respuesta que rescatar — devolver el
 * razonamiento a medias sería mostrar el borrador del modelo.
 */
const APERTURA_SUELTA = /<(?:reasoning|thinking|think)\b[^>]*>[\s\S]*$/i;

/** Cierre huérfano: el modelo abrió antes de lo que nos llegó. */
const CIERRE_SUELTO = /^[\s\S]*?<\/(?:reasoning|thinking|think)>/i;

/** Quita los bloques de razonamiento y recorta. `""` si no queda nada. */
export function textoUtil(content: unknown): string {
  let s = typeof content === "string" ? content : "";
  if (!s) return "";
  s = s.replace(BLOQUE, "");
  s = s.replace(APERTURA_SUELTA, "");
  s = s.replace(CIERRE_SUELTO, "");
  return s.trim();
}
