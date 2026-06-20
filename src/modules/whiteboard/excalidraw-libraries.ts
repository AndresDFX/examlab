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
 *  - **Bases de datos**: tabla relacional (3 zonas: nombre, PK,
 *    columnas), entidad ER, relación ER (rombo), atributo ER (óvalo).
 *  - **POO**: interfaz (UML con `<<interface>>`), clase abstracta
 *    (`<<abstract>>`), enum y flecha de herencia (extends).
 *  - **AWS**: bloques esquemáticos para EC2, S3, RDS, Lambda, API
 *    Gateway, SQS, SNS, CloudFront, DynamoDB y VPC (contenedor
 *    dashed). Aproximación de cajas con label — no replica iconos
 *    oficiales para no inflar bundle.
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
  // ──────────────────────────────────────────────────────────────────
  // Bases de datos (ER + relacional)
  // ──────────────────────────────────────────────────────────────────
  // ── DB: Tabla relacional (estilo MySQL Workbench compacto) ──
  // 3 zonas: nombre / PK / columnas. Pensada para diagramar esquema
  // rápido en clase sin armar tabla por columna.
  {
    id: "lib-db-table",
    status: "published",
    created: 1_700_000_000_000,
    name: "DB · Tabla",
    elements: [
      // Header coloreado con el nombre de la tabla
      makeElement("rectangle", 0, 0, 220, 36, {
        backgroundColor: FILL_LIGHT,
        roundness: null,
      }),
      makeText(0, 8, 220, 20, "tabla", 18),
      // Primary key (resaltado con fondo cálido y prefijo PK)
      makeElement("rectangle", 0, 36, 220, 30, {
        backgroundColor: FILL_WARM,
        roundness: null,
      }),
      makeText(10, 41, 200, 20, "PK  id : INT", 14),
      // Columnas comunes
      makeElement("rectangle", 0, 66, 220, 80, { roundness: null }),
      makeText(10, 74, 200, 16, "campo1 : VARCHAR\ncampo2 : INT\ncreated_at : DATETIME", 13),
    ],
  },
  // ── DB: Entidad (ER) ──
  // Forma clásica de los diagramas Entidad-Relación: rectángulo con
  // nombre adentro. Las relaciones (rombos) se hacen con la herramienta
  // diamond de Excalidraw + arrow.
  {
    id: "lib-db-entity",
    status: "published",
    created: 1_700_000_000_000,
    name: "DB · Entidad (ER)",
    elements: [
      makeElement("rectangle", 0, 0, 160, 70, {
        backgroundColor: FILL_LIGHT,
        roundness: null,
      }),
      makeText(0, 25, 160, 20, "Entidad", 18),
    ],
  },
  // ── DB: Relación (ER) ──
  // Rombo del modelo ER que conecta entidades. Cardinalidad (1, N, M)
  // se anota encima de los arrows que conectan.
  {
    id: "lib-db-relation",
    status: "published",
    created: 1_700_000_000_000,
    name: "DB · Relación (ER)",
    elements: [
      makeElement("diamond", 0, 0, 160, 90, { backgroundColor: FILL_WARM }),
      makeText(0, 35, 160, 20, "tiene", 14),
    ],
  },
  // ── DB: Atributo (ER) ──
  // Óvalo con el nombre del atributo, conectado a su entidad con una
  // línea recta.
  {
    id: "lib-db-attribute",
    status: "published",
    created: 1_700_000_000_000,
    name: "DB · Atributo (ER)",
    elements: [
      makeElement("ellipse", 0, 0, 120, 50, { backgroundColor: FILL_LIGHT }),
      makeText(0, 15, 120, 20, "atributo", 14),
    ],
  },
  // ──────────────────────────────────────────────────────────────────
  // POO — extensiones del UML class que ya estaba arriba
  // ──────────────────────────────────────────────────────────────────
  // ── POO: Interfaz ──
  // Caja UML con stereotype <<interface>> arriba del nombre. Métodos
  // abstractos en la zona inferior.
  {
    id: "lib-poo-interface",
    status: "published",
    created: 1_700_000_000_000,
    name: "POO · Interfaz",
    elements: [
      makeElement("rectangle", 0, 0, 220, 56, {
        backgroundColor: FILL_LIGHT,
        roundness: null,
      }),
      makeText(0, 6, 220, 16, "<<interface>>", 12),
      makeText(0, 26, 220, 20, "IName", 18),
      // Métodos abstractos
      makeElement("rectangle", 0, 56, 220, 70, { roundness: null }),
      makeText(10, 64, 200, 16, "+ method1(): Tipo\n+ method2(): Tipo", 14),
    ],
  },
  // ── POO: Clase abstracta ──
  {
    id: "lib-poo-abstract-class",
    status: "published",
    created: 1_700_000_000_000,
    name: "POO · Clase abstracta",
    elements: [
      makeElement("rectangle", 0, 0, 220, 56, {
        backgroundColor: FILL_WARM,
        roundness: null,
      }),
      makeText(0, 6, 220, 16, "<<abstract>>", 12),
      makeText(0, 26, 220, 20, "AbstractName", 18),
      makeElement("rectangle", 0, 56, 220, 60, { roundness: null }),
      makeText(10, 64, 200, 16, "# field1: Tipo", 14),
      makeElement("rectangle", 0, 116, 220, 60, { roundness: null }),
      makeText(10, 124, 200, 16, "+ abstract method(): Tipo", 14),
    ],
  },
  // ── POO: Enum ──
  {
    id: "lib-poo-enum",
    status: "published",
    created: 1_700_000_000_000,
    name: "POO · Enum",
    elements: [
      makeElement("rectangle", 0, 0, 200, 36, {
        backgroundColor: FILL_LIGHT,
        roundness: null,
      }),
      makeText(0, 4, 200, 14, "<<enum>>", 11),
      makeText(0, 18, 200, 16, "Status", 16),
      makeElement("rectangle", 0, 36, 200, 80, { roundness: null }),
      makeText(10, 44, 180, 16, "ACTIVE\nINACTIVE\nPENDING", 14),
    ],
  },
  // ── POO: Herencia (flecha) ──
  // Una flecha simple etiquetada. La cabeza típica UML (triángulo
  // hueco) no existe nativa en Excalidraw — el docente usa "arrow"
  // estándar y nombra "is-a" / "implements" en runtime.
  {
    id: "lib-poo-inheritance",
    status: "published",
    created: 1_700_000_000_000,
    name: "POO · Herencia (is-a)",
    elements: [
      makeElement("arrow", 0, 0, 180, 0, {
        points: [
          [0, 0],
          [180, 0],
        ],
        endArrowhead: "triangle",
      }),
      makeText(40, -22, 100, 18, "extends", 13),
    ],
  },
  // ──────────────────────────────────────────────────────────────────
  // AWS — bloques esquemáticos para arquitectura de soluciones
  // ──────────────────────────────────────────────────────────────────
  // Diseño: cajas rectangulares con label arriba (tipo de servicio) +
  // texto interno con el nombre del recurso. Aproximación esquemática,
  // no replica los iconos oficiales (eso requeriría imágenes y crece el
  // bundle ~150KB). Suficiente para diagramar arquitectura en clase.
  // ── AWS: EC2 ──
  {
    id: "lib-aws-ec2",
    status: "published",
    created: 1_700_000_000_000,
    name: "AWS · EC2",
    elements: [
      makeElement("rectangle", 0, 0, 140, 90, {
        backgroundColor: FILL_WARM,
      }),
      makeText(0, 8, 140, 16, "EC2", 14),
      makeText(0, 36, 140, 20, "instance", 16),
    ],
  },
  // ── AWS: S3 (bucket) ──
  {
    id: "lib-aws-s3",
    status: "published",
    created: 1_700_000_000_000,
    name: "AWS · S3",
    elements: [
      makeElement("rectangle", 0, 0, 140, 90, {
        backgroundColor: FILL_LIGHT,
      }),
      makeText(0, 8, 140, 16, "S3", 14),
      makeText(0, 36, 140, 20, "bucket", 16),
    ],
  },
  // ── AWS: RDS (DB administrada) ──
  {
    id: "lib-aws-rds",
    status: "published",
    created: 1_700_000_000_000,
    name: "AWS · RDS",
    elements: [
      makeElement("rectangle", 0, 0, 140, 90, {
        backgroundColor: FILL_LIGHT,
      }),
      makeText(0, 8, 140, 16, "RDS", 14),
      makeText(0, 36, 140, 20, "db", 16),
    ],
  },
  // ── AWS: Lambda (función) ──
  {
    id: "lib-aws-lambda",
    status: "published",
    created: 1_700_000_000_000,
    name: "AWS · Lambda",
    elements: [
      makeElement("rectangle", 0, 0, 140, 90, {
        backgroundColor: FILL_WARM,
      }),
      makeText(0, 8, 140, 16, "Lambda", 14),
      makeText(0, 36, 140, 20, "function", 16),
    ],
  },
  // ── AWS: API Gateway ──
  {
    id: "lib-aws-api-gateway",
    status: "published",
    created: 1_700_000_000_000,
    name: "AWS · API Gateway",
    elements: [
      makeElement("rectangle", 0, 0, 160, 90, {
        backgroundColor: FILL_LIGHT,
      }),
      makeText(0, 8, 160, 16, "API Gateway", 14),
      makeText(0, 36, 160, 20, "/v1/...", 16),
    ],
  },
  // ── AWS: SQS (queue) ──
  // Forma de "tubería" — rectángulo + óvalo en el extremo derecho que
  // simula la cola.
  {
    id: "lib-aws-sqs",
    status: "published",
    created: 1_700_000_000_000,
    name: "AWS · SQS",
    elements: [
      makeElement("rectangle", 0, 0, 140, 60, {
        backgroundColor: FILL_WARM,
        roundness: null,
      }),
      makeText(0, 4, 140, 14, "SQS", 12),
      makeText(0, 24, 140, 20, "queue", 16),
    ],
  },
  // ── AWS: SNS (topic) ──
  {
    id: "lib-aws-sns",
    status: "published",
    created: 1_700_000_000_000,
    name: "AWS · SNS",
    elements: [
      makeElement("rectangle", 0, 0, 140, 60, {
        backgroundColor: FILL_WARM,
        roundness: null,
      }),
      makeText(0, 4, 140, 14, "SNS", 12),
      makeText(0, 24, 140, 20, "topic", 16),
    ],
  },
  // ── AWS: CloudFront (CDN) ──
  {
    id: "lib-aws-cloudfront",
    status: "published",
    created: 1_700_000_000_000,
    name: "AWS · CloudFront",
    elements: [
      makeElement("rectangle", 0, 0, 160, 90, {
        backgroundColor: FILL_LIGHT,
      }),
      makeText(0, 8, 160, 16, "CloudFront", 14),
      makeText(0, 36, 160, 20, "CDN", 16),
    ],
  },
  // ── AWS: DynamoDB (NoSQL) ──
  {
    id: "lib-aws-dynamodb",
    status: "published",
    created: 1_700_000_000_000,
    name: "AWS · DynamoDB",
    elements: [
      makeElement("rectangle", 0, 0, 160, 90, {
        backgroundColor: FILL_LIGHT,
      }),
      makeText(0, 8, 160, 16, "DynamoDB", 14),
      makeText(0, 36, 160, 20, "table", 16),
    ],
  },
  // ── AWS: VPC (contenedor) ──
  // Rectángulo grande punteado para envolver otros servicios. Se
  // diferencia del resto por el strokeStyle dashed.
  {
    id: "lib-aws-vpc",
    status: "published",
    created: 1_700_000_000_000,
    name: "AWS · VPC (contenedor)",
    elements: [
      makeElement("rectangle", 0, 0, 360, 220, {
        backgroundColor: "transparent",
        strokeStyle: "dashed",
        roundness: null,
      }),
      makeText(10, 8, 200, 18, "VPC", 16),
    ],
  },
];

