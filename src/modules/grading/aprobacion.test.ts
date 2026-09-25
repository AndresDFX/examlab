import { describe, expect, it } from "vitest";

import { NOTA_APROBATORIA_POR_DEFECTO, estaAprobada, varianteDeNota } from "./aprobacion";

describe("estaAprobada", () => {
  it("el caso reportado: 4,37 con umbral 3 aprueba", () => {
    expect(estaAprobada(4.37, 3)).toBe(true);
  });

  it("justo EN el umbral aprueba", () => {
    // «superior o igual al rango de aprobación» — el borde cuenta como aprobado.
    expect(estaAprobada(3, 3)).toBe(true);
  });

  it("por debajo del umbral, reprueba", () => {
    expect(estaAprobada(2.9, 3)).toBe(false);
  });

  it("sin nota devuelve null, NO reprobada", () => {
    // Tratar «todavía no hay nota» como reprobada pinta de rojo a quien solo
    // está esperando que lo califiquen.
    expect(estaAprobada(null, 3)).toBeNull();
    expect(estaAprobada(undefined, 3)).toBeNull();
    expect(estaAprobada(Number.NaN, 3)).toBeNull();
  });

  it("sin umbral configurado usa el mismo default que las actas", () => {
    expect(estaAprobada(NOTA_APROBATORIA_POR_DEFECTO, null)).toBe(true);
    expect(estaAprobada(NOTA_APROBATORIA_POR_DEFECTO - 0.01, undefined)).toBe(false);
  });

  it("respeta un umbral distinto del default", () => {
    // Una institución con escala sobre 100 y corte en 60.
    expect(estaAprobada(65, 60)).toBe(true);
    expect(estaAprobada(59, 60)).toBe(false);
  });

  it("un cero explícito es una nota, no una ausencia", () => {
    expect(estaAprobada(0, 3)).toBe(false);
  });
});

describe("varianteDeNota", () => {
  it("una nota aprobada NUNCA es roja", () => {
    expect(varianteDeNota(4.37, 3)).toBe("default");
    expect(varianteDeNota(3, 3)).toBe("default");
  });

  it("solo una nota reprobada es roja", () => {
    expect(varianteDeNota(1.5, 3)).toBe("destructive");
  });

  it("sin nota tampoco es roja", () => {
    expect(varianteDeNota(null, 3)).toBe("secondary");
  });
});
