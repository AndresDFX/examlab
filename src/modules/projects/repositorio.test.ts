import { describe, expect, it } from "vitest";
import { pideRepositorio, requiresRepositoryAlGuardar } from "./repositorio";

describe("pideRepositorio", () => {
  it("solo deja de pedirlo cuando el proyecto lo apagó explícitamente", () => {
    expect(pideRepositorio({ requires_repository: false })).toBe(false);
  });

  it("lo pide por defecto, incluso sin la columna o sin el proyecto cargado", () => {
    expect(pideRepositorio({ requires_repository: true })).toBe(true);
    expect(pideRepositorio({ requires_repository: null })).toBe(true);
    expect(pideRepositorio({})).toBe(true);
    expect(pideRepositorio(null)).toBe(true);
    expect(pideRepositorio(undefined)).toBe(true);
  });
});

describe("requiresRepositoryAlGuardar", () => {
  it("un proyecto que se queda pidiéndolo no manda la columna (sirve aunque la base no la tenga)", () => {
    expect(requiresRepositoryAlGuardar({}, null)).toEqual({});
    expect(requiresRepositoryAlGuardar({ requires_repository: true }, { requires_repository: true })).toEqual({});
    expect(requiresRepositoryAlGuardar({ requires_repository: true }, {})).toEqual({});
  });

  it("apagarlo la manda en false, al crear y al editar", () => {
    expect(requiresRepositoryAlGuardar({ requires_repository: false }, null)).toEqual({ requires_repository: false });
    expect(requiresRepositoryAlGuardar({ requires_repository: false }, { requires_repository: true })).toEqual({
      requires_repository: false,
    });
    expect(requiresRepositoryAlGuardar({ requires_repository: false }, { requires_repository: false })).toEqual({
      requires_repository: false,
    });
  });

  it("volver a encenderla la manda en true: sin eso el proyecto seguiría sin pedirlo", () => {
    expect(requiresRepositoryAlGuardar({ requires_repository: true }, { requires_repository: false })).toEqual({
      requires_repository: true,
    });
  });
});
