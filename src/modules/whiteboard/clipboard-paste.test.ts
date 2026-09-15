import { describe, it, expect } from "vitest";
import { parseExcalidrawClipboard, rehydratePastedElements, boundingBox } from "./clipboard-paste";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const el = (over: Record<string, any> = {}) => ({
  id: "a",
  type: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  version: 3,
  groupIds: [],
  ...over,
});

const payload = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  elements: Record<string, any>[],
  type = "excalidraw/clipboard",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra: Record<string, any> = {},
) => JSON.stringify({ type, elements, ...extra });

describe("parseExcalidrawClipboard", () => {
  it("reconoce el payload que Excalidraw pone en el portapapeles", () => {
    const r = parseExcalidrawClipboard(payload([el()]));
    expect(r).not.toBeNull();
    expect(r!.elements).toHaveLength(1);
  });

  it("acepta los tres tipos de escena y rechaza el de biblioteca", () => {
    for (const t of ["excalidraw", "excalidraw/clipboard", "excalidraw-api/clipboard"]) {
      expect(parseExcalidrawClipboard(payload([el()], t)), t).not.toBeNull();
    }
    // `excalidrawlib` es una BIBLIOTECA de figuras, no un pegado de escena:
    // Excalidraw la trata por otro camino y nosotros no debemos interceptarla.
    expect(parseExcalidrawClipboard(payload([el()], "excalidrawlib"))).toBeNull();
  });

  it("devuelve null para lo que NO debe interceptarse", () => {
    // Si esto devolviera algo, pegar texto normal dentro de una figura de
    // texto dejaría de funcionar — que es justo lo que no queremos romper.
    expect(parseExcalidrawClipboard("hola mundo")).toBeNull();
    expect(parseExcalidrawClipboard("")).toBeNull();
    expect(parseExcalidrawClipboard(null)).toBeNull();
    expect(parseExcalidrawClipboard(undefined)).toBeNull();
    expect(parseExcalidrawClipboard("https://excalidraw.com")).toBeNull();
    expect(parseExcalidrawClipboard('{"type":"otra-cosa","elements":[]}')).toBeNull();
    expect(parseExcalidrawClipboard('{"excalidraw":1,')).toBeNull(); // JSON roto
    expect(parseExcalidrawClipboard(payload([]))).toBeNull(); // sin elementos
    expect(parseExcalidrawClipboard('{"type":"excalidraw/clipboard"}')).toBeNull();
  });

  it("tolera espacios alrededor", () => {
    expect(parseExcalidrawClipboard(`\n  ${payload([el()])}  \n`)).not.toBeNull();
  });

  it("conserva los binarios de las imágenes", () => {
    const r = parseExcalidrawClipboard(
      payload([el({ type: "image", fileId: "f1" })], "excalidraw/clipboard", {
        files: { f1: { id: "f1", dataURL: "data:image/png;base64,AA" } },
      }),
    );
    expect(r!.files).toHaveProperty("f1");
  });
});

describe("boundingBox", () => {
  it("cubre todos los elementos", () => {
    expect(
      boundingBox([el({ x: 10, y: 20 }), el({ x: 100, y: 0, width: 40, height: 10 })]),
    ).toEqual({ minX: 10, minY: 0, maxX: 140, maxY: 70 });
  });
  it("devuelve null sin elementos", () => {
    expect(boundingBox([])).toBeNull();
  });
});

