import { describe, expect, it } from "vitest";
import {
  baseMasNueva,
  contarCambios,
  diffPlantillas,
  lineasComparables,
  soloCambios,
} from "./plantilla-diff";

describe("lineasComparables", () => {
  it("corta el HTML de una sola línea en bloques comparables", () => {
    // El editor visual guarda todo en una línea: sin este corte, cualquier
    // cambio se leería como "cambió todo el documento".
    expect(lineasComparables("<p>Uno</p><p>Dos</p>")).toEqual(["<p>Uno</p>", "<p>Dos</p>"]);
  });

  it("ignora los espacios entre etiquetas y las líneas vacías", () => {
    expect(lineasComparables("<p>A</p>\n\n   <p>B</p>  ")).toEqual(["<p>A</p>", "<p>B</p>"]);
  });

  it("nulo o vacío da una lista vacía", () => {
    expect(lineasComparables(null)).toEqual([]);
    expect(lineasComparables("")).toEqual([]);
  });
});

describe("diffPlantillas", () => {
  it("dos plantillas idénticas no tienen cambios", () => {
    const d = diffPlantillas("<p>A</p><p>B</p>", "<p>A</p><p>B</p>");
    expect(contarCambios(d)).toEqual({ agregadas: 0, quitadas: 0 });
    expect(d.every((l) => l.tipo === "igual")).toBe(true);
  });

  it("marca lo que el docente agregó y lo que la base tiene y él no", () => {
    const d = diffPlantillas("<p>A</p><p>B</p>", "<p>A</p><p>C</p>");
    expect(d.filter((l) => l.tipo === "quitada").map((l) => l.texto)).toEqual(["<p>B</p>"]);
    expect(d.filter((l) => l.tipo === "agregada").map((l) => l.texto)).toEqual(["<p>C</p>"]);
    // Y conserva lo común, en orden.
    expect(d[0]).toEqual({ tipo: "igual", texto: "<p>A</p>" });
  });

  it("una sección NUEVA de la base aparece completa como quitada", () => {
    const base = "<p>A</p><p>Nueva sección</p><p>B</p>";
    const propia = "<p>A</p><p>B</p>";
    const d = diffPlantillas(base, propia);
    expect(contarCambios(d)).toEqual({ agregadas: 0, quitadas: 1 });
    expect(d.find((l) => l.tipo === "quitada")!.texto).toBe("<p>Nueva sección</p>");
  });

  it("una plantilla vacía contra otra con contenido: todo es cambio", () => {
    expect(contarCambios(diffPlantillas("", "<p>A</p>"))).toEqual({
      agregadas: 1,
      quitadas: 0,
    });
    expect(contarCambios(diffPlantillas("<p>A</p>", ""))).toEqual({
      agregadas: 0,
      quitadas: 1,
    });
  });

  it("el resultado preserva TODAS las líneas de los dos lados", () => {
    const d = diffPlantillas("<p>A</p><p>B</p><p>C</p>", "<p>A</p><p>X</p><p>C</p>");
    const enBase = d.filter((l) => l.tipo !== "agregada").length;
    const enPropia = d.filter((l) => l.tipo !== "quitada").length;
    expect(enBase).toBe(3);
    expect(enPropia).toBe(3);
  });
});

describe("soloCambios", () => {
  it("deja las líneas cambiadas con una de contexto", () => {
    const d = diffPlantillas(
      "<p>1</p><p>2</p><p>3</p><p>4</p><p>5</p>",
      "<p>1</p><p>2</p><p>X</p><p>4</p><p>5</p>",
    );
    const r = soloCambios(d, 1);
    expect(r.length).toBeLessThan(d.length);
    expect(r.some((l) => l.texto === "<p>X</p>")).toBe(true);
    // La primera línea, lejos del cambio, no entra.
    expect(r.some((l) => l.texto === "<p>1</p>")).toBe(false);
  });

  it("sin cambios no devuelve nada", () => {
    expect(soloCambios(diffPlantillas("<p>A</p>", "<p>A</p>"))).toEqual([]);
  });
});

describe("baseMasNueva", () => {
  it("true solo cuando la base se tocó DESPUÉS de la personalizada", () => {
    expect(baseMasNueva("2026-09-01T00:00:00Z", "2026-08-01T00:00:00Z")).toBe(true);
    expect(baseMasNueva("2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z")).toBe(false);
    expect(baseMasNueva("2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z")).toBe(false);
  });

  it("sin fecha de un lado no se inventa un aviso", () => {
    expect(baseMasNueva(null, "2026-08-01T00:00:00Z")).toBe(false);
    expect(baseMasNueva("2026-08-01T00:00:00Z", undefined)).toBe(false);
    expect(baseMasNueva("no es fecha", "2026-08-01T00:00:00Z")).toBe(false);
  });
});
