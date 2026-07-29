/**
 * Helpers PUROS del "deck" de diapositivas de un contenido y de su mapa de
 * ANOTACIONES por diapositiva. Sin React, sin Storage, sin Supabase — todo
 * testeable en aislado (ver slide-deck.test.ts).
 *
 * Qué es un deck acá: la lista plana de diapositivas ANOTABLES de un
 * `generated_contents`, construida a partir de `files[]`:
 *   - `kind: 'pptx-source'` con `body` → N diapositivas (las que parsea
 *     `parseSlideBlock`; se renderizan como el mockup HTML de SlideMockup).
 *   - archivo de imagen (png/jpg/webp/gif/svg/…) → 1 diapositiva (la imagen).
 *   - CUALQUIER otra cosa (.pptx binario, .pdf, .docx, código…) queda FUERA:
 *     no tenemos con qué rasterizarla en el cliente sin dependencias nuevas,
 *     y una capa de anotación sobre un visor opaco (iframe/object) se
 *     desalinea al scrollear. El diálogo lo dice explícito en vez de mostrar
 *     un canvas roto.
 *
 * ESPACIO DE COORDENADAS CANÓNICO (SLIDE_W x SLIDE_H): las anotaciones se
 * guardan en unidades de escena de 960x540, NO en píxeles de pantalla. El
 * visor calcula el zoom inicial para encajar ese rectángulo en el espacio
 * disponible (`fitViewport`), así una anotación hecha en un proyector se ve
 * en el mismo lugar en un celular.
 */
import { parseSlideBlock, type ParsedSlide } from "@/modules/contents/contents-pptx";
import { isImageFile } from "@/modules/contents/media-files";
import type { WhiteboardScene } from "@/modules/whiteboard/WhiteboardEditor";

/** Ancho canónico de una diapositiva en unidades de escena. */
export const SLIDE_W = 960;
/** Alto canónico (16:9). */
export const SLIDE_H = 540;

/** Entrada de `generated_contents.files[]` (shape mínimo que usamos). */
export interface ContentFileLike {
  name: string;
  path: string;
  kind?: string | null;
  body?: string | null;
}

/** Una diapositiva del deck. `key` es la clave de persistencia. */
export interface DeckSlide {
  /** `<file_path>#<index>` — clave estable en el mapa de anotaciones. */
  key: string;
  filePath: string;
  fileName: string;
  /** Índice 0-based DENTRO del archivo (imágenes: siempre 0). */
  index: number;
  kind: "text" | "image";
  /** Solo en kind="text": la diapositiva parseada a renderizar. */
  slide?: ParsedSlide;
}

/** Mapa persistido: clave de diapositiva → escena de anotación. */
export type SlideAnnotations = Record<string, WhiteboardScene>;

/** Clave canónica de una diapositiva. */
export function annotationKey(filePath: string, index: number): string {
  return `${filePath}#${index}`;
}

/** ¿Es la presentación generada por IA (texto estructurado con body)? */
export function isSlideSourceFile(f: ContentFileLike | null | undefined): boolean {
  return !!f && f.kind === "pptx-source" && typeof f.body === "string" && f.body.trim().length > 0;
}

/** ¿Es una imagen que hace de diapositiva? */
export function isSlideImageFile(f: ContentFileLike | null | undefined): boolean {
  return !!f && isImageFile(f.name);
}

/** ¿Este archivo aporta al menos una diapositiva anotable? */
export function isAnnotatableFile(f: ContentFileLike | null | undefined): boolean {
  return isSlideSourceFile(f) || isSlideImageFile(f);
}

/**
 * Aplana `files[]` al deck de diapositivas anotables, en el orden en que
 * vienen los archivos. Archivos sin `path` caen al `name` (mismo fallback
 * que el resto del módulo de Contenidos).
 */
export function buildSlideDeck(files: readonly ContentFileLike[] | null | undefined): DeckSlide[] {
  const out: DeckSlide[] = [];
  for (const f of files ?? []) {
    if (!f || typeof f.name !== "string") continue;
    const path = (f.path ?? "").trim() || f.name;
    if (isSlideSourceFile(f)) {
      const parsed = parseSlideBlock(f.body as string);
      parsed.forEach((slide, i) => {
        out.push({
          key: annotationKey(path, i),
          filePath: path,
          fileName: f.name,
          index: i,
          kind: "text",
          slide,
        });
      });
    } else if (isSlideImageFile(f)) {
      out.push({
        key: annotationKey(path, 0),
        filePath: path,
        fileName: f.name,
        index: 0,
        kind: "image",
      });
    }
  }
  return out;
}

/** Etiqueta corta de una diapositiva para el selector / navegación. */
export function deckSlideLabel(s: DeckSlide, position: number): string {
  const title = (s.slide?.title ?? "").trim();
  if (s.kind === "text") return `${position}. ${title || s.fileName}`;
  return `${position}. ${s.fileName}`;
}