describe("rehydratePastedElements", () => {
  it("centra el conjunto en el punto pedido", () => {
    const out = rehydratePastedElements([el({ x: 0, y: 0, width: 100, height: 50 })], 500, 300);
    expect(out[0].x).toBe(450);
    expect(out[0].y).toBe(275);
  });

  it("le da identidad NUEVA a cada elemento", () => {
    const origen = [el({ id: "a" }), el({ id: "b" })];
    const out = rehydratePastedElements(origen, 0, 0);
    const ids = out.map((e) => e.id);
    expect(ids).not.toContain("a");
    expect(ids).not.toContain("b");
    expect(new Set(ids).size).toBe(2);
    // Pegar dos veces no puede producir ids repetidos en la escena.
    const otra = rehydratePastedElements(origen, 0, 0);
    expect(otra.map((e) => e.id).some((id) => ids.includes(id))).toBe(false);
  });

  it("no muta los elementos de origen", () => {
    const origen = [el({ id: "a", x: 7 })];
    rehydratePastedElements(origen, 900, 900);
    expect(origen[0].id).toBe("a");
    expect(origen[0].x).toBe(7);
  });

  it("remapea el texto atado a su contenedor (y no lo deja en el original)", () => {
    // Es el caso que rompe si se reusa `instantiateLibraryElements`: el rótulo
    // seguiría apuntando por containerId a la caja VIEJA.
    const caja = el({ id: "caja", boundElements: [{ id: "texto", type: "text" }] });
    const texto = el({ id: "texto", type: "text", containerId: "caja" });
    const out = rehydratePastedElements([caja, texto], 0, 0);
    const nuevaCaja = out[0];
    const nuevoTexto = out[1];
    expect(nuevoTexto.containerId).toBe(nuevaCaja.id);
    expect(nuevaCaja.boundElements[0].id).toBe(nuevoTexto.id);
    expect(nuevoTexto.containerId).not.toBe("caja");
  });

  it("remapea las puntas de una flecha atada", () => {
    const a = el({ id: "a" });
    const b = el({ id: "b" });
    const flecha = el({
      id: "f",
      type: "arrow",
      startBinding: { elementId: "a", focus: 0, gap: 1 },
      endBinding: { elementId: "b", focus: 0, gap: 1 },
    });
    const out = rehydratePastedElements([a, b, flecha], 0, 0);
    expect(out[2].startBinding.elementId).toBe(out[0].id);
    expect(out[2].endBinding.elementId).toBe(out[1].id);
    expect(out[2].startBinding.gap).toBe(1); // el resto del binding se conserva
  });

  it("corta las referencias a elementos que no se copiaron", () => {
    // Una flecha atada a una figura que quedó fuera de la selección no puede
    // quedar amarrada al original: al mover lo pegado arrastraría lo viejo.
    const flecha = el({
      id: "f",
      type: "arrow",
      startBinding: { elementId: "afuera" },
      endBinding: null,
      containerId: "afuera",
      frameId: "afuera",
      boundElements: [{ id: "afuera", type: "text" }],
    });
    const out = rehydratePastedElements([flecha], 0, 0);
    expect(out[0].startBinding).toBeNull();
    expect(out[0].containerId).toBeNull();
    expect(out[0].frameId).toBeNull();
    expect(out[0].boundElements).toEqual([]);
  });

  it("conserva la estructura de grupos pero con ids nuevos", () => {
    const out = rehydratePastedElements(
      [
        el({ id: "a", groupIds: ["g1"] }),
        el({ id: "b", groupIds: ["g1"] }),
        el({ id: "c", groupIds: ["g2"] }),
      ],
      0,
      0,
    );
    expect(out[0].groupIds[0]).toBe(out[1].groupIds[0]); // siguen juntos
    expect(out[2].groupIds[0]).not.toBe(out[0].groupIds[0]); // y separados del otro grupo
    expect(out[0].groupIds[0]).not.toBe("g1"); // sin chocar con el original
  });

  it("revive un elemento borrado y sube la versión", () => {
    const out = rehydratePastedElements([el({ isDeleted: true, version: 3 })], 0, 0);
    expect(out[0].isDeleted).toBe(false);
    expect(out[0].version).toBe(4);
  });

  it("no rompe con una lista vacía", () => {
    expect(rehydratePastedElements([], 0, 0)).toEqual([]);
  });
});
