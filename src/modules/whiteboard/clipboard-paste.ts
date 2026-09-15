/**
 * Pegado de figuras en la pizarra — helpers PUROS.
 *
 * ── Por qué existe este módulo ───────────────────────────────────────────
 * Excalidraw trae su propio manejo de pegado, pero lo IGNORA en tres casos
 * (verificados leyendo su fuente vía sourcemap, `components/App.tsx` de
 * @excalidraw/excalidraw 0.18):
 *
 *   1. `document.activeElement` no está dentro de su contenedor `.excalidraw`.
 *   2. El elemento bajo el cursor no es el `<canvas>`.
 *   3. El destino del evento es un campo editable — su propio `<textarea
 *      class="excalidraw-wysiwyg">` cuando se está escribiendo un texto.
 *
 * Los tres se dan a diario en ExamLab porque el editor monta controles
 * PROPIOS ENCIMA del canvas (el panel «Figuras», el puntero láser, el botón
 * de pantalla completa). Al pulsarlos el foco sale del contenedor de
 * Excalidraw y Ctrl+V deja de responder hasta volver a hacer clic en el
 * lienzo; y en el caso 3 Excalidraw se retira SIN llamar a `preventDefault`,
 * así que el navegador pega el texto crudo: el usuario ve
 * `{"type":"excalidraw/clipboard","elements":[…]}` como un texto en la
 * pizarra en lugar de sus figuras. Ese es el bug reportado.
 *
 * Acá vive lo que se puede probar sin navegador: reconocer el contenido del
 * portapapeles y rehidratar los elementos. El WhiteboardEditor pone el
 * listener y decide cuándo hace falta intervenir.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Elemento = Record<string, any>;

export interface PayloadPortapapeles {
  elements: Elemento[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  files?: Record<string, any>;
}

/**
 * Tipos que Excalidraw acepta como "esto es una escena mía". Copiados de su
 * `EXPORT_DATA_TYPES` y de `clipboardContainsElements`; si divergen, este
 * módulo dejaría pasar (o interceptaría) un payload que Excalidraw trata al
 * revés. `excalidrawlib` NO va: una biblioteca no es un pegado de escena.
 */
const TIPOS_ACEPTADOS = new Set(["excalidraw", "excalidraw/clipboard", "excalidraw-api/clipboard"]);

/**
 * Reconoce el texto del portapapeles como una escena de Excalidraw.
 * Devuelve `null` para cualquier otra cosa — texto normal, una URL, un JSON
 * ajeno—: eso lo tiene que seguir manejando Excalidraw (o el campo de texto
 * donde el usuario está escribiendo), no nosotros.
 */
export function parseExcalidrawClipboard(
  raw: string | null | undefined,
): PayloadPortapapeles | null {
  if (!raw) return null;
  const texto = raw.trim();
  // Descarte barato antes de gastar un JSON.parse sobre, por ejemplo, un
  // archivo de código pegado desde otra pestaña.
  if (!texto.startsWith("{") || !texto.includes("excalidraw")) return null;
  let datos: unknown;
  try {
    datos = JSON.parse(texto);
  } catch {
    return null;
  }
  if (!datos || typeof datos !== "object") return null;
  const obj = datos as { type?: unknown; elements?: unknown; files?: unknown };
  if (typeof obj.type !== "string" || !TIPOS_ACEPTADOS.has(obj.type)) return null;
  if (!Array.isArray(obj.elements) || obj.elements.length === 0) return null;
  return {
    elements: obj.elements as Elemento[],
    files:
      obj.files && typeof obj.files === "object"
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (obj.files as Record<string, any>)
        : undefined,
  };
}

