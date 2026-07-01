import { describe, expect, it } from "vitest";
import {
  coHolidays,
  coHolidayMap,
  coHolidayName,
  isCoHoliday,
  easterSunday,
  nextBusinessDay,
} from "./co-holidays";
import { toLocalIsoDate } from "@/modules/contents/session-dates";

describe("easterSunday", () => {
  it("computa el domingo de Pascua por año (Butcher)", () => {
    expect(toLocalIsoDate(easterSunday(2025))).toBe("2025-04-20");
    expect(toLocalIsoDate(easterSunday(2026))).toBe("2026-04-05");
    expect(toLocalIsoDate(easterSunday(2027))).toBe("2027-03-28");
  });
});

describe("coHolidays 2026 — lista oficial exacta (18 festivos)", () => {
  const expected2026 = [
    "2026-01-01", // Año Nuevo
    "2026-01-12", // Reyes (06 mar→lun 12)
    "2026-03-23", // San José (19 jue→lun 23)
    "2026-04-02", // Jueves Santo
    "2026-04-03", // Viernes Santo
    "2026-05-01", // Trabajo
    "2026-05-18", // Ascensión
    "2026-06-08", // Corpus Christi
    "2026-06-15", // Sagrado Corazón
    "2026-06-29", // San Pedro y San Pablo (lunes)
    "2026-07-20", // Independencia
    "2026-08-07", // Boyacá
    "2026-08-17", // Asunción (15 sáb→lun 17)
    "2026-10-12", // Día de la Raza (lunes)
    "2026-11-02", // Todos los Santos (01 dom→lun 02)
    "2026-11-16", // Independencia de Cartagena (11 mié→lun 16)
    "2026-12-08", // Inmaculada
    "2026-12-25", // Navidad
  ];
  const set = coHolidays(2026);
  it("tiene exactamente 18 festivos", () => {
    expect(set.size).toBe(18);
  });
  it("contiene cada festivo esperado y ninguno de más", () => {
    expect([...set].sort()).toEqual([...expected2026].sort());
  });
});

describe("reglas de traslado", () => {
  it("Ley Emiliani traslada al lunes (Reyes 06-ene 2026 = martes → 12-ene)", () => {
    expect(coHolidayName("2026-01-12")).toBe("Reyes Magos");
    expect(isCoHoliday("2026-01-06")).toBe(false); // el 6 ya no es festivo
  });
  it("fijos NO se trasladan (01-may, 20-jul, 25-dic)", () => {
    expect(isCoHoliday("2026-05-01")).toBe(true);
    expect(isCoHoliday("2026-07-20")).toBe(true);
    expect(isCoHoliday("2026-12-25")).toBe(true);
  });
  it("Jueves/Viernes Santo son exactos (no se trasladan)", () => {
    expect(coHolidayName("2026-04-02")).toBe("Jueves Santo");
    expect(coHolidayName("2026-04-03")).toBe("Viernes Santo");
  });
  it("Ascensión/Corpus/Sagrado Corazón caen en lunes", () => {
    for (const iso of ["2026-05-18", "2026-06-08", "2026-06-15"]) {
      expect(new Date(iso + "T00:00:00").getDay()).toBe(1); // lunes local
    }
  });
});

describe("determinismo + otro año", () => {
  it("mismo año → mismo set (cache)", () => {
    expect([...coHolidays(2027)].sort()).toEqual([...coHolidays(2027)].sort());
  });
  it("2025 incluye Pascua correcta (Jueves Santo 2025-04-17)", () => {
    expect(coHolidayName("2025-04-17")).toBe("Jueves Santo");
  });
  it("coHolidayName toma el año del iso (cruce de año)", () => {
    expect(coHolidayName("2027-01-01")).toBe("Año Nuevo");
    expect(coHolidayName("2026-06-15")).toBe("Sagrado Corazón");
    expect(coHolidayName("2026-06-16")).toBeNull();
  });
});

describe("nextBusinessDay", () => {
  const isHol = (iso: string) => coHolidays(Number(iso.slice(0, 4))).has(iso);
  it("salta festivos y respeta el patrón de días", () => {
    // Desde vie 2026-07-17, días = solo lunes(1). Próximo lunes 07-20 es festivo
    // (Independencia) → debe devolver el lunes 07-27.
    const from = new Date(2026, 6, 17); // 17 jul 2026 (viernes)
    const res = nextBusinessDay(from, new Set([1]), isHol);
    expect(toLocalIsoDate(res)).toBe("2026-07-27");
  });
  it("devuelve el siguiente día que matchea cuando no hay festivo", () => {
    const from = new Date(2026, 8, 7); // lun 07-sep-2026
    const res = nextBusinessDay(from, new Set([3]), isHol); // próximo miércoles
    expect(toLocalIsoDate(res)).toBe("2026-09-09");
  });
});
