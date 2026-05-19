import { describe, expect, it } from "vitest";
import {
  computeSessionDates,
  parseLocalIsoDate,
  toLocalIsoDate,
  WEEKDAYS_ES,
} from "./session-dates";

describe("WEEKDAYS_ES", () => {
  it("tiene 7 entradas (todos los días de la semana)", () => {
    expect(WEEKDAYS_ES).toHaveLength(7);
  });

  it("primer elemento es lunes (idx=1)", () => {
    expect(WEEKDAYS_ES[0].idx).toBe(1);
    expect(WEEKDAYS_ES[0].long).toBe("Lunes");
  });

  it("domingo va al final con idx=0", () => {
    expect(WEEKDAYS_ES[WEEKDAYS_ES.length - 1].idx).toBe(0);
    expect(WEEKDAYS_ES[WEEKDAYS_ES.length - 1].long).toBe("Domingo");
  });
});

describe("toLocalIsoDate", () => {
  it("formato YYYY-MM-DD desde Date local", () => {
    // 13 mayo 2026 (mes 4 en JS porque es 0-indexed)
    expect(toLocalIsoDate(new Date(2026, 4, 13))).toBe("2026-05-13");
  });

  it("padding de mes/día con 0", () => {
    expect(toLocalIsoDate(new Date(2026, 0, 1))).toBe("2026-01-01");
    expect(toLocalIsoDate(new Date(2026, 8, 9))).toBe("2026-09-09");
  });

  it("no aplica TZ — usa calendario local", () => {
    // Si construyo Date a las 23:00 local del 13 mayo, debería devolver
    // 2026-05-13 (no 2026-05-14). new Date(...).toISOString() lo correría
    // a UTC para zonas negativas, pero nuestro helper usa getDate.
    expect(toLocalIsoDate(new Date(2026, 4, 13, 23, 0, 0))).toBe("2026-05-13");
  });
});

describe("parseLocalIsoDate", () => {
  it("'2026-05-13' → Date local del 13 mayo", () => {
    const d = parseLocalIsoDate("2026-05-13");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4); // mayo (0-indexed)
    expect(d.getDate()).toBe(13);
  });

  it("round-trip toLocalIsoDate(parseLocalIsoDate(x)) === x", () => {
    const cases = ["2026-01-01", "2026-05-13", "2026-12-31"];
    for (const s of cases) {
      expect(toLocalIsoDate(parseLocalIsoDate(s))).toBe(s);
    }
  });
});

describe("computeSessionDates", () => {
  it("retorna [] si n <= 0", () => {
    expect(computeSessionDates(new Date(2026, 4, 13), new Set([1]), 0)).toEqual([]);
    expect(computeSessionDates(new Date(2026, 4, 13), new Set([1]), -3)).toEqual([]);
  });

  it("retorna [] si no hay días seleccionados", () => {
    expect(computeSessionDates(new Date(2026, 4, 13), new Set(), 5)).toEqual([]);
  });

  it("incluye start si su día matchea", () => {
    // 11 mayo 2026 es lunes (verificable: 2026-05-11 → lunes).
    const start = new Date(2026, 4, 11);
    expect(start.getDay()).toBe(1); // sanity
    const out = computeSessionDates(start, new Set([1]), 1);
    expect(out).toHaveLength(1);
    expect(toLocalIsoDate(out[0])).toBe("2026-05-11");
  });

  it("salta días no incluidos", () => {
    // Empieza un lunes; solo queremos miércoles → primer match es el
    // miércoles siguiente.
    const start = new Date(2026, 4, 11); // lunes
    const out = computeSessionDates(start, new Set([3]), 1);
    expect(toLocalIsoDate(out[0])).toBe("2026-05-13"); // miércoles
  });

  it("genera N fechas en orden cronológico con días Lun+Mié", () => {
    const start = new Date(2026, 4, 11); // lunes 11
    const out = computeSessionDates(start, new Set([1, 3]), 4);
    expect(out.map(toLocalIsoDate)).toEqual([
      "2026-05-11", // L
      "2026-05-13", // X
      "2026-05-18", // L
      "2026-05-20", // X
    ]);
  });

  it("respeta el orden cronológico aunque days esté desordenado", () => {
    const start = new Date(2026, 4, 11); // lunes
    const out = computeSessionDates(start, new Set([3, 1]), 4);
    expect(toLocalIsoDate(out[0])).toBe("2026-05-11");
    expect(toLocalIsoDate(out[1])).toBe("2026-05-13");
  });

  it("avanza más de una semana si se piden más sesiones que matches en 7 días", () => {
    const start = new Date(2026, 4, 11);
    const out = computeSessionDates(start, new Set([1]), 5);
    expect(out).toHaveLength(5);
    // 5 lunes consecutivos: 11, 18, 25 de mayo, 1, 8 de junio
    expect(toLocalIsoDate(out[2])).toBe("2026-05-25");
    expect(toLocalIsoDate(out[4])).toBe("2026-06-08");
  });

  it("cruza fin de mes y fin de año correctamente", () => {
    const start = new Date(2026, 11, 28); // 28 dic 2026 (lunes)
    const out = computeSessionDates(start, new Set([1]), 3);
    expect(out.map(toLocalIsoDate)).toEqual(["2026-12-28", "2027-01-04", "2027-01-11"]);
  });
});
