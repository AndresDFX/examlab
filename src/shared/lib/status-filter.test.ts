import { describe, expect, it } from "vitest";
import {
  ACTIVITY_STATUS_VALUES,
  activityStatusValue,
  matchesActivityStatus,
  DEFAULT_ACTIVITY_STATUS_FILTER,
} from "./status-filter";

describe("matchesActivityStatus (selección múltiple)", () => {
  it("el default oculta cerrados pero muestra borradores y publicados", () => {
    // El default NO es vacío: vacío significaría "todos, incluidos cerrados".
    expect([...DEFAULT_ACTIVITY_STATUS_FILTER]).toEqual(["borradores", "publicados"]);
    expect(matchesActivityStatus("draft", DEFAULT_ACTIVITY_STATUS_FILTER)).toBe(true);
    expect(matchesActivityStatus("published", DEFAULT_ACTIVITY_STATUS_FILTER)).toBe(true);
    expect(matchesActivityStatus("closed", DEFAULT_ACTIVITY_STATUS_FILTER)).toBe(false);
  });

  it("vacío = sin filtrar: muestra TODO, incluidos los cerrados", () => {
    expect(matchesActivityStatus("draft", [])).toBe(true);
    expect(matchesActivityStatus("published", [])).toBe(true);
    expect(matchesActivityStatus("closed", [])).toBe(true);
    expect(matchesActivityStatus(null, [])).toBe(true);
  });

  it("'cerrados' aísla solo los cerrados", () => {
    expect(matchesActivityStatus("closed", ["cerrados"])).toBe(true);
    expect(matchesActivityStatus("draft", ["cerrados"])).toBe(false);
    expect(matchesActivityStatus("published", ["cerrados"])).toBe(false);
  });

  it("'borradores' aísla SOLO los draft (nullish se asume publicado)", () => {
    expect(matchesActivityStatus("draft", ["borradores"])).toBe(true);
    expect(matchesActivityStatus("published", ["borradores"])).toBe(false);
    expect(matchesActivityStatus("closed", ["borradores"])).toBe(false);
    expect(matchesActivityStatus(null, ["borradores"])).toBe(false);
  });

  it("'publicados' aísla SOLO los published (incluido el nullish)", () => {
    expect(matchesActivityStatus("published", ["publicados"])).toBe(true);
    expect(matchesActivityStatus(null, ["publicados"])).toBe(true);
    expect(matchesActivityStatus("draft", ["publicados"])).toBe(false);
    expect(matchesActivityStatus("closed", ["publicados"])).toBe(false);
  });

  it("se pueden combinar dos estados a la vez", () => {
    const sel = ["borradores", "cerrados"] as const;
    expect(matchesActivityStatus("draft", sel)).toBe(true);
    expect(matchesActivityStatus("closed", sel)).toBe(true);
    expect(matchesActivityStatus("published", sel)).toBe(false);
  });

  it("activityStatusValue PARTICIONA el universo: cada estado cae en exactamente una opción", () => {
    // Guard contra agregar un estado y olvidar su rama: uno que no caiga en
    // ninguna opción sería invisible salvo con el filtro vacío — un fallo mudo.
    for (const status of ["draft", "published", "closed", null]) {
      const val = activityStatusValue(status);
      const hits = ACTIVITY_STATUS_VALUES.filter((v) => v === val);
      expect(hits, `estado ${String(status)} debe caer en exactamente 1 opción`).toHaveLength(1);
    }
  });

  it("ACTIVITY_STATUS_VALUES tiene las tres opciones marcables", () => {
    expect([...ACTIVITY_STATUS_VALUES]).toEqual(["borradores", "publicados", "cerrados"]);
  });
});
