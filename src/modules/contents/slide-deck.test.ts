import { describe, it, expect } from "vitest";

import {
  SLIDE_H,
  SLIDE_W,
  annotationKey,
  annotatedSlideKeys,
  annotationsDirty,
  buildSlideDeck,
  deckSlideLabel,
  estimateAnnotationsBytes,
  fitViewport,
  isAnnotatableFile,
  isSlideImageFile,
  isSlideSourceFile,
  sanitizeAnnotations,
  sceneHasContent,
  serializeAnnotations,
  stageTransform,
  withSlideAnnotation,
  type ContentFileLike,
  type SlideAnnotations,
} from "./slide-deck";

const PPTX_BODY = [
  "Slide 1 (Portada): Programación orientada a objetos",
  "- Universidad Demo",
  "Slide 2 (Objetivos): Qué vamos a lograr",
  "- Entender clases",
  "- Entender objetos",
  "Slide 3 (Herencia): Reutilizar comportamiento",
].join("\n");

const pptxFile: ContentFileLike = {
  name: "PRESENTACION_CLASE_1.pptx",
  path: "teacher/content/PRESENTACION_CLASE_1.pptx.txt",
  kind: "pptx-source",
  body: PPTX_BODY,
};
const imgFile: ContentFileLike = {
  name: "diapositiva-01.png",
  path: "teacher/content/diapositiva-01.png",
  kind: "uploaded",
};

const scene = (n: number) => ({ elements: Array.from({ length: n }, (_, i) => ({ id: `e${i}` })) });

describe("detección de archivos anotables", () => {
  it("acepta pptx-source con body", () => {
    expect(isSlideSourceFile(pptxFile)).toBe(true);
    expect(isAnnotatableFile(pptxFile)).toBe(true);
  });

  it("rechaza pptx-source SIN body (no hay nada que renderizar)", () => {
    expect(isSlideSourceFile({ ...pptxFile, body: undefined })).toBe(false);
    expect(isSlideSourceFile({ ...pptxFile, body: "   " })).toBe(false);
  });

  it("acepta imágenes (incluidas svg/gif: la anotación es una capa aparte)", () => {
    expect(isSlideImageFile(imgFile)).toBe(true);
    expect(isSlideImageFile({ name: "esquema.svg", path: "p/esquema.svg" })).toBe(true);
    expect(isSlideImageFile({ name: "anim.gif", path: "p/anim.gif" })).toBe(true);
  });

  it("rechaza lo que no podemos rasterizar en el cliente", () => {
    for (const name of ["deck.pptx", "guia.pdf", "notas.docx", "main.java", "datos.csv"]) {
      expect(isAnnotatableFile({ name, path: `p/${name}`, kind: "uploaded" })).toBe(false);
    }
  });

  it("tolera entradas nulas", () => {
    expect(isAnnotatableFile(null)).toBe(false);
    expect(isAnnotatableFile(undefined)).toBe(false);
  });
});

describe("buildSlideDeck", () => {
  it("aplana un pptx-source a una diapositiva por slide parseada", () => {
    const deck = buildSlideDeck([pptxFile]);
    expect(deck).toHaveLength(3);
    expect(deck.map((d) => d.index)).toEqual([0, 1, 2]);
    expect(deck[0].kind).toBe("text");
    expect(deck[0].slide?.title).toBe("Portada");
    expect(deck[0].key).toBe(`${pptxFile.path}#0`);
    expect(deck[2].key).toBe(`${pptxFile.path}#2`);
  });

  it("mapea cada imagen a UNA diapositiva con índice 0", () => {
    const deck = buildSlideDeck([imgFile, { ...imgFile, name: "d2.jpg", path: "p/d2.jpg" }]);
    expect(deck).toHaveLength(2);
    expect(deck.every((d) => d.index === 0 && d.kind === "image")).toBe(true);
    expect(deck[0].key).not.toBe(deck[1].key);
  });

  it("descarta archivos no anotables y preserva el orden de files[]", () => {
    const deck = buildSlideDeck([
      { name: "guia.pdf", path: "p/guia.pdf" },
      imgFile,
      { name: "deck.pptx", path: "p/deck.pptx" },
      pptxFile,
    ]);
    expect(deck.map((d) => d.fileName)).toEqual([
      imgFile.name,
      pptxFile.name,
      pptxFile.name,
      pptxFile.name,
    ]);
  });

  it("cae al name cuando el path viene vacío", () => {
    const deck = buildSlideDeck([{ name: "d.png", path: "" }]);
    expect(deck[0].key).toBe("d.png#0");
  });

  it("no explota con files nulo / vacío / entradas basura", () => {
    expect(buildSlideDeck(null)).toEqual([]);
    expect(buildSlideDeck(undefined)).toEqual([]);
    expect(buildSlideDeck([])).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(buildSlideDeck([null as any, { path: "x" } as any])).toEqual([]);
  });

  it("genera claves únicas entre archivos distintos con el mismo índice", () => {
    const deck = buildSlideDeck([pptxFile, imgFile]);
    expect(new Set(deck.map((d) => d.key)).size).toBe(deck.length);
  });
});

