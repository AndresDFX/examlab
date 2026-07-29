/**
 * Tests de la máquina dirty/eco del editor de anotaciones. El caso que motivó
 * extraerla: "ir a otra diapositiva y volver" marcaba como guardado el trabajo
 * pendiente de la diapositiva a la que se vuelve (el re-montaje del canvas
 * produce un eco, y el eco es el trabajo SIN guardar, no lo que hay en la DB).
 */
import { describe, expect, it } from "vitest";

import {
  EMPTY_ANNOTATIONS_EDITOR_STATE,
  applyClearSlide,
  applySaveSucceeded,
  applySceneChange,
  canvasMountId,
  editorAnnotatedKeys,
  isAnnotationsEditorDirty,
  loadedAnnotationsState,
  slideHasPendingChange,
} from "./slide-annotations-state";
import type { SlideAnnotations } from "./slide-deck";
import type { WhiteboardScene } from "@/modules/whiteboard/WhiteboardEditor";

const K3 = "deck.pptx.txt#2";
const K4 = "deck.pptx.txt#3";

/** Escena con `n` trazos. `tag` distingue contenidos con el mismo tamaño. */
const scene = (n: number, tag = ""): WhiteboardScene => ({
  elements: Array.from({ length: n }, (_, i) => ({ id: `e${i}${tag}`, type: "freedraw" })),
});

/**
 * Lo que Excalidraw devuelve al RESTAURAR una escena: los mismos trazos con los
 * campos que su versión completa. Contenido "igual" para el docente, JSON
 * distinto — es la razón de ser del re-anclaje del eco.
 */
const normalized = (s: WhiteboardScene): WhiteboardScene => ({
  ...s,
  elements: s.elements.map((e) => ({ ...e, version: 2, versionNonce: 42 })),
});

const empty: WhiteboardScene = { elements: [] };

/** Simula el montaje del canvas: emite el eco de lo que hay en `working`. */
function mountEcho(
  state: Parameters<typeof applySceneChange>[0],
  key: string,
  nonce: number,
  transform: (s: WhiteboardScene | undefined) => WhiteboardScene | null = (s) =>
    s ? normalized(s) : null,
) {
  return applySceneChange(state, {
    key,
    mountId: canvasMountId(key, nonce),
    scene: transform(state.working[key]),
  });
}

/** Simula un trazo del docente sobre el montaje ACTUAL (no es eco). */
function draw(
  state: Parameters<typeof applySceneChange>[0],
  key: string,
  nonce: number,
  next: WhiteboardScene,
) {
  return applySceneChange(state, { key, mountId: canvasMountId(key, nonce), scene: next });
}

describe("estado inicial y carga", () => {
  it("arranca limpio y sin diapositivas anotadas", () => {
    expect(isAnnotationsEditorDirty(EMPTY_ANNOTATIONS_EDITOR_STATE)).toBe(false);
    expect(editorAnnotatedKeys(EMPTY_ANNOTATIONS_EDITOR_STATE)).toEqual([]);
  });

  it("lo cargado de la DB no cuenta como cambio", () => {
    const st = loadedAnnotationsState({ [K3]: scene(2) });
    expect(isAnnotationsEditorDirty(st)).toBe(false);
    expect(slideHasPendingChange(st, K3)).toBe(false);
    expect(editorAnnotatedKeys(st)).toEqual([K3]);
  });
});

