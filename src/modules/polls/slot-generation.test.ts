import { describe, expect, it } from "vitest";
import {
  generateSlotsForDates,
  suggestSlotCupo,
  formatSlotLabel,
  slotsPerDayCount,
} from "./slot-generation";

describe("slotsPerDayCount (debe coincidir con el loop de generateSlotsForDates)", () => {
  it("ventana divisible por el paso: floor == ceil", () => {
    expect(slotsPerDayCount(540, 600, 15)).toBe(4); // 09:00–10:00 / 15 → 4
    expect(slotsPerDayCount(540, 780, 30)).toBe(8); // 09:00–13:00 / 30 → 8
  });
  it("ventana NO divisible: ceil (el caso que floor subestimaba)", () => {
    // 09:00–10:00 (60min) / paso 25 → loop genera 9:00, 9:25, 9:50 = 3 (floor daba 2)
    expect(slotsPerDayCount(540, 600, 25)).toBe(3);
    expect(slotsPerDayCount(0, 100, 30)).toBe(4); // ceil(100/30)=4
  });
  it("coincide BIT-A-BIT con la cantidad real generada por generateSlotsForDates", () => {
    for (const [start, end, step] of [
      ["09:00", "10:00", 25],
      ["08:00", "12:30", 40],
      ["09:00", "10:00", 15],
    ] as const) {
      const gen = generateSlotsForDates({ dates: ["2026-06-10"], timeStart: start, timeEnd: end, stepMin: step, cupo: 1 });
      const [sh, sm] = start.split(":").map(Number);
      const [eh, em] = end.split(":").map(Number);
      expect(gen.length).toBe(slotsPerDayCount(sh * 60 + sm, eh * 60 + em, step));
    }
  });
  it("ventana inválida o paso ≤0 → 0", () => {
    expect(slotsPerDayCount(600, 540, 15)).toBe(0);
    expect(slotsPerDayCount(540, 600, 0)).toBe(0);
  });
});

describe("suggestSlotCupo con ventana NO divisible (regresión del floor)", () => {
  it("60min/25 con 1 fecha y 9 matriculados → 3 slots → cupo 3 (no 5 del floor=2)", () => {
    // floor(60/25)=2 → ceil(9/2)=5; ceil(60/25)=3 → ceil(9/3)=3
    expect(suggestSlotCupo(["2026-06-10"], "09:00", "10:00", 25, 9)).toBe(3);
  });
});