describe("deckSlideLabel", () => {
  it("usa el título de la diapositiva cuando lo hay", () => {
    const deck = buildSlideDeck([pptxFile]);
    expect(deckSlideLabel(deck[1], 2)).toBe("2. Objetivos");
  });

  it("cae al nombre del archivo para imágenes o títulos vacíos", () => {
    const deck = buildSlideDeck([imgFile]);
    expect(deckSlideLabel(deck[0], 1)).toBe("1. diapositiva-01.png");
  });
});

describe("mapa de anotaciones", () => {
  it("annotationKey es estable", () => {
    expect(annotationKey("a/b.png", 3)).toBe("a/b.png#3");
  });

  it("sceneHasContent distingue escena vacía de escena con trazos", () => {
    expect(sceneHasContent(null)).toBe(false);
    expect(sceneHasContent({ elements: [] })).toBe(false);
    expect(sceneHasContent(scene(1))).toBe(true);
  });

  it("withSlideAnnotation setea sin mutar el original", () => {
    const base: SlideAnnotations = {};
    const next = withSlideAnnotation(base, "k#0", scene(2));
    expect(base).toEqual({});
    expect(Object.keys(next)).toEqual(["k#0"]);
  });

  it("withSlideAnnotation ELIMINA la clave cuando la escena queda vacía", () => {
    const map = withSlideAnnotation({}, "k#0", scene(1));
    const cleared = withSlideAnnotation(map, "k#0", { elements: [] });
    expect(cleared["k#0"]).toBeUndefined();
    expect(annotatedSlideKeys(cleared)).toEqual([]);
  });

  it("las anotaciones de una diapositiva NO se filtran a otra", () => {
    let map: SlideAnnotations = {};
    map = withSlideAnnotation(map, "f#0", scene(1));
    map = withSlideAnnotation(map, "f#1", scene(3));
    expect(map["f#0"].elements).toHaveLength(1);
    expect(map["f#1"].elements).toHaveLength(3);
  });

  it("annotatedSlideKeys devuelve solo las anotadas, ordenadas", () => {
    const map: SlideAnnotations = {
      "b#0": scene(1),
      "a#0": scene(1),
      "c#0": { elements: [] },
    };
    expect(annotatedSlideKeys(map)).toEqual(["a#0", "b#0"]);
  });
});

describe("dirty tracking", () => {
  it("no es dirty cuando el contenido es igual pero el orden de claves difiere", () => {
    const a: SlideAnnotations = { "x#0": scene(1), "y#0": scene(2) };
    const b: SlideAnnotations = {};
    b["y#0"] = scene(2);
    b["x#0"] = scene(1);
    expect(serializeAnnotations(a)).toBe(serializeAnnotations(b));
    expect(annotationsDirty(a, b)).toBe(false);
  });

  it("es dirty al agregar, cambiar o borrar una anotación", () => {
    const saved: SlideAnnotations = { "x#0": scene(1) };
    expect(annotationsDirty(saved, withSlideAnnotation(saved, "y#0", scene(1)))).toBe(true);
    expect(annotationsDirty(saved, withSlideAnnotation(saved, "x#0", scene(2)))).toBe(true);
    expect(annotationsDirty(saved, withSlideAnnotation(saved, "x#0", { elements: [] }))).toBe(true);
  });

  it("dos mapas vacíos no son dirty (abrir y cerrar sin tocar nada)", () => {
    expect(annotationsDirty({}, {})).toBe(false);
  });
});