describe("(a) el eco de montaje no ensucia", () => {
  it("abrir una diapositiva ya anotada y no tocar nada deja el estado limpio", () => {
    const saved: SlideAnnotations = { [K3]: scene(2) };
    let st = loadedAnnotationsState(saved);
    st = mountEcho(st, K3, 0);
    expect(isAnnotationsEditorDirty(st)).toBe(false);
    // El re-anclaje movió la línea base a la escena normalizada.
    expect(st.saved[K3]).toEqual(normalized(scene(2)));
  });

  it("re-montajes repetidos de una diapositiva intacta siguen limpios", () => {
    let st = loadedAnnotationsState({ [K3]: scene(2) });
    st = mountEcho(st, K3, 0);
    st = mountEcho(st, K3, 1);
    st = mountEcho(st, K3, 2);
    expect(isAnnotationsEditorDirty(st)).toBe(false);
  });

  it("un onChange benigno (pan/zoom) no bloquea el re-anclaje posterior", () => {
    // El pan reemplaza el objeto de `working` sin cambiar los trazos: si el
    // re-anclaje comparara IDENTIDAD, este caso quedaría marcado como sucio al
    // volver a la diapositiva.
    let st = loadedAnnotationsState({ [K3]: scene(2) });
    st = mountEcho(st, K3, 0);
    st = draw(st, K3, 0, { ...st.working[K3], elements: [...st.working[K3].elements] });

    // ESTA es la aserción que discrimina, y sin ella el test no probaba su
    // propio título: con comparación por CONTENIDO el estado nunca se ensucia,
    // así que el `dirty === false` del final pasaba de forma trivial — haya
    // habido re-anclaje o no. Comparando por IDENTIDAD, en cambio, el objeto
    // nuevo del pan marcaría la diapositiva como pendiente acá y bloquearía el
    // re-anclaje de abajo. O sea: este expect falla bajo la implementación
    // frágil y pasa bajo la correcta.
    expect(slideHasPendingChange(st, K3)).toBe(false);

    st = mountEcho(st, K4, 0, () => null);
    st = mountEcho(st, K3, 0);
    expect(isAnnotationsEditorDirty(st)).toBe(false);
  });

  it("una diapositiva SIN nada guardado que se monta vacía queda limpia", () => {
    let st = loadedAnnotationsState({});
    st = mountEcho(st, K3, 0, () => empty);
    expect(isAnnotationsEditorDirty(st)).toBe(false);
    expect(editorAnnotatedKeys(st)).toEqual([]);
  });
});

describe("(b) el eco NO limpia una modificación pendiente", () => {
  it("rayar sobre una diapositiva ya guardada la deja pendiente", () => {
    let st = loadedAnnotationsState({ [K3]: scene(2) });
    st = mountEcho(st, K3, 0);
    st = draw(st, K3, 0, scene(5));
    expect(isAnnotationsEditorDirty(st)).toBe(true);
    expect(slideHasPendingChange(st, K3)).toBe(true);
  });

  it("REGRESIÓN: volver a la diapositiva NO marca sus trazos como guardados", () => {
    // Escenario de clase: la 3 tenía anotación guardada → el docente raya más →
    // pasa a la 4 → vuelve a la 3. El re-montaje emite un eco cuyo mountId es
    // el de la 3 mientras el eco consumido era el de la 4.
    let st = loadedAnnotationsState({ [K3]: scene(2) });
    st = mountEcho(st, K3, 0);
    st = draw(st, K3, 0, scene(5));
    st = mountEcho(st, K4, 0, () => null); // vamos a la 4 (sin anotaciones)
    st = mountEcho(st, K3, 0); // volvemos a la 3
    expect(isAnnotationsEditorDirty(st)).toBe(true);
    expect(slideHasPendingChange(st, K3)).toBe(true);
    // Y lo que se guardaría sigue siendo el trabajo del docente.
    expect(st.working[K3].elements).toHaveLength(5);
  });

  it("el eco de 'Borrar marcas' (escena vacía) conserva el borrado pendiente", () => {
    let st = loadedAnnotationsState({ [K3]: scene(2) });
    st = mountEcho(st, K3, 0);
    st = applyClearSlide(st, K3);
    expect(isAnnotationsEditorDirty(st)).toBe(true);
    // El re-montaje forzado (nonce+1) emite un eco VACÍO.
    st = mountEcho(st, K3, 1, () => empty);
    expect(isAnnotationsEditorDirty(st)).toBe(true);
    expect(editorAnnotatedKeys(st)).toEqual([]);
    expect(st.saved[K3]).toBeDefined();
  });

  it("dibujar en una diapositiva virgen y volver conserva los trazos pendientes", () => {
    let st = loadedAnnotationsState({});
    st = mountEcho(st, K3, 0, () => null);
    st = draw(st, K3, 0, scene(3));
    st = mountEcho(st, K4, 0, () => null);
    st = mountEcho(st, K3, 0);
    expect(isAnnotationsEditorDirty(st)).toBe(true);
    expect(editorAnnotatedKeys(st)).toEqual([K3]);
  });
});