describe("generateSlotsForDates", () => {
  describe("entrada inválida", () => {
    it("retorna [] si dates está vacío", () => {
      expect(
        generateSlotsForDates({
          dates: [],
          timeStart: "09:00",
          timeEnd: "10:00",
          stepMin: 15,
          cupo: 1,
        }),
      ).toEqual([]);
    });

    it("retorna [] si timeStart inválido", () => {
      expect(
        generateSlotsForDates({
          dates: ["2026-06-10"],
          timeStart: "abc",
          timeEnd: "10:00",
          stepMin: 15,
          cupo: 1,
        }),
      ).toEqual([]);
    });

    it("retorna [] si timeEnd <= timeStart", () => {
      expect(
        generateSlotsForDates({
          dates: ["2026-06-10"],
          timeStart: "10:00",
          timeEnd: "10:00",
          stepMin: 15,
          cupo: 1,
        }),
      ).toEqual([]);
      expect(
        generateSlotsForDates({
          dates: ["2026-06-10"],
          timeStart: "11:00",
          timeEnd: "10:00",
          stepMin: 15,
          cupo: 1,
        }),
      ).toEqual([]);
    });

    it("retorna [] si stepMin <= 0", () => {
      expect(
        generateSlotsForDates({
          dates: ["2026-06-10"],
          timeStart: "09:00",
          timeEnd: "10:00",
          stepMin: 0,
          cupo: 1,
        }),
      ).toEqual([]);
      expect(
        generateSlotsForDates({
          dates: ["2026-06-10"],
          timeStart: "09:00",
          timeEnd: "10:00",
          stepMin: -5,
          cupo: 1,
        }),
      ).toEqual([]);
    });

    it("ignora fechas con formato inválido pero procesa el resto", () => {
      const out = generateSlotsForDates({
        dates: ["2026-06-10", "not-a-date", "2026-13-99", "2026-06-11"],
        timeStart: "09:00",
        timeEnd: "10:00",
        stepMin: 30,
        cupo: 1,
      });
      // Solo 2 fechas válidas × 2 slots/día = 4 slots
      expect(out).toHaveLength(4);
    });
  });

  describe("generación correcta", () => {
    it("una fecha, ventana 9-10am, step 15min → 4 slots", () => {
      const out = generateSlotsForDates({
        dates: ["2026-06-10"],
        timeStart: "09:00",
        timeEnd: "10:00",
        stepMin: 15,
        cupo: 1,
      });
      expect(out).toHaveLength(4);
      expect(out.map((s) => s.label)).toEqual([
        "mié, 10 de jun · 9:00 AM",
        "mié, 10 de jun · 9:15 AM",
        "mié, 10 de jun · 9:30 AM",
        "mié, 10 de jun · 9:45 AM",
      ]);
    });

    it("ventana de 1 hora exacta no incluye el slot del minuto final (exclusive end)", () => {
      const out = generateSlotsForDates({
        dates: ["2026-06-10"],
        timeStart: "09:00",
        timeEnd: "10:00",
        stepMin: 30,
        cupo: 1,
      });
      // Genera 9:00 y 9:30, NO 10:00.
      expect(out.map((s) => s.label)).toEqual(["mié, 10 de jun · 9:00 AM", "mié, 10 de jun · 9:30 AM"]);
    });

    it("multi-fecha cross-product: 2 fechas × 4 slots = 8 opciones, en orden", () => {
      const out = generateSlotsForDates({
        dates: ["2026-06-10", "2026-06-11"],
        timeStart: "09:00",
        timeEnd: "10:00",
        stepMin: 15,
        cupo: 2,
      });
      expect(out).toHaveLength(8);
      // Primer bloque = primera fecha completa, luego segunda fecha
      expect(out[0].label).toBe("mié, 10 de jun · 9:00 AM");
      expect(out[3].label).toBe("mié, 10 de jun · 9:45 AM");
      expect(out[4].label).toBe("jue, 11 de jun · 9:00 AM");
      expect(out[7].label).toBe("jue, 11 de jun · 9:45 AM");
    });

    it("cupo se aplica a todos los slots como string", () => {
      const out = generateSlotsForDates({
        dates: ["2026-06-10"],
        timeStart: "09:00",
        timeEnd: "09:30",
        stepMin: 15,
        cupo: 5,
      });
      expect(out.every((s) => s.max_responses === "5")).toBe(true);
    });

    it("cupo <= 0 se coerciona a 1 (defensa)", () => {
      const out = generateSlotsForDates({
        dates: ["2026-06-10"],
        timeStart: "09:00",
        timeEnd: "09:30",
        stepMin: 15,
        cupo: 0,
      });
      expect(out.every((s) => s.max_responses === "1")).toBe(true);
    });

    it("formato 12h: 12:00 → 12 PM, 0:00 → 12 AM, 13:00 → 1 PM", () => {
      const out = generateSlotsForDates({
        dates: ["2026-06-10"],
        timeStart: "11:30",
        timeEnd: "13:30",
        stepMin: 30,
        cupo: 1,
      });
      const labels = out.map((s) => s.label);
      expect(labels).toContain("mié, 10 de jun · 11:30 AM");
      expect(labels).toContain("mié, 10 de jun · 12:00 PM");
      expect(labels).toContain("mié, 10 de jun · 12:30 PM");
      expect(labels).toContain("mié, 10 de jun · 1:00 PM");
    });

    it("step que no divide la ventana exactamente: 9:00-10:00 step 25 → 9:00, 9:25, 9:50", () => {
      const out = generateSlotsForDates({
        dates: ["2026-06-10"],
        timeStart: "09:00",
        timeEnd: "10:00",
        stepMin: 25,
        cupo: 1,
      });
      expect(out.map((s) => s.label)).toEqual([
        "mié, 10 de jun · 9:00 AM",
        "mié, 10 de jun · 9:25 AM",
        "mié, 10 de jun · 9:50 AM",
      ]);
    });
  });

  describe("dedup", () => {
    it("fechas duplicadas se procesan una sola vez", () => {
      const out = generateSlotsForDates({
        dates: ["2026-06-10", "2026-06-10", "2026-06-10"],
        timeStart: "09:00",
        timeEnd: "09:30",
        stepMin: 15,
        cupo: 1,
      });
      // 1 fecha única × 2 slots = 2
      expect(out).toHaveLength(2);
    });

    it("dedup preserva orden de primera aparición", () => {
      const out = generateSlotsForDates({
        dates: ["2026-06-11", "2026-06-10", "2026-06-11"],
        timeStart: "09:00",
        timeEnd: "09:30",
        stepMin: 30,
        cupo: 1,
      });
      // El 11 viene primero (porque apareció primero)
      expect(out[0].label).toMatch(/11 de jun/);
      expect(out[1].label).toMatch(/10 de jun/);
    });
  });
});

