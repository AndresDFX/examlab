/**
 * excalidraw-libraries — set curado de items de librería pre-cargados
 * en TODAS las pizarras Excalidraw del proyecto.
 *
 * Por qué hand-crafted: las librerías oficiales en libraries.excalidraw.com
 * se descargan como `.excalidrawlib` (JSON), pero embeber esos archivos
 * tal cual implica que el bundle crezca ~150KB por librería completa
 * (AWS icons, GCP icons, etc.). Para nuestro caso de uso académico
 * (clases de programación / diseño de software / algoritmos), un set
 * compacto de shapes esenciales es más útil que un catálogo enorme.
 *
 * Lo que incluye:
 *  - **Flowchart**: proceso, decisión, inicio/fin (ovales), input/output
 *    (paralelogramo).
 *  - **UML**: caja de clase con 3 zonas (nombre, atributos, métodos).
 *  - **Data structures**: nodo de árbol/grafo (círculo), celda de
 *    arreglo (rectángulo con división), nodo de lista enlazada (data +
 *    pointer).
 *
 * Cómo se usan: el WhiteboardEditor le pasa `initialData.libraryItems`
 * a Excalidraw. Aparecen en el panel "Library" de la pizarra (icono al
 * lado del toolbar). El docente los arrastra al canvas como cualquier
 * shape. Cada drag genera elementos nuevos con IDs distintos — los
 * elements de la librería son TEMPLATES, no se modifican.
 *
 * Para añadir más: copiar el contenido de `elements` de un
 * `.excalidrawlib` descargado de libraries.excalidraw.com y agregarlo
 * como nuevo objeto al array `DEFAULT_LIBRARY_ITEMS`. Cada item
 * necesita `id`, `status`, `created`, `name` y `elements`.
 */

// Color base — gris oscuro de Excalidraw, lee bien en light y dark mode.
const STROKE = "#1e1e1e";
// Color de relleno suave para resaltar zonas (UML class header, etc.).
const FILL_LIGHT = "#e7f5ff"; // azul muy claro
const FILL_WARM = "#fff8e1"; // amarillo muy claro

/**
 * Construye un elemento Excalidraw con defaults razonables. Excalidraw
 * acepta MUCHOS campos opcionales con defaults internos, pero hacer
 * explícitos los más comunes evita warnings en consola sobre "missing
 * required prop".
 */
function makeElement(
  type: "rectangle" | "ellipse" | "diamond" | "text" | "line" | "arrow",
  x: number,
  y: number,
  width: number,
  height: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extras: Record<string, any> = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  return {
    id: `el-${Math.random().toString(36).slice(2, 11)}`,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: STROKE,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: type === "rectangle" ? { type: 3 } : null,
    seed: Math.floor(Math.random() * 1_000_000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 1_000_000),
    isDeleted: false,
    boundElements: [],
    updated: 1_700_000_000_000,
    link: null,
    locked: false,
    ...extras,
  };
}

function makeText(
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
  fontSize = 16,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  return makeElement("text", x, y, width, height, {
    text,
    fontSize,
    fontFamily: 1, // Excalidraw "Virgil" (hand-drawn). 2=Helvetica, 3=Cascadia.
    textAlign: "center",
    verticalAlign: "middle",
    baseline: fontSize * 0.85,
    containerId: null,
    originalText: text,
    lineHeight: 1.25,
    autoResize: true,
    // strokeColor para texto = color del texto, no del border.
    strokeColor: STROKE,
  });
}