describe("(c) ir y volver preserva el dirty de cada diapositiva", () => {
  it("cada diapositiva mantiene su propio estado pendiente", () => {
    let st = loadedAnnotationsState({ [K3]: scene(2) });
    // 3: se le agregan trazos (pendiente).
    st = mountEcho(st, K3, 0);
    st = draw(st, K3, 0, scene(4));
    // 4: virgen, se monta y no se toca (no pendiente).
    st = mountEcho(st, K4, 0, () => null);
    expect(slideHasPendingChange(st, K4)).toBe(false);
    expect(slideHasPendingChange(st, K3)).toBe(true);
    // Volvemos a la 3, después otra vez a la 4: nada de eso cambia nada.
    st = mountEcho(st, K3, 0);
    st = mountEcho(st, K4, 0, () => null);
    expect(slideHasPendingChange(st, K3)).toBe(true);
    expect(slideHasPendingChange(st, K4)).toBe(false);
    expect(isAnnotationsEditorDirty(st)).toBe(true);
  });

  it("las marcas de una diapositiva no se filtran a la otra", () => {
    let st = loadedAnnotationsState({});
    st = draw(st, K3, 0, scene(2, "a"));
    st = draw(st, K4, 0, scene(1, "b"));
    expect(editorAnnotatedKeys(st)).toEqual([K3, K4].sort());
    expect(st.working[K3]).not.toEqual(st.working[K4]);
  });
});

describe("(d) guardar limpia solo lo guardado", () => {
  it("un guardado exitoso deja el estado limpio", () => {
    let st = loadedAnnotationsState({ [K3]: scene(2) });
    st = mountEcho(st, K3, 0);
    st = draw(st, K3, 0, scene(6));
    st = applySaveSucceeded(st, st.working);
    expect(isAnnotationsEditorDirty(st)).toBe(false);
    expect(slideHasPendingChange(st, K3)).toBe(false);
  });

  it("lo que se rayó DURANTE el guardado sigue pendiente", () => {
    let st = loadedAnnotationsState({});
    st = draw(st, K3, 0, scene(2));
    const enviado = st.working; // snapshot que viajó al upsert
    st = draw(st, K3, 0, scene(3)); // el docente siguió rayando
    st = applySaveSucceeded(st, enviado);
    expect(isAnnotationsEditorDirty(st)).toBe(true);
    expect(slideHasPendingChange(st, K3)).toBe(true);
  });

  it("guardar la 3 no marca como guardada la 4", () => {
    let st = loadedAnnotationsState({});
    st = draw(st, K3, 0, scene(2));
    const enviado = st.working; // solo contiene la 3
    st = draw(st, K4, 0, scene(1));
    st = applySaveSucceeded(st, enviado);
    expect(slideHasPendingChange(st, K3)).toBe(false);
    expect(slideHasPendingChange(st, K4)).toBe(true);
    expect(isAnnotationsEditorDirty(st)).toBe(true);
  });

  it("tras guardar, volver a la diapositiva no la vuelve a marcar sucia", () => {
    let st = loadedAnnotationsState({ [K3]: scene(2) });
    st = mountEcho(st, K3, 0);
    st = draw(st, K3, 0, scene(6));
    st = applySaveSucceeded(st, st.working);
    st = mountEcho(st, K4, 0, () => null);
    st = mountEcho(st, K3, 0);
    expect(isAnnotationsEditorDirty(st)).toBe(false);
  });

  it("un guardado FALLIDO no toca el estado (nadie llama applySaveSucceeded)", () => {
    let st = loadedAnnotationsState({ [K3]: scene(2) });
    st = mountEcho(st, K3, 0);
    st = draw(st, K3, 0, scene(9));
    const antes = st;
    // El diálogo solo aplica el save cuando el upsert responde OK.
    expect(isAnnotationsEditorDirty(antes)).toBe(true);
    expect(antes.working[K3].elements).toHaveLength(9);
  });
});

describe("guardas", () => {
  it("un cambio sin clave de diapositiva se ignora", () => {
    const st = loadedAnnotationsState({ [K3]: scene(1) });
    expect(applySceneChange(st, { key: "", mountId: "x", scene: scene(3) })).toBe(st);
    expect(applyClearSlide(st, "")).toBe(st);
  });

  it("canvasMountId distingue diapositiva y re-montaje", () => {
    expect(canvasMountId(K3, 0)).toBe(`${K3}:0`);
    expect(canvasMountId(K3, 1)).not.toBe(canvasMountId(K3, 0));
    expect(canvasMountId(K4, 0)).not.toBe(canvasMountId(K3, 0));
  });
});
