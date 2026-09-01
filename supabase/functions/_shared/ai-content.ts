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
 * `tool_calls` y `arguments` es JSON puro. Verificado contra Bedrock
 * (`us-east-1`, `openai.gpt-oss-120b-1:0`) el 2026-08-31, el día que se activó
 * para la primera institución. Si esa verificación falla, el síntoma NO es una
 * fuga visible sino un vacío: `ai-generate-questions` cae a
 * `{ questions: [] }`, `detect-plagiarism` a `{ pairs: [] }` y
 * `ai-grade-submission` devuelve `kind: "no_tool_call"`. La prueba está donde se
 * paga: el `response_snippet` que `ai-grade-submission` ya guarda en ese camino
 * — revisarlo la PRIMERA vez que un job de ese tenant falle, antes de suponer
 * que es otra cosa.
 */

/**
 * Fin del NOMBRE de la etiqueta. Es `(?=[\s>])` y no `\b` a propósito: con `\b`
 * un elemento personalizado como `<think-box>` o `<reasoning-step>` cuenta como
 * apertura (el límite de palabra cae entre la `k` y el `-`), y ahí se borraba
 * todo el resto del documento. `generate-contents` produce material en
 * HTML/Markdown, así que ese elemento es contenido plausible.
 */
const FIN_NOMBRE = "(?=[\\s>])";
const NOMBRES = "(?:reasoning|thinking|think)";

/**
 * Bloque completo, incluso repetido y con saltos de línea adentro.
 *
 * Sin anclar y global a propósito: un par CERRADO es la señal más confiable de
 * que es markup y no prosa, así que conviene limpiarlo donde aparezca.
 *
 * Límite conocido (medido, se acepta el intercambio): una mención EMPAREJADA
 * legítima se come el medio de la frase — «delimitan su borrador entre
 * <think> y </think>; el texto de adentro…» queda «delimitan su borrador entre
 * ; el texto de adentro…». No se pierde la respuesta, solo se mutila una frase.
 */
const BLOQUE = new RegExp(`<${NOMBRES}${FIN_NOMBRE}[^>]*>[\\s\\S]*?<\\/${NOMBRES}>`, "gi");

/**
 * Apertura SIN cierre: pasa cuando la respuesta se corta por tope de tokens.
 * Se descarta hasta el final porque no hay respuesta que rescatar — devolver el
 * razonamiento a medias sería mostrar el borrador del modelo.
 *
 * ANCLADA a la cabeza (`^\s*`), que es donde vive el artefacto real: la forma
 * observada de Bedrock empieza con `<reasoning>` (ver el ejemplo de arriba).
 * Sin el ancla, una respuesta que MENCIONA la etiqueta perdía todo lo que
 * seguía — medido: «Respuesta real primero. Y acá menciono <thinking> como
 * etiqueta.» quedaba en «Respuesta real primero. Y acá menciono». Cuando lo que
 * queda es vacío, `tutor-chat` y `platform-support-chat` sustituyen por «No
 * pude generar una respuesta en este momento», indistinguible de una caída del
 * proveedor: el alumno reformula y nadie puede diagnosticarlo.
 */
const APERTURA_SUELTA = new RegExp(`^\\s*<${NOMBRES}${FIN_NOMBRE}[^>]*>[\\s\\S]*$`, "i");

/**
 * Cierre huérfano (el modelo abrió antes de lo que nos llegó), SOLO cuando está
 * al principio del texto.
 *
 * La versión sin anclar (`^[\s\S]*?<\/…>`) borraba desde el principio hasta el
 * primer cierre, esté donde esté, y no hay forma de distinguir por la forma del
 * texto un cierre huérfano real de una mención legítima: en los dos casos lo
 * que precede es prosa. Medido: «Un ADR es un registro de decisión de
 * arquitectura. Los modelos que usan </think> marcan así el fin de su
 * razonamiento.» quedaba en «marcan así el fin de su razonamiento.» — la cabeza
 * de la respuesta desaparecida, en silencio.
 *
 * Y la forma observada SIEMPRE trae la apertura, así que un cierre a mitad de
 * texto sin apertura es evidencia de mención, no de artefacto. Con el ancla se
 * conserva la única variante defendible: que la apertura venga recortada de
 * fábrica y el cierre sea lo primero que llega.
 */
const CIERRE_SUELTO = new RegExp(`^\\s*<\\/${NOMBRES}>`, "i");

/** Quita los bloques de razonamiento y recorta. `""` si no queda nada. */
export function textoUtil(content: unknown): string {
  let s = typeof content === "string" ? content : "";
  if (!s) return "";
  s = s.replace(BLOQUE, "");
  s = s.replace(APERTURA_SUELTA, "");
  s = s.replace(CIERRE_SUELTO, "");
  return s.trim();
}
