import { describe, expect, it } from "vitest";
import {
  isValidDateRange,
  capEndToCourseEnd,
  courseEndOfDay,
  earliestCourseEnd,
} from "./date-range";

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

describe("courseEndOfDay", () => {
  it("DATE puro (YYYY-MM-DD) → 23:59 LOCAL de ese día", () => {
    const d = courseEndOfDay("2026-09-30");
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(8); // septiembre (0-based)
    expect(d!.getDate()).toBe(30);
    expect(d!.getHours()).toBe(23);
    expect(d!.getMinutes()).toBe(59);
  });

  it("vacío / nullish → null", () => {
    expect(courseEndOfDay(null)).toBeNull();
    expect(courseEndOfDay(undefined)).toBeNull();
    expect(courseEndOfDay("")).toBeNull();
  });
});

describe("capEndToCourseEnd", () => {
  it("sin fecha fin del curso → deja la actividad igual", () => {
    expect(capEndToCourseEnd("2026-12-31T10:00", null)).toBe("2026-12-31T10:00");
    expect(capEndToCourseEnd("2026-12-31T10:00", "")).toBe("2026-12-31T10:00");
  });

  it("fin de la actividad YA dentro del curso → se deja tal cual (no reformatea)", () => {
    // Curso termina el 30 sep; la actividad cierra el 15 sep → intacta.
    expect(capEndToCourseEnd("2026-09-15T10:00", "2026-09-30")).toBe("2026-09-15T10:00");
    // Mismo día, antes de las 23:59 → dentro.
    expect(capEndToCourseEnd("2026-09-30T08:00", "2026-09-30")).toBe("2026-09-30T08:00");
  });

  it("fin de la actividad EXCEDE el curso → se topa al 23:59 local del último día", () => {
    // Actividad cerraba el 5 oct, curso termina el 30 sep → topada al 30 sep 23:59.
    expect(capEndToCourseEnd("2026-10-05T10:00", "2026-09-30")).toBe("2026-09-30T23:59");
    // Un minuto después del cierre del curso también se topa.
    expect(capEndToCourseEnd("2026-10-01T00:00", "2026-09-30")).toBe("2026-09-30T23:59");
  });

  it("actividad sin fin → no inventa fecha", () => {
    expect(capEndToCourseEnd("", "2026-09-30")).toBe("");
    expect(capEndToCourseEnd(null, "2026-09-30")).toBe("");
  });
});

describe("earliestCourseEnd", () => {
  it("devuelve el end_date del curso que termina ANTES (cabe en todos)", () => {
    expect(earliestCourseEnd(["2026-09-30", "2026-12-15", "2026-10-20"])).toBe("2026-09-30");
  });

  it("ignora vacíos / nullish", () => {
    expect(earliestCourseEnd([null, "2026-11-01", undefined, ""])).toBe("2026-11-01");
    expect(earliestCourseEnd([null, undefined, ""])).toBeNull();
    expect(earliestCourseEnd([])).toBeNull();
  });

  it("integra con capEndToCourseEnd (multi-curso → tope al más temprano)", () => {
    const earliest = earliestCourseEnd(["2026-12-15", "2026-09-30"]);
    expect(capEndToCourseEnd("2026-11-01T10:00", earliest)).toBe("2026-09-30T23:59");
  });
});