// ──────────────────────────────────────────────────────────────────────
// Distribución por CATEGORÍA para el panel propio de figuras.
//
// El panel "Library" nativo de Excalidraw muestra los items en una grilla
// PLANA (sin encabezados ni agrupación). Para que el docente encuentre las
// figuras de E-R, POO, flujo, etc. de forma organizada, el WhiteboardEditor
// renderiza su propio panel con SECCIONES por categoría usando esta estructura.
//
// Las categorías se derivan del prefijo del `id` (no mutamos los items que van
// a Excalidraw). El orden de `LIBRARY_CATEGORIES` es el orden visible.
// ──────────────────────────────────────────────────────────────────────

export interface LibraryCategory {
  key: string;
  /** Título de la sección (estilo draw.io: nombra el tipo de diagrama). */
  label: string;
  /** Una línea de "para qué sirve" — responde "¿qué figuras son para X?". */
  description: string;
  /** Nombre del ícono lucide que el panel resuelve (mapa en WhiteboardEditor). */
  icon: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items: Array<Record<string, any>>;
}

function pickByPrefix(prefixes: string[]) {
  return DEFAULT_LIBRARY_ITEMS.filter((it) =>
    prefixes.some((p) => String(it.id).startsWith(p)),
  );
}

/**
 * Figuras agrupadas por TIPO DE DIAGRAMA, en el orden en que se muestran en el
 * panel. Cada sección nombra explícitamente para qué sirve (estilo draw.io:
 * "estas figuras son para un diagrama de clases", etc.) — el docente no tiene
 * que adivinar. El "Diagrama de clases (UML)" va PRIMERO por ser el caso más
 * pedido en clases de POO.
 */
