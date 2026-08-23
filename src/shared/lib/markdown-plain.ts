/**
 * Markdown → texto plano, para vistas donde NO se puede renderizar.
 *
 * ── Por qué existe ────────────────────────────────────────────────────
 * El texto que escribe el docente (descripción de una encuesta, enunciado de
 * una pregunta) es Markdown, y donde hay espacio se renderiza con
 * `MarkdownInline`. Pero hay lugares donde renderizarlo está mal:
 *
 *   · Una celda de tabla con `truncate`: el markdown genera elementos de
 *     BLOQUE (`<p>`, `<ul>`, `<h2>`) y eso rompe el truncado a una línea.
 *   · Un atributo `title=`, un `aria-label`, un asunto de correo o el cuerpo
 *     de una notificación: solo aceptan texto.
 *
 * Antes esos lugares mostraban la sintaxis cruda —`**solo yo veo tus
 * respuestas**` con los asteriscos a la vista—, que es lo peor de las dos
 * opciones: ni formatea, ni deja el texto limpio.
 *
 * ── Qué NO es ─────────────────────────────────────────────────────────
 * No es un parser de Markdown: es un limpiador para PREVIEWS. Quita la
 * sintaxis más común y colapsa el texto a una línea. Si alguna construcción
 * exótica se le escapa, el peor caso es un carácter de sintaxis suelto en un
 * preview truncado — nunca HTML, porque devuelve string y quien lo consume lo
 * pinta como texto.
 *
 * Para mostrar el contenido de verdad: `MarkdownInline` (texto corto en cards)
 * o `MarkdownViewer` (documentos).
 */

/**
 * Marcador del texto protegido durante el paso 1.
 *
 * Se construye con `String.fromCharCode` y NO se escribe el carácter en la
 * literal: un carácter invisible en la fuente se lee como un string vacío y el
 * próximo que pase por acá lo "limpia" y rompe el helper sin que ningún test
 * obvio lo señale. Es del Área de Uso Privado, así que no aparece en texto
 * escrito por una persona, y a diferencia de NUL no es un carácter de control
 * —que dispararía `no-control-regex` de ESLint, con razón—.
 */
const MARCA = String.fromCharCode(0xe000);

/** Reconstruye el `MARCA + indice + MARCA` del paso 1 sin escribir el carácter. */
const RE_MARCA = new RegExp(`${MARCA}(\\d+)${MARCA}`, "g");

/**
 * Devuelve el texto legible de un fragmento de Markdown, en una sola línea.
 *
 * Tres pasos, y el ORDEN es lo que hace que funcione:
 *  1. PROTEGER lo que no se debe interpretar (código y escapes).
 *  2. Quitar la sintaxis: primero lo que ENVUELVE contenido, después los
 *     prefijos de línea.
 *  3. Restaurar lo protegido y colapsar a una línea.
 *
 * Los dos bordes que costaron un test cada uno:
 *   · `` `a*b*c` `` — si se quitan los backticks antes del énfasis, los `*` de
 *     adentro quedan sueltos y el énfasis se los come → `abc`.
 *   · `\*literal\*` — el énfasis empareja los asteriscos escapados y devuelve
 *     `\no es énfasis\`.
 * Los dos se resuelven protegiendo primero, no reordenando los reemplazos.
 */
export function markdownToPlain(md: string | null | undefined): string {
  if (!md) return "";
  let s = String(md);

  // ── 1) Proteger ──────────────────────────────────────────────────────
  const guardados: string[] = [];
  const guardar = (valor: string) => MARCA + (guardados.push(valor) - 1) + MARCA;

  s = s.replace(/```[a-zA-Z0-9]*\r?\n?([\s\S]*?)```/g, (_m, c: string) => guardar(c));
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => guardar(c));
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!~>])/g, (_m, c: string) => guardar(c));

  // ── 2) Quitar la sintaxis ────────────────────────────────────────────
  // Envolventes primero: al revés, el `*` de una viñeta se emparejaría con el
  // siguiente y se comería el texto del medio.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"); // imágenes → alt
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // enlaces → texto
  s = s.replace(/(\*\*\*|___)([\s\S]+?)\1/g, "$2");
  s = s.replace(/(\*\*|__)([\s\S]+?)\1/g, "$2");
  s = s.replace(/(\*|_)([\s\S]+?)\1/g, "$2");
  s = s.replace(/~~([\s\S]+?)~~/g, "$1");
  // Prefijos de línea.
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  s = s.replace(/^[ \t]{0,3}[-*+][ \t]+/gm, "");
  s = s.replace(/^[ \t]{0,3}\d+[.)][ \t]+/gm, "");
  // Regla horizontal: la línea entera desaparece.
  s = s.replace(/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "");

  // ── 3) Restaurar y colapsar ──────────────────────────────────────────
  s = s.replace(RE_MARCA, (_m, i: string) => guardados[Number(i)] ?? "");
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Igual que `markdownToPlain` pero recorta a `max` caracteres con elipsis.
 * Para un `title=` o el cuerpo de una notificación, donde un texto largo no
 * aporta nada.
 */
export function markdownToPlainPreview(md: string | null | undefined, max = 160): string {
  const s = markdownToPlain(md);
  if (s.length <= max) return s;
  // Cortar en el último espacio antes del límite para no partir una palabra;
  // si ese espacio está demasiado atrás, se corta duro.
  const corte = s.slice(0, max);
  const esp = corte.lastIndexOf(" ");
  return (esp > max * 0.6 ? corte.slice(0, esp) : corte).trimEnd() + "…";
}
