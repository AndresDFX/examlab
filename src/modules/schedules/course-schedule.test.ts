import { describe, expect, it } from "vitest";
import {
  blocksOverlap,
  compareBlocks,
  formatBlockShort,
  formatScheduleText,
  trimTime,
  type CourseScheduleBlock,
} from "./course-schedule";

function block(over: Partial<CourseScheduleBlock>): CourseScheduleBlock {
  return {
    day_of_week: 1,
    start_time: "10:00:00",
    end_time: "12:00:00",
    aula: null,
    modalidad: "presencial",
    notes: null,
    ...over,
  };
}

describe("trimTime", () => {
  it("HH:MM:SS → HH:MM", () => {
    expect(trimTime("10:00:00")).toBe("10:00");
    expect(trimTime("23:59:59")).toBe("23:59");
  });
  it("HH:MM se queda igual", () => {
    expect(trimTime("10:00")).toBe("10:00");
  });
  it("string vacio devuelve vacio", () => {
    expect(trimTime("")).toBe("");
  });
  it("formato raro pasa intacto", () => {
    expect(trimTime("garbage")).toBe("garbage");
  });
});

describe("formatBlockShort", () => {
  it("dia + horario en formato compacto", () => {
    expect(formatBlockShort(block({ day_of_week: 1 }))).toBe("Lun 10:00–12:00");
    expect(formatBlockShort(block({ day_of_week: 4 }))).toBe("Jue 10:00–12:00");
  });
  it("incluye aula entre parentesis", () => {
    expect(formatBlockShort(block({ aula: "Aula 301" }))).toBe(
      "Lun 10:00–12:00 (Aula 301)",
    );
  });
  it("indica modalidad virtual", () => {
    expect(formatBlockShort(block({ modalidad: "virtual" }))).toBe(
      "Lun 10:00–12:00 (virtual)",
    );
  });
  it("indica modalidad hibrida con tilde", () => {
    expect(formatBlockShort(block({ modalidad: "hibrida" }))).toBe(
      "Lun 10:00–12:00 (híbrida)",
    );
  });
  it("aula + virtual combinados", () => {
    expect(formatBlockShort(block({ aula: "Sala B", modalidad: "virtual" }))).toBe(
      "Lun 10:00–12:00 (Sala B, virtual)",
    );
  });
  it("presencial sin aula no agrega parentesis", () => {
    expect(formatBlockShort(block({ modalidad: "presencial", aula: "" }))).toBe(
      "Lun 10:00–12:00",
    );
  });
});

describe("compareBlocks (ordenamiento semanal)", () => {
  it("lunes antes que martes", () => {
    expect(
      compareBlocks(block({ day_of_week: 1 }), block({ day_of_week: 2 })),
    ).toBeLessThan(0);
  });
  it("domingo despues de sabado (orden lunes-primero)", () => {
    expect(
      compareBlocks(block({ day_of_week: 6 }), block({ day_of_week: 0 })),
    ).toBeLessThan(0);
  });
  it("mismo dia: ordena por hora de inicio", () => {
    expect(
      compareBlocks(
        block({ day_of_week: 1, start_time: "08:00" }),
        block({ day_of_week: 1, start_time: "10:00" }),
      ),
    ).toBeLessThan(0);
  });
});

describe("formatScheduleText (informes)", () => {
  it("lista vacia → string vacio", () => {
    expect(formatScheduleText([])).toBe("");
  });
  it("ordena y junta con ' · '", () => {
    const blocks = [
      block({ day_of_week: 4, start_time: "14:00", end_time: "16:00" }), // jueves tarde
      block({ day_of_week: 1, start_time: "10:00", end_time: "12:00" }), // lunes mañana
      block({ day_of_week: 3, start_time: "08:00", end_time: "10:00" }), // miércoles temprano
    ];
    expect(formatScheduleText(blocks)).toBe(
      "Lun 10:00–12:00 · Mié 08:00–10:00 · Jue 14:00–16:00",
    );
  });
});

describe("blocksOverlap", () => {
  it("dias distintos NO se solapan", () => {
    expect(
      blocksOverlap(
        block({ day_of_week: 1, start_time: "10:00", end_time: "12:00" }),
        block({ day_of_week: 2, start_time: "10:00", end_time: "12:00" }),
      ),
    ).toBe(false);
  });
  it("mismo dia, horarios disjuntos: NO se solapan", () => {
    expect(
      blocksOverlap(
        block({ day_of_week: 1, start_time: "08:00", end_time: "10:00" }),
        block({ day_of_week: 1, start_time: "10:00", end_time: "12:00" }),
      ),
    ).toBe(false);
  });
  it("mismo dia, solape parcial: SI", () => {
    expect(
      blocksOverlap(
        block({ day_of_week: 1, start_time: "10:00", end_time: "12:00" }),
        block({ day_of_week: 1, start_time: "11:00", end_time: "13:00" }),
      ),
    ).toBe(true);
  });
  it("uno dentro del otro: SI", () => {
    expect(
      blocksOverlap(
        block({ day_of_week: 1, start_time: "10:00", end_time: "14:00" }),
        block({ day_of_week: 1, start_time: "11:00", end_time: "12:00" }),
      ),
    ).toBe(true);
  });
});
