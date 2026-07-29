import { describe, expect, it } from "vitest";
import { ACTIVITY_STATUS_OPTIONS, matchesActivityStatus, DEFAULT_ACTIVITY_STATUS_FILTER } from "./status-filter";

describe("matchesActivityStatus", () => {
  it("el default es 'activos' (oculta cerrados, muestra borradores y publicados)", () => {
    expect(DEFAULT_ACTIVITY_STATUS_FILTER).toBe("activos");
    expect(matchesActivityStatus("draft", "activos")).toBe(true);
    expect(matchesActivityStatus("published", "activos")).toBe(true);
    expect(matchesActivityStatus("closed", "activos")).toBe(false);
  });

  it("'cerrados' muestra solo los cerrados", () => {
    expect(matchesActivityStatus("closed", "cerrados")).toBe(true);
    expect(matchesActivityStatus("draft", "cerrados")).toBe(false);
    expect(matchesActivityStatus("published", "cerrados")).toBe(false);
  });

  it("'todos' muestra todo", () => {
    expect(matchesActivityStatus("draft", "todos")).toBe(true);
    expect(matchesActivityStatus("published", "todos")).toBe(true);
    expect(matchesActivityStatus("closed", "todos")).toBe(true);
  });

  it("status nullish se asume 'published' (no cerrado) → visible en activos", () => {
    expect(matchesActivityStatus(null, "activos")).toBe(true);
    expect(matchesActivityStatus(undefined, "activos")).toBe(true);
    expect(matchesActivityStatus(null, "cerrados")).toBe(false);
  });

  // Opciones POR ESTADO. Antes el filtro solo tenía activos/cerrados/todos, así
  // que un docente no podía aislar sus BORRADORES: quedaban mezclados con los
  // publicados dentro de "Activos". Reportado sobre Pizarras y aplicaba a los 4
  // grids que comparten el componente.
  it("'borradores' aísla SOLO los draft", () => {
    expect(matchesActivityStatus("draft", "borradores")).toBe(true);
    expect(matchesActivityStatus("published", "borradores")).toBe(false);
    expect(matchesActivityStatus("closed", "borradores")).toBe(false);
    // Un status nullish se asume publicado, así que NO es borrador.
    expect(matchesActivityStatus(null, "borradores")).toBe(false);
  });

  it("'publicados' aísla SOLO los published (incluido el nullish)", () => {
    expect(matchesActivityStatus("published", "publicados")).toBe(true);
    expect(matchesActivityStatus(null, "publicados")).toBe(true);
    expect(matchesActivityStatus("draft", "publicados")).toBe(false);
    expect(matchesActivityStatus("closed", "publicados")).toBe(false);
  });

  it("las opciones individuales PARTICIONAN el universo: cada estado cae en exactamente una", () => {
    // Guard contra agregar una opción y olvidar su rama en el switch: un estado
    // que no matchee ninguna individual sería invisible en todo filtro salvo
    // "todos", y eso es un fallo mudo.
    for (const status of ["draft", "published", "closed", null]) {
      const hits = (["borradores", "publicados", "cerrados"] as const).filter((f) =>
        matchesActivityStatus(status, f),
      );
      expect(hits, `estado ${String(status)} debe caer en exactamente 1 filtro individual`).toHaveLength(1);
    }
  });

  it("ACTIVITY_STATUS_OPTIONS incluye toda opción que el matcher entiende", () => {
    // Si alguien agrega un valor al type y no a la lista, el select no lo ofrece
    // y la opción queda muerta.
    expect(ACTIVITY_STATUS_OPTIONS).toContain("activos");
    expect(ACTIVITY_STATUS_OPTIONS).toContain("borradores");
    expect(ACTIVITY_STATUS_OPTIONS).toContain("publicados");
    expect(ACTIVITY_STATUS_OPTIONS).toContain("cerrados");
    expect(ACTIVITY_STATUS_OPTIONS).toContain("todos");
    expect(ACTIVITY_STATUS_OPTIONS).toHaveLength(5);
  });
});