export const LIBRARY_CATEGORIES: LibraryCategory[] = [
  {
    key: "clases",
    label: "Diagrama de clases (UML)",
    description: "Clase, interfaz, clase abstracta, enum y herencia.",
    icon: "Boxes",
    items: pickByPrefix(["lib-uml-", "lib-poo-"]),
  },
  {
    key: "flujo",
    label: "Diagrama de flujo",
    description: "Proceso, decisión, inicio/fin y entrada/salida.",
    icon: "Workflow",
    items: pickByPrefix(["lib-flowchart-"]),
  },
  {
    key: "er",
    label: "Entidad–Relación / Base de datos",
    description: "Tabla, entidad, relación y atributo.",
    icon: "Database",
    items: pickByPrefix(["lib-db-"]),
  },
  {
    key: "estructuras",
    label: "Estructuras de datos",
    description: "Nodo, celda de arreglo y nodo de lista enlazada.",
    icon: "Binary",
    items: pickByPrefix(["lib-ds-"]),
  },
  {
    key: "aws",
    label: "Arquitectura en la nube (AWS)",
    description: "EC2, S3, RDS, Lambda, API Gateway, VPC…",
    icon: "Cloud",
    items: pickByPrefix(["lib-aws-"]),
  },
];

/** Quita el prefijo "Categoría · " del nombre para mostrar la etiqueta corta
 *  en el panel (la categoría ya la da el encabezado de sección). */