describe("sanitizeAnnotations", () => {
  it("normaliza lo que viene de la DB", () => {
    const raw = {
      "ok#0": { elements: [{ id: "1" }], appState: { viewBackgroundColor: "transparent" } },
      "vacia#0": { elements: [] },
      "mala#0": { elements: "nope" },
      "nula#0": null,
      "array#0": [1, 2],
    };
    expect(Object.keys(sanitizeAnnotations(raw))).toEqual(["ok#0"]);
  });

  it("devuelve {} para valores no-objeto", () => {
    expect(sanitizeAnnotations(null)).toEqual({});
    expect(sanitizeAnnotations(undefined)).toEqual({});
    expect(sanitizeAnnotations("{}")).toEqual({});
    expect(sanitizeAnnotations([1])).toEqual({});
  });
});

describe("estimateAnnotationsBytes", () => {
  it("crece con el contenido y es 2 para el mapa vacío", () => {
    expect(estimateAnnotationsBytes({})).toBe(2);
    expect(estimateAnnotationsBytes({ "a#0": scene(50) })).toBeGreaterThan(100);
  });
});

describe("fitViewport", () => {
  it("encaja y centra la diapositiva en un área más ancha que 16:9", () => {
    const vp = fitViewport(1920, 540);
    expect(vp.zoom).toBeCloseTo(1, 5); // limita el alto: 540/540
    // La diapositiva (960 de ancho) queda centrada en 1920 px.
    expect(vp.scrollX).toBeCloseTo((1920 - 960) / 2, 5);
    expect(vp.scrollY).toBeCloseTo(0, 5);
  });

  it("encaja y centra en un área más alta que 16:9", () => {
    const vp = fitViewport(480, 1000);
    expect(vp.zoom).toBeCloseTo(0.5, 5); // limita el ancho: 480/960
    expect(vp.scrollX).toBeCloseTo(0, 5);
    expect(vp.scrollY).toBeCloseTo((1000 - SLIDE_H * 0.5) / (2 * 0.5), 5);
  });

  it("la esquina de la diapositiva cae donde dice el mapeo de Excalidraw", () => {
    const box = { w: 800, h: 600 };
    const vp = fitViewport(box.w, box.h);
    // pantalla = (escena + scroll) * zoom
    const left = (0 + vp.scrollX) * vp.zoom;
    const right = (SLIDE_W + vp.scrollX) * vp.zoom;
    expect(left).toBeCloseTo((box.w - SLIDE_W * vp.zoom) / 2, 5);
    expect(right).toBeCloseTo(box.w - left, 5);
  });

  it("degrada a zoom 1 con medidas inválidas (contenedor sin medir aún)", () => {
    expect(fitViewport(0, 0)).toEqual({ scrollX: 0, scrollY: 0, zoom: 1 });
    expect(fitViewport(Number.NaN, 100)).toEqual({ scrollX: 0, scrollY: 0, zoom: 1 });
    expect(fitViewport(-10, -10)).toEqual({ scrollX: 0, scrollY: 0, zoom: 1 });
  });
});

describe("stageTransform", () => {
  it("traduce el viewport a un transform CSS con origen 0 0", () => {
    expect(stageTransform({ scrollX: 10, scrollY: 20, zoom: 2 })).toBe(
      "translate(20px, 40px) scale(2)",
    );
  });

  it("blinda valores inválidos", () => {
    expect(stageTransform({ scrollX: Number.NaN, scrollY: 0, zoom: 0 })).toBe(
      "translate(0px, 0px) scale(1)",
    );
  });
});
