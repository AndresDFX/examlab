/**
 * Cómo se configura Monaco en los editores de CÓDIGO de la plataforma, y qué
 * cambia cuando la pantalla es la de un teléfono.
 *
 * ── Por qué las opciones base viven acá ───────────────────────────────
 * El mismo bloque de opciones estaba escrito TRES veces, byte a byte: el
 * compilador de examen/taller (`CodeEditor`) y los editores de Java y de Python
 * con interfaz gráfica. Tres copias de una configuración es cómo se llega a que
 * una pregunta de Java se vea con una letra y la de al lado con otra.
 *
 * ── Lo que se recorta en una pantalla angosta, y por qué ──────────────
 * Medido a 390 px (iPhone 14 Pro) con el editor real: de los 356 px del editor,
 * la CANALETA de la izquierda —números de línea, margen de decoraciones,
 * plegado— se llevaba 62 px y la regla de la derecha otros 14. O sea **76 px de
 * adorno sobre 356**: el código escribía en 294. A 320 px (un Android chico) el
 * código quedaba en 224 px, poco más de 20 caracteres por renglón.
 *
 * Nada de ese adorno se usa en un teléfono: no hay hover para el plegado, la
 * regla de la derecha resume un archivo que acá tiene 15 líneas, y los números
 * de línea reservan ancho para 5 dígitos cuando el examen nunca llega a 100.
 * Recortarlo devuelve ~50 px al código, que a 320 px es un 22 % más de renglón.
 *
 * `stickyScroll` se apaga por la misma razón pero en el otro eje: fija la
 * cabecera de la clase o del método arriba del todo, y en un editor de ~7
 * renglones visibles gastar uno (o dos) en repetir `public class Main {` es
 * caro.
 *
 * ── Lo que NO se toca, aunque tape el código ──────────────────────────
 * Monaco dibuja en un dispositivo táctil un botón flotante de teclado
 * (`.iPadShowKeyboard`) abajo a la derecha, ENCIMA del texto. Se ve mal y es lo
 * primero que uno querría sacar. No se saca: en iOS tocar el editor no siempre
 * abre el teclado en pantalla, y ese botón es la única forma de abrirlo. Sin él
 * el editor queda lindo y no se puede escribir. Lo que sí baja su estorbo es
 * darle más alto al editor, que es justo lo que hace `altoDeEditorEnPantalla`.
 */

/**
 * Ancho por debajo del cual el editor se considera «angosto». Es el breakpoint
 * `sm` de Tailwind, el mismo que ya decide en el resto de la app qué columnas
 * se ocultan — tener un segundo umbral propio haría que la barra de
 * herramientas se reacomode en un ancho y el editor en otro.
 */
export const ANCHO_PANTALLA_ANGOSTA = 640;

/**
 * Cuánto del alto de la ventana ocupa el editor en un teléfono. La mitad deja
 * sitio para el enunciado arriba y para la salida abajo sin que ninguno de los
 * tres quede en una rendija.
 */
export const FRACCION_DE_ALTO_EN_MOVIL = 0.5;

export interface MedidasDeVentana {
  ancho: number;
  alto: number;
}

/** `null` = todavía no se midió (render del servidor o primer render). */
export function esPantallaAngosta(ventana: MedidasDeVentana | null): boolean {
  return ventana !== null && ventana.ancho < ANCHO_PANTALLA_ANGOSTA;
}

/**
 * Alto del editor para la pantalla que se está usando.
 *
 * En un teléfono el alto que pide el caller (250–320 px, pensado para un
 * monitor) deja ~7 renglones a la vista una vez que el ajuste de línea parte
 * las líneas largas. Se sube a la mitad de la ventana, que en un teléfono en
 * vertical son ~420 px.
 *
 * Tres cosas deliberadas:
 *  - **Nunca ACHICA**: se toma el mayor entre lo pedido y lo deseado. Si la
 *    ventana es baja (teléfono apaisado, pantalla dividida) queda lo que pedía
 *    el caller, no una rendija calculada.
 *  - **Solo entiende píxeles**: un alto ya relativo (`"55vh"` de la hoja de
 *    código de la pizarra, `"100%"`) se devuelve igual — ya se adapta solo, y
 *    convertirlo sería inventar una equivalencia.
 *  - **Devuelve píxeles**, no `dvh`, para que `escalarAltoEditor` pueda seguir
 *    escalándolo con el zoom. `window.innerHeight` ya es el alto REAL del
 *    momento (en iOS baja cuando aparece la barra de direcciones), así que es
 *    lo mismo que `dvh` pero legible por el zoom.
 */
export function altoDeEditorEnPantalla(
  height: string,
  ventana: MedidasDeVentana | null,
): string {
  if (!esPantallaAngosta(ventana)) return height;
  const m = /^([\d.]+)px$/i.exec(height.trim());
  if (!m) return height;
  const pedido = Number(m[1]);
  if (!Number.isFinite(pedido)) return height;
  const deseado = Math.round(ventana!.alto * FRACCION_DE_ALTO_EN_MOVIL);
  return `${Math.max(pedido, deseado)}px`;
}

/** Opciones comunes a los tres editores de código (examen/taller, Java y Python gráficos). */
export function opcionesBaseDeEditor({
  zoom,
  readOnly,
}: {
  zoom: number;
  readOnly: boolean;
}) {
  return {
    minimap: { enabled: false },
    fontSize: Math.round(13 * zoom),
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    automaticLayout: true,
    tabSize: 4,
    readOnly,
    wordWrap: "on",
    padding: { top: 8 },
  } as const;
}

/**
 * Lo que se le quita a Monaco cuando la pantalla es angosta. Se ESPARCE encima
 * de las opciones base, así que acá solo va lo que cambia.
 */
export const OPCIONES_EN_PANTALLA_ANGOSTA = {
  // Ancho reservado para el número de línea: 5 dígitos por defecto.
  lineNumbersMinChars: 2,
  // Franja entre el número y el código, donde irían las lamparitas. No baja de
  // 8: con menos, el número queda pegado al código y «11}» se lee como un token.
  lineDecorationsWidth: 8,
  // Margen de glifos (puntos de interrupción): la plataforma no depura.
  glyphMargin: false,
  // Plegar bloques pide un hover que en táctil no existe.
  folding: false,
  // La regla de la derecha: 14 px para resumir un archivo de 15 líneas.
  overviewRulerLanes: 0,
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  // Cabecera fija de la clase/método: cuesta un renglón de los ~7 visibles.
  stickyScroll: { enabled: false },
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
} as const;
