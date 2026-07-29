/**
 * Máquina de estados PURA del editor de anotaciones de diapositivas
 * (`SlideAnnotationsDialog`). Sin React, sin DOM, sin Supabase → testeable en
 * aislado (ver slide-annotations-state.test.ts).
 *
 * Modela los dos mapas que el diálogo lleva en refs — `saved` (lo que está en
 * la DB) y `working` (lo que el docente ve) — más la disciplina del "eco de
 * montaje" de Excalidraw, que es donde se pierde trabajo si se hace mal.
 *
 * ── El eco de montaje ─────────────────────────────────────────────────────
 * Al montar el canvas con una escena, Excalidraw dispara un `onChange` que NO
 * es una edición del docente: devuelve la MISMA escena normalizada (completa
 * los campos que su versión agregó), así que su JSON no es byte-idéntico al
 * guardado. Sin absorber ese eco, abrir una diapositiva ya anotada y cerrarla
 * SIN TOCAR NADA marcaría "cambios sin guardar" y pediría confirmación.
 *
 * Absorberlo = mover la línea base (`saved[key]`) a la escena normalizada.
 * Y ahí está el filo: el eco no trae lo que hay en la DB, trae `working[key]`.
 * Volver a una diapositiva ya visitada RE-MONTA el canvas, así que produce un
 * eco nuevo; si esa diapositiva tenía trazos sin guardar, absorber ese eco
 * declararía "guardado" un trabajo que nunca se escribió — el aviso "hay
 * cambios sin guardar" desaparece, el botón Guardar queda deshabilitado y
 * cerrar no pide confirmación: los trazos se van sin una sola advertencia.
 *
 * Por eso el eco solo re-ancla la línea base cuando la diapositiva NO tenía
 * modificación pendiente (`saved[key]` y `working[key]` con el MISMO
 * contenido). Se compara CONTENIDO y no identidad de objeto a propósito: un
 * `onChange` benigno (pan/zoom, "Ajustar") reemplaza el objeto de `working`
 * sin cambiar los trazos, y con identidad eso bloquearía el re-anclaje de una
 * diapositiva que nadie tocó.
 */
import {
  annotatedSlideKeys,
  annotationsDirty,
  sceneHasContent,
  withSlideAnnotation,
  type SlideAnnotations,
} from "@/modules/contents/slide-deck";
import type { WhiteboardScene } from "@/modules/whiteboard/WhiteboardEditor";

export interface AnnotationsEditorState {
  /** Última versión CONFIRMADA (cargada de la DB o recién guardada). */
  readonly saved: SlideAnnotations;
  /** Lo que el docente ve — puede tener trazos sin guardar. */
  readonly working: SlideAnnotations;
  /**
   * Identidad del montaje del canvas cuyo eco ya se consumió (`clave:nonce`).
   * `""` = todavía no se vio ningún montaje.
   */
  readonly echoMountId: string;
}

/** Estado inicial (diálogo cerrado / sin cargar). */
export const EMPTY_ANNOTATIONS_EDITOR_STATE: AnnotationsEditorState = {
  saved: {},
  working: {},
  echoMountId: "",
};

/**
 * Estado tras cargar de la DB. `saved` y `working` arrancan siendo el MISMO
 * mapa: no hay nada pendiente.
 */
export function loadedAnnotationsState(map: SlideAnnotations): AnnotationsEditorState {
  return { saved: map, working: map, echoMountId: "" };
}

/**
 * Identidad del montaje actual del canvas. Cambia al navegar de diapositiva
 * (`key`) y cuando forzamos un re-montaje (`nonce`, ej. borrar las marcas).
 */
export function canvasMountId(key: string, nonce: number): string {
  return `${key}:${nonce}`;
}

/** ¿Dos escenas tienen el mismo contenido? (ausente == ausente) */
function sceneEqual(
  a: WhiteboardScene | null | undefined,
  b: WhiteboardScene | null | undefined,
): boolean {
  if (a === b) return true;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** ¿Esta diapositiva tiene trazos que todavía NO están en la DB? */
export function slideHasPendingChange(state: AnnotationsEditorState, key: string): boolean {
  return !sceneEqual(state.saved[key], state.working[key]);
}

/** ¿Hay algo sin guardar en CUALQUIER diapositiva? */
export function isAnnotationsEditorDirty(state: AnnotationsEditorState): boolean {
  return annotationsDirty(state.saved, state.working);
}

/** Claves con marcas visibles ahora mismo (para las insignias del diálogo). */
export function editorAnnotatedKeys(state: AnnotationsEditorState): string[] {
  return annotatedSlideKeys(state.working);
}

/**
 * Cambio reportado por el canvas. `mountId` es la identidad del montaje que lo
 * emitió: si NO coincide con el eco ya consumido, este cambio es el eco de un
 * montaje nuevo (ver el encabezado del archivo).
 */
export function applySceneChange(
  state: AnnotationsEditorState,
  ev: { key: string; mountId: string; scene: WhiteboardScene | null | undefined },
): AnnotationsEditorState {
  if (!ev.key) return state;
  const isMountEcho = state.echoMountId !== ev.mountId;
  // Se evalúa ANTES de aplicar el cambio: nos interesa si la diapositiva ya
  // traía trabajo pendiente al llegar el eco.
  const hadPending = slideHasPendingChange(state, ev.key);
  const working = withSlideAnnotation(state.working, ev.key, ev.scene);
  const canRebase =
    isMountEcho &&
    // Con trabajo pendiente el eco NO es la línea base: es ese trabajo.
    !hadPending &&
    // El eco de un re-montaje por "Borrar marcas" viene VACÍO, y ese borrado sí
    // es un cambio a guardar.
    sceneHasContent(ev.scene) &&
    // Sin escena confirmada previa no hay nada que re-anclar: contenido que
    // aparece de la nada se trata como cambio (falla del lado seguro).
    !!state.saved[ev.key];
  return {
    saved: canRebase ? withSlideAnnotation(state.saved, ev.key, ev.scene) : state.saved,
    working,
    echoMountId: ev.mountId,
  };
}

/**
 * "Borrar marcas" de la diapositiva actual. Solo toca `working`: el borrado
 * queda como cambio pendiente hasta que el docente guarde.
 */
export function applyClearSlide(
  state: AnnotationsEditorState,
  key: string,
): AnnotationsEditorState {
  if (!key) return state;
  return { ...state, working: withSlideAnnotation(state.working, key, null) };
}

/**
 * Guardado exitoso: `map` es EXACTAMENTE lo que se escribió en la DB. Si el
 * docente siguió rayando durante el round-trip, `working` ya avanzó y el
 * estado sigue sucio — correcto: ese trazo no está guardado.
 */
export function applySaveSucceeded(
  state: AnnotationsEditorState,
  map: SlideAnnotations,
): AnnotationsEditorState {
  return { ...state, saved: map };
}
