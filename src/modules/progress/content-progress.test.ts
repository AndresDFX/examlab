import { describe, expect, it } from "vitest";
import { computeMaterialProgress, progressKey, type RenderedFile } from "./content-progress";

const f = (contentId: string, filePath: string): RenderedFile => ({
  contentId,
  filePath,
});

describe("progressKey", () => {
  it("compone contenido y archivo con un separador que ninguno contiene", () => {
    expect(progressKey("c1", "uid/c1/clase.pdf")).toBe("c1|uid/c1/clase.pdf");
  });

  it("distingue el mismo nombre de archivo bajo contenidos distintos", () => {
    // Dos contenidos pueden tener un archivo con el mismo slug final; el path
    // completo ya los separa, pero la clave no debe depender de eso.
    expect(progressKey("c1", "a/c1/guia.pdf")).not.toBe(progressKey("c2", "a/c2/guia.pdf"));
  });
});

describe("computeMaterialProgress — dedupe", () => {
  it("el MISMO archivo renderizado bajo 2 sesiones cuenta UNA vez", () => {
    // Es el riesgo central: el tablero muestra el mismo archivo bajo varias
    // sesiones (por el fallback de filtro por clase, por content_file_paths
    // repetido, o por estar en sesión y además asignado al curso). Sin dedupe
    // el total se infla y el conteo puede superar al denominador.
    const rendered = [f("c1", "p/1.pdf"), f("c1", "p/1.pdf"), f("c1", "p/1.pdf")];
    const out = computeMaterialProgress(rendered, new Set([progressKey("c1", "p/1.pdf")]));
    expect(out.total).toBe(1);
    expect(out.viewed).toBe(1);
  });

  it("el conteo visto NUNCA supera al total", () => {
    const rendered = [f("c1", "p/1.pdf"), f("c1", "p/1.pdf")];
    const viewed = new Set([progressKey("c1", "p/1.pdf")]);
    const out = computeMaterialProgress(rendered, viewed);
    expect(out.viewed).toBeLessThanOrEqual(out.total);
  });
});

describe("computeMaterialProgress — intersección", () => {
  it("ignora las filas huérfanas del regen completo con IA", () => {
    // Un regen completo reescribe files[] con paths nuevos: el progreso viejo
    // apunta a archivos que ya no existen. Deben ignorarse sin inflar nada.
    const rendered = [f("c1", "p/nuevo-1.pdf"), f("c1", "p/nuevo-2.pdf")];
    const viewed = new Set([
      progressKey("c1", "p/viejo-a.pdf"),
      progressKey("c1", "p/viejo-b.pdf"),
      progressKey("c1", "p/nuevo-1.pdf"),
    ]);
    const out = computeMaterialProgress(rendered, viewed);
    expect(out.total).toBe(2);
    expect(out.viewed).toBe(1);
  });

  it("progreso de OTRO contenido no cuenta para este set", () => {
    const rendered = [f("c1", "p/1.pdf")];
    const viewed = new Set([progressKey("c2", "p/1.pdf")]);
    expect(computeMaterialProgress(rendered, viewed).viewed).toBe(0);
  });
});

describe("computeMaterialProgress — bordes", () => {
  it("sin material renderizado → total 0 (la UI muestra '—', no '0 de 0')", () => {
    const out = computeMaterialProgress([], new Set([progressKey("c1", "p/1.pdf")]));
    expect(out).toEqual({ viewed: 0, total: 0 });
  });

  it("sin nada visto → viewed 0 pero total real", () => {
    const out = computeMaterialProgress([f("c1", "a"), f("c1", "b")], new Set());
    expect(out).toEqual({ viewed: 0, total: 2 });
  });

  it("todo visto → viewed === total", () => {
    const rendered = [f("c1", "a"), f("c1", "b"), f("c2", "c")];
    const viewed = new Set(rendered.map((r) => progressKey(r.contentId, r.filePath)));
    const out = computeMaterialProgress(rendered, viewed);
    expect(out.viewed).toBe(3);
    expect(out.total).toBe(3);
  });

  it("descarta entradas sin contentId o sin filePath (datos defensivos)", () => {
    // El tipo lo previene, pero los datos vienen de un JSONB: una entrada sin
    // `path` no debe contarse como un archivo del denominador.
    const rendered = [f("c1", "a"), f("", "b"), f("c1", "")];
    expect(computeMaterialProgress(rendered, new Set()).total).toBe(1);
  });

  it("cuenta contenidos distintos por separado", () => {
    const rendered = [f("c1", "a"), f("c2", "a"), f("c3", "a")];
    expect(computeMaterialProgress(rendered, new Set()).total).toBe(3);
  });

  it("no muta las entradas recibidas", () => {
    const rendered = [f("c1", "a")];
    const viewed = new Set([progressKey("c1", "a")]);
    computeMaterialProgress(rendered, viewed);
    expect(rendered).toEqual([{ contentId: "c1", filePath: "a" }]);
    expect(viewed.size).toBe(1);
  });
});