export function shortLibraryItemName(name: string): string {
  const idx = name.indexOf("·");
  return idx >= 0 ? name.slice(idx + 1).trim() : name.trim();
}

// Contador para ids únicos al instanciar (evita colisión si se inserta el
// mismo template dos veces). Math.random/Date.now son OK acá: se ejecuta en
// el click del usuario, NUNCA en render/SSR (no rompe hidratación).
let _instSeq = 0;
function instUid(prefix: string): string {
  _instSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${_instSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Clona los elementos de un item de librería para insertarlos en el canvas,
 * CENTRADOS en (centerX, centerY) (coordenadas de escena). Regenera ids/seed
 * para no colisionar con inserciones previas y agrupa los elementos con un
 * `groupId` común para que se muevan/seleccionen como una sola figura.
 *
 * Puro (sin API de Excalidraw) → testeable. El caller (WhiteboardEditor)
 * resuelve el centro del viewport desde el appState y hace el `updateScene`.
 */
export function instantiateLibraryElements(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  elements: Array<Record<string, any>>,
  centerX: number,
  centerY: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Array<Record<string, any>> {
  if (!elements.length) return [];
  const minX = Math.min(...elements.map((e) => e.x));
  const minY = Math.min(...elements.map((e) => e.y));
  const maxX = Math.max(...elements.map((e) => e.x + (e.width ?? 0)));
  const maxY = Math.max(...elements.map((e) => e.y + (e.height ?? 0)));
  const dx = centerX - (minX + (maxX - minX) / 2);
  const dy = centerY - (minY + (maxY - minY) / 2);
  const groupId = instUid("grp");
  return elements.map((e) => {
    const clone = JSON.parse(JSON.stringify(e));
    clone.id = instUid("el");
    clone.x = e.x + dx;
    clone.y = e.y + dy;
    clone.seed = Math.floor(Math.random() * 1_000_000);
    clone.versionNonce = Math.floor(Math.random() * 1_000_000);
    clone.groupIds = [groupId];
    return clone;
  });
}

// ──────────────────────────────────────────────────────────────────────
// Miniatura (thumbnail) de una figura para el panel — clave de claridad
// "estilo draw.io": el docente VE la figura, no solo su nombre.
//
// `libraryItemPreview` es PURO (sin React, sin rough.js): toma los `elements`
// del template y devuelve primitivas SVG simples ya escaladas para caber en una
// caja (boxW × boxH). El WhiteboardEditor las pinta en un <svg>. No replica el
// trazo "a mano alzada" de Excalidraw — es un esquema limpio y reconocible.
// ──────────────────────────────────────────────────────────────────────

export type PreviewShape =
  | { kind: "rect"; x: number; y: number; w: number; h: number; fill: string; rounded: boolean; dashed: boolean }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; fill: string }
  | { kind: "diamond"; points: string; fill: string }
  | { kind: "polyline"; points: string; dashed: boolean; arrow: boolean }
  | { kind: "text"; x: number; y: number; text: string; fontSize: number };

export interface ItemPreview {
  width: number;
  height: number;
  shapes: PreviewShape[];
}

/** Puntos absolutos de un line/arrow (sus `points` son relativos a x,y). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function absPoints(e: Record<string, any>): Array<[number, number]> | null {
  if ((e.type === "line" || e.type === "arrow") && Array.isArray(e.points)) {
    return e.points.map((p: [number, number]) => [e.x + p[0], e.y + p[1]] as [number, number]);
  }
  return null;
}

/**
 * Convierte los elementos de un item en primitivas SVG escaladas a una caja.
 * Mantiene el aspecto (escala uniforme) y centra el dibujo. Puro → testeable.
 */
export function libraryItemPreview(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  elements: Array<Record<string, any>>,
  boxW = 84,
  boxH = 56,
  pad = 5,
): ItemPreview {
  if (!elements || elements.length === 0) return { width: boxW, height: boxH, shapes: [] };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of elements) {
    const pts = absPoints(e);
    if (pts) {
      for (const [ax, ay] of pts) {
        minX = Math.min(minX, ax); minY = Math.min(minY, ay);
        maxX = Math.max(maxX, ax); maxY = Math.max(maxY, ay);
      }
    } else {
      minX = Math.min(minX, e.x); minY = Math.min(minY, e.y);
      maxX = Math.max(maxX, e.x + (e.width ?? 0)); maxY = Math.max(maxY, e.y + (e.height ?? 0));
    }
  }
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const scale = Math.min((boxW - 2 * pad) / bw, (boxH - 2 * pad) / bh);
  const offX = pad + ((boxW - 2 * pad) - bw * scale) / 2;
  const offY = pad + ((boxH - 2 * pad) - bh * scale) / 2;
  const tx = (x: number) => offX + (x - minX) * scale;
  const ty = (y: number) => offY + (y - minY) * scale;

  const shapes: PreviewShape[] = [];
  for (const e of elements) {
    const fill =
      e.backgroundColor && e.backgroundColor !== "transparent" ? e.backgroundColor : "none";
    const dashed = e.strokeStyle === "dashed";
    const w = (e.width ?? 0) * scale;
    const h = (e.height ?? 0) * scale;
    if (e.type === "rectangle") {
      shapes.push({ kind: "rect", x: tx(e.x), y: ty(e.y), w, h, fill, rounded: !!e.roundness, dashed });
    } else if (e.type === "ellipse") {
      shapes.push({ kind: "ellipse", cx: tx(e.x) + w / 2, cy: ty(e.y) + h / 2, rx: w / 2, ry: h / 2, fill });
    } else if (e.type === "diamond") {
      const x = tx(e.x), y = ty(e.y);
      const points = `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`;
      shapes.push({ kind: "diamond", points, fill });
    } else if ((e.type === "line" || e.type === "arrow") && Array.isArray(e.points)) {
      const points = e.points
        .map((p: [number, number]) => `${tx(e.x + p[0])},${ty(e.y + p[1])}`)
        .join(" ");
      shapes.push({ kind: "polyline", points, dashed, arrow: e.type === "arrow" });
    } else if (e.type === "text" && e.text) {
      const firstLine = String(e.text).split("\n")[0];
      const fontSize = Math.max(3.5, Math.min(9, (e.fontSize ?? 14) * scale));
      shapes.push({
        kind: "text",
        x: tx(e.x) + w / 2,
        y: ty(e.y) + h / 2,
        text: firstLine,
        fontSize,
      });
    }
  }
  return { width: boxW, height: boxH, shapes };
}
