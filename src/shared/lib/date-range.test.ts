import { describe, expect, it } from "vitest";
import { isValidDateRange } from "./date-range";

describe("isValidDateRange", () => {
  it("permite cuando falta alguno de los extremos (nada que validar)", () => {
    expect(isValidDateRange(null, null)).toBe(true);
    expect(isValidDateRange("2026-01-01", null)).toBe(true);
    expect(isValidDateRange(null, "2026-01-01")).toBe(true);
    expect(isValidDateRange(undefined, "2026-01-01")).toBe(true);
    expect(isValidDateRange("2026-01-01", undefined)).toBe(true);
    expect(isValidDateRange("", "2026-01-01")).toBe(true);
    expect(isValidDateRange("2026-01-01", "   ")).toBe(true);
  });

  it("fin > inicio → válido (fechas)", () => {
    expect(isValidDateRange("2026-01-01", "2026-12-31")).toBe(true);
  });

  it("fin == inicio → válido (iguales permitido)", () => {
    expect(isValidDateRange("2026-06-14", "2026-06-14")).toBe(true);
  });

  it("fin < inicio → inválido (fechas)", () => {
    expect(isValidDateRange("2026-12-31", "2026-01-01")).toBe(false);
    expect(isValidDateRange("2026-06-15", "2026-06-14")).toBe(false);
  });

  it("funciona con datetime-local / ISO", () => {
    expect(isValidDateRange("2026-06-14T08:00", "2026-06-14T10:00")).toBe(true);
    expect(isValidDateRange("2026-06-14T10:00", "2026-06-14T10:00")).toBe(true);
    expect(isValidDateRange("2026-06-14T10:00", "2026-06-14T08:00")).toBe(false);
    expect(
      isValidDateRange("2026-06-14T08:00:00.000Z", "2026-06-14T09:00:00.000Z"),
    ).toBe(true);
    expect(
      isValidDateRange("2026-06-14T09:00:00.000Z", "2026-06-14T08:00:00.000Z"),
    ).toBe(false);
  });

  it("compara por timestamp, no lexicográficamente (tolera ISO de DB vs picker)", () => {
    // Caso real al editar: start viene de la DB como ISO-UTC y end del
    // DateTimePicker como datetime-local. Comparar por epoch (no por
    // string) evita el bug de TZ donde lexicográficamente "13:00+00:00"
    // parecería mayor que "10:00" local aunque representen otro instante.
    const a = new Date("2026-06-14T08:00:00Z");
    const b = new Date("2026-06-14T10:00:00Z");
    expect(isValidDateRange(a, b)).toBe(true);
    expect(isValidDateRange(b, a)).toBe(false);
    // Números (ms epoch).
    expect(isValidDateRange(a.getTime(), b.getTime())).toBe(true);
    expect(isValidDateRange(b.getTime(), a.getTime())).toBe(false);
  });

  it("valor no parseable → válido (lo atrapa otra validación; no es el rol de este helper)", () => {
    // Strings de hora pelada (HH:MM) NO son parseables por Date → este
    // helper NO los valida. Los rangos de hora pura (ej. horario del curso)
    // tienen su propia validación con parseHHMMToMinutes.
    expect(isValidDateRange("no-es-fecha", "2026-06-15T08:00")).toBe(true);
    expect(isValidDateRange("2026-06-15T08:00", "tampoco")).toBe(true);
    expect(isValidDateRange("10:00", "08:00")).toBe(true);
  });

  it("recorta espacios antes de comparar (Date tolera el padding)", () => {
    expect(isValidDateRange(" 2026-01-01 ", " 2026-01-02 ")).toBe(true);
    expect(isValidDateRange(" 2026-01-02 ", " 2026-01-01 ")).toBe(false);
  });
});