describe("suggestSlotCupo", () => {
  it("retorna 1 si enrolledCount es null/0/undefined", () => {
    expect(suggestSlotCupo(["2026-06-10"], "09:00", "10:00", 15, null)).toBe(1);
    expect(suggestSlotCupo(["2026-06-10"], "09:00", "10:00", 15, 0)).toBe(1);
    expect(suggestSlotCupo(["2026-06-10"], "09:00", "10:00", 15, undefined)).toBe(1);
  });

  it("retorna 1 si no hay slots posibles (timeEnd <= timeStart)", () => {
    expect(suggestSlotCupo(["2026-06-10"], "10:00", "10:00", 15, 20)).toBe(1);
  });

  it("retorna 1 si dates vacío", () => {
    expect(suggestSlotCupo([], "09:00", "10:00", 15, 20)).toBe(1);
  });

  it("20 alumnos, 1 fecha, ventana 1h, step 15 → 4 slots → ceil(20/4) = 5", () => {
    expect(suggestSlotCupo(["2026-06-10"], "09:00", "10:00", 15, 20)).toBe(5);
  });

  it("20 alumnos, 2 fechas, ventana 1h, step 15 → 8 slots → ceil(20/8) = 3", () => {
    expect(suggestSlotCupo(["2026-06-10", "2026-06-11"], "09:00", "10:00", 15, 20)).toBe(3);
  });

  it("100 alumnos, 5 fechas, ventana 4h, step 30 → 40 slots → ceil(100/40) = 3", () => {
    const dates = ["2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13", "2026-06-14"];
    expect(suggestSlotCupo(dates, "09:00", "13:00", 30, 100)).toBe(3);
  });

  it("dedup fechas antes de calcular", () => {
    expect(suggestSlotCupo(["2026-06-10", "2026-06-10"], "09:00", "10:00", 15, 20)).toBe(5);
  });

  it("siempre devuelve >= 1 incluso si matemáticamente daría 0", () => {
    // 1 alumno, muchísimos slots
    expect(suggestSlotCupo(["2026-06-10"], "00:00", "23:30", 1, 1)).toBe(1);
  });
});

describe("formatSlotLabel", () => {
  it("formatea fecha + hora con el mismo formato que los slots generados", () => {
    // El label de un slot suelto debe coincidir EXACTO con el de la
    // generación masiva para el mismo día+hora (window de 1 slot).
    const generated = generateSlotsForDates({
      dates: ["2026-06-10"],
      timeStart: "09:00",
      timeEnd: "09:01",
      stepMin: 1,
      cupo: 1,
    });
    expect(generated).toHaveLength(1);
    expect(formatSlotLabel("2026-06-10", "09:00")).toBe(generated[0].label);
  });

  it("usa 12h con AM/PM", () => {
    expect(formatSlotLabel("2026-06-10", "13:30")).toContain("1:30 PM");
    expect(formatSlotLabel("2026-06-10", "00:15")).toContain("12:15 AM");
  });

  it("fecha u hora inválida → cadena vacía", () => {
    expect(formatSlotLabel("", "09:00")).toBe("");
    expect(formatSlotLabel("2026-13-40", "09:00")).toBe("");
    expect(formatSlotLabel("2026-06-10", "99:99")).toBe("");
    expect(formatSlotLabel("2026-06-10", "")).toBe("");
  });
});