/** Caja que ocupan los elementos, en coordenadas de escena. */
export function boundingBox(elements: Elemento[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} | null {
  if (!elements.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of elements) {
    const x = typeof e.x === "number" ? e.x : 0;
    const y = typeof e.y === "number" ? e.y : 0;
    const w = typeof e.width === "number" ? e.width : 0;
    const h = typeof e.height === "number" ? e.height : 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  return { minX, minY, maxX, maxY };
}

let contador = 0;
/** Id corto y único por pegado. No hace falta que sea un UUID: solo tiene que
 *  no chocar con lo que ya está en la escena. */
function nuevoId(prefijo: string): string {
  contador += 1;
  return `${prefijo}${Date.now().toString(36)}${contador.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * Clona los elementos pegados con identidades NUEVAS y los centra en
 * (centerX, centerY).
 *
 * No se reusa `instantiateLibraryElements` de `excalidraw-libraries.ts` a
 * propósito: ese mete TODO en un único `groupIds` nuevo, que es lo correcto
 * para una figura de la paleta (una plantilla que se inserta como un bloque)
 * y es justo lo que NO se puede hacer con un pegado — aplastaría los grupos
 * que el usuario armó. Y sobre todo: no remapea las referencias entre
 * elementos. Sin remapear, el texto de una caja sigue apuntando por
 * `containerId` al ORIGINAL, así que al pegar una caja con rótulo el rótulo
 * se queda en la caja vieja (o se duplica encima) y las flechas pegadas
 * quedan atadas a las figuras originales.
 */
export function rehydratePastedElements(
  elements: Elemento[],
  centerX: number,
  centerY: number,
): Elemento[] {
  if (!elements.length) return [];
  const caja = boundingBox(elements);
  const dx = caja ? centerX - (caja.minX + (caja.maxX - caja.minX) / 2) : 0;
  const dy = caja ? centerY - (caja.minY + (caja.maxY - caja.minY) / 2) : 0;

  // Mapas viejo→nuevo. Se llenan ANTES de reescribir para poder resolver
  // referencias hacia adelante (una flecha puede nombrar una figura que
  // aparece después en el array).
  const mapaIds = new Map<string, string>();
  const mapaGrupos = new Map<string, string>();
  for (const e of elements) {
    if (typeof e.id === "string") mapaIds.set(e.id, nuevoId("el"));
    if (Array.isArray(e.groupIds)) {
      for (const g of e.groupIds) {
        if (typeof g === "string" && !mapaGrupos.has(g)) mapaGrupos.set(g, nuevoId("grp"));
      }
    }
  }
  // Una referencia a algo que NO se copió (p. ej. una flecha atada a una
  // figura que quedó fuera de la selección) se corta: dejarla apuntando al
  // original ataría lo pegado a lo viejo.
  const refId = (v: unknown): string | null =>
    typeof v === "string" && mapaIds.has(v) ? mapaIds.get(v)! : null;

  return elements.map((e) => {
    const clon: Elemento = JSON.parse(JSON.stringify(e));
    clon.id = typeof e.id === "string" ? mapaIds.get(e.id)! : nuevoId("el");
    clon.x = (typeof e.x === "number" ? e.x : 0) + dx;
    clon.y = (typeof e.y === "number" ? e.y : 0) + dy;
    clon.seed = Math.floor(Math.random() * 1_000_000);
    clon.versionNonce = Math.floor(Math.random() * 1_000_000);
    clon.version = (typeof e.version === "number" ? e.version : 1) + 1;
    clon.updated = Date.now();
    clon.isDeleted = false;

    if (Array.isArray(e.groupIds)) {
      clon.groupIds = e.groupIds
        .map((g: unknown) => (typeof g === "string" ? (mapaGrupos.get(g) ?? null) : null))
        .filter((g: string | null): g is string => g !== null);
    }
    clon.containerId = refId(e.containerId);
    clon.frameId = refId(e.frameId);
    if (Array.isArray(e.boundElements)) {
      clon.boundElements = e.boundElements
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((b: any) =>
          b && typeof b === "object" && refId(b.id) ? { ...b, id: refId(b.id) } : null,
        )
        .filter(Boolean);
    }
    for (const extremo of ["startBinding", "endBinding"] as const) {
      const b = e[extremo];
      if (b && typeof b === "object") {
        const destino = refId(b.elementId);
        clon[extremo] = destino ? { ...b, elementId: destino } : null;
      }
    }
    return clon;
  });
}