/**
 * Item de librería = colección de elementos que se renderean juntos al
 * drag. Cada item necesita su propio `id` (UUID-like estable), un
 * `name` para el tooltip, `status` ("published" para que aparezca en
 * el panel), y `created` (timestamp).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DEFAULT_LIBRARY_ITEMS: Array<Record<string, any>> = [
  // ── Flowchart: Proceso (rounded rectangle con label) ──
  {
    id: "lib-flowchart-process",
    status: "published",
    created: 1_700_000_000_000,
    name: "Flowchart · Proceso",
    elements: [
      makeElement("rectangle", 0, 0, 200, 80, { backgroundColor: FILL_LIGHT }),
      makeText(0, 30, 200, 20, "Proceso", 18),
    ],
  },
  // ── Flowchart: Decisión (diamond) ──
  {
    id: "lib-flowchart-decision",
    status: "published",
    created: 1_700_000_000_000,
    name: "Flowchart · Decisión",
    elements: [
      makeElement("diamond", 0, 0, 200, 120, { backgroundColor: FILL_WARM }),
      makeText(0, 50, 200, 20, "¿Condición?", 16),
    ],
  },
  // ── Flowchart: Inicio / Fin (oval) ──
  {
    id: "lib-flowchart-start",
    status: "published",
    created: 1_700_000_000_000,
    name: "Flowchart · Inicio / Fin",
    elements: [
      makeElement("ellipse", 0, 0, 160, 60, { backgroundColor: FILL_LIGHT }),
      makeText(0, 20, 160, 20, "Inicio", 18),
    ],
  },
  // ── Flowchart: Input / Output (parallelogram simulado con líneas) ──
  // Excalidraw no tiene parallelogram nativo; lo simulamos con un
  // rectángulo + dos líneas en los extremos para el shear visual.
  {
    id: "lib-flowchart-io",
    status: "published",
    created: 1_700_000_000_000,
    name: "Flowchart · Input / Output",
    elements: [
      makeElement("line", 20, 0, 200, 0, {
        points: [
          [0, 0],
          [200, 0],
        ],
      }),
      makeElement("line", 0, 80, 200, 0, {
        points: [
          [0, 0],
          [200, 0],
        ],
      }),
      makeElement("line", 20, 0, 0, 80, {
        points: [
          [0, 0],
          [-20, 80],
        ],
      }),
      makeElement("line", 220, 0, 0, 80, {
        points: [
          [0, 0],
          [-20, 80],
        ],
      }),
      makeText(0, 30, 200, 20, "Datos", 16),
    ],
  },
  // ── UML: Caja de clase (3 zonas: nombre / atributos / métodos) ──
  {
    id: "lib-uml-class",
    status: "published",
    created: 1_700_000_000_000,
    name: "UML · Clase",
    elements: [
      // Zona 1: Nombre de la clase (fondo coloreado)
      makeElement("rectangle", 0, 0, 220, 40, {
        backgroundColor: FILL_LIGHT,
        roundness: null,
      }),
      makeText(0, 10, 220, 20, "ClassName", 18),
      // Zona 2: Atributos
      makeElement("rectangle", 0, 40, 220, 70, { roundness: null }),
      makeText(10, 50, 200, 16, "- attr1: Tipo\n- attr2: Tipo", 14),
      // Zona 3: Métodos
      makeElement("rectangle", 0, 110, 220, 70, { roundness: null }),
      makeText(10, 120, 200, 16, "+ method1(): Tipo\n+ method2(): Tipo", 14),
    ],
  },
  // ── Data structures: Nodo de árbol / grafo (círculo) ──
  {
    id: "lib-ds-node",
    status: "published",
    created: 1_700_000_000_000,
    name: "Estructura · Nodo",
    elements: [
      makeElement("ellipse", 0, 0, 60, 60, { backgroundColor: FILL_LIGHT }),
      makeText(0, 20, 60, 20, "N", 18),
    ],
  },
  // ── Data structures: Celda de arreglo (rectangle dividido) ──
  {
    id: "lib-ds-array-cell",
    status: "published",
    created: 1_700_000_000_000,
    name: "Estructura · Celda de arreglo",
    elements: [
      makeElement("rectangle", 0, 0, 60, 60, { roundness: null }),
      makeText(0, 20, 60, 20, "0", 18),
    ],
  },
  // ── Data structures: Nodo de lista enlazada (data + pointer) ──
  {
    id: "lib-ds-linked-list-node",
    status: "published",
    created: 1_700_000_000_000,
    name: "Estructura · Nodo lista enlazada",
    elements: [
      // Celda data
      makeElement("rectangle", 0, 0, 60, 60, {
        backgroundColor: FILL_LIGHT,
        roundness: null,
      }),
      makeText(0, 20, 60, 20, "data", 14),
      // Celda pointer
      makeElement("rectangle", 60, 0, 40, 60, { roundness: null }),
      makeText(60, 20, 40, 20, "•", 18),
    ],
  },
];