/** ¿La escena tiene algo dibujado? (una escena vacía no se persiste) */
export function sceneHasContent(scene: WhiteboardScene | null | undefined): boolean {
  return !!scene && Array.isArray(scene.elements) && scene.elements.length > 0;
}

/**
 * Devuelve un mapa NUEVO con la escena de `key` actualizada. Si la escena
 * quedó vacía (el docente borró todo), la clave se ELIMINA — así el JSONB no
 * acumula entradas `{elements: []}` inútiles y `annotatedSlideKeys` refleja
 * exactamente qué diapositivas tienen marcas.
 */
export function withSlideAnnotation(
  map: SlideAnnotations,
  key: string,
  scene: WhiteboardScene | null | undefined,
): SlideAnnotations {
  const next: SlideAnnotations = { ...map };
  if (sceneHasContent(scene)) {
    next[key] = scene as WhiteboardScene;
  } else {
    delete next[key];
  }
  return next;
}

/** Claves con anotaciones, ordenadas — estable para comparar/renderizar. */
export function annotatedSlideKeys(map: SlideAnnotations): string[] {
  return Object.keys(map)
    .filter((k) => sceneHasContent(map[k]))
    .sort();
}

/**
 * Serialización ESTABLE (claves ordenadas) del mapa. Se usa para detectar
 * "hay cambios sin guardar": `JSON.stringify` directo no sirve porque el
 * orden de inserción de las claves cambia según en qué orden se anotó.
 */
export function serializeAnnotations(map: SlideAnnotations): string {
  const keys = annotatedSlideKeys(map);
  return JSON.stringify(keys.map((k) => [k, map[k]]));
}

/** ¿El mapa de trabajo difiere del guardado? */
export function annotationsDirty(saved: SlideAnnotations, working: SlideAnnotations): boolean {
  return serializeAnnotations(saved) !== serializeAnnotations(working);
}

/**
 * Normaliza lo que vuelve de la DB. Descarta entradas que no tengan una
 * escena con `elements` array: una fila corrupta (o de una versión futura)
 * NO debe hacer explotar el editor ni pisar las anotaciones buenas.
 */
export function sanitizeAnnotations(raw: unknown): SlideAnnotations {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: SlideAnnotations = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const scene = value as { elements?: unknown };
    if (!Array.isArray(scene.elements) || scene.elements.length === 0) continue;
    out[key] = value as WhiteboardScene;
  }
  return out;
}

/** Bytes aproximados del JSONB — para avisar ANTES de pegarle al tope de la DB. */
export function estimateAnnotationsBytes(map: SlideAnnotations): number {
  try {
    return new TextEncoder().encode(JSON.stringify(map)).length;
  } catch {
    return 0;
  }
}

/** Tope de la fila en DB (trigger `content_slide_annotations_guard`). */
export const MAX_ANNOTATIONS_BYTES = 5 * 1024 * 1024;

/** Viewport de Excalidraw (mismas unidades que su appState). */
export interface StageViewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

/**
 * Viewport que ENCAJA y CENTRA el rectángulo canónico de la diapositiva
 * dentro de un área de `boxW x boxH` píxeles.
 *
 * Excalidraw mapea `pantalla = (escena + scroll) * zoom`, así que para que
 * la esquina (0,0) de la diapositiva caiga en el margen izquierdo/superior
 * del área: `scroll = (box - slide * zoom) / (2 * zoom)`.
 */
export function fitViewport(
  boxW: number,
  boxH: number,
  slideW: number = SLIDE_W,
  slideH: number = SLIDE_H,
): StageViewport {
  if (!Number.isFinite(boxW) || !Number.isFinite(boxH) || boxW <= 0 || boxH <= 0) {
    return { scrollX: 0, scrollY: 0, zoom: 1 };
  }
  const zoom = Math.min(boxW / slideW, boxH / slideH);
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    scrollX: (boxW - slideW * safeZoom) / (2 * safeZoom),
    scrollY: (boxH - slideH * safeZoom) / (2 * safeZoom),
    zoom: safeZoom,
  };
}

/**
 * Transform CSS que hay que aplicarle al fondo (la diapositiva) para que
 * siga al viewport del canvas de anotación. Con `transform-origin: 0 0`.
 */
export function stageTransform(vp: StageViewport): string {
  const z = Number.isFinite(vp.zoom) && vp.zoom > 0 ? vp.zoom : 1;
  const x = Number.isFinite(vp.scrollX) ? vp.scrollX : 0;
  const y = Number.isFinite(vp.scrollY) ? vp.scrollY : 0;
  return `translate(${x * z}px, ${y * z}px) scale(${z})`;
}
