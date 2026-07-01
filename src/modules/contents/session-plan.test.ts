import { describe, expect, it } from "vitest";
import { buildSessionPlan } from "./session-plan";
import type { CourseScheduleBlock } from "@/modules/schedules/course-schedule";

// Bloque mínimo (buildSessionPlan solo usa day_of_week/start_time/end_time).
const blk = (day: number, s: string, e: string): CourseScheduleBlock =>
  ({
    id: `b-${day}-${s}`,
    day_of_week: day,
    start_time: s,
    end_time: e,
    aula: null,
    modalidad: "presencial",
    notes: null,
  }) as unknown as CourseScheduleBlock;

const D = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};

describe("buildSessionPlan — prefijado de horario", () => {
  it("toma start_time/duración del bloque del día; null si el día no tiene bloque", () => {
    const rows = buildSessionPlan({
      start: D("2026-07-13"), // lunes
      days: new Set([1, 3]), // Lun + Mié
      count: 4,
      schedules: [blk(1, "10:00:00", "12:00:00")], // solo lunes
      policy: "include",
    });
    const mon = rows.filter((r) => r.weekday === 1);
    const wed = rows.filter((r) => r.weekday === 3);
    expect(mon.every((r) => r.startTime === "10:00" && r.durationMin === 120)).toBe(true);
    expect(wed.every((r) => r.startTime === null && r.durationMin === null)).toBe(true);
  });

  it("clamp de duración a [15,480]", () => {
    const long = buildSessionPlan({
      start: D("2026-07-13"),
      days: new Set([1]),
      count: 1,
      schedules: [blk(1, "08:00:00", "20:00:00")], // 720 → 480
      policy: "include",
    });
    expect(long[0].durationMin).toBe(480);
    const short = buildSessionPlan({
      start: D("2026-07-13"),
      days: new Set([1]),
      count: 1,
      schedules: [blk(1, "08:00:00", "08:05:00")], // 5 → 15
      policy: "include",
    });
    expect(short[0].durationMin).toBe(15);
  });
});

describe("buildSessionPlan — política de festivos", () => {
  it("include: marca el festivo pero lo conserva", () => {
    const rows = buildSessionPlan({
      start: D("2026-07-13"),
      days: new Set([1]),
      count: 3,
      policy: "include",
    });
    expect(rows.map((r) => r.iso)).toEqual(["2026-07-13", "2026-07-20", "2026-07-27"]);
    const jul20 = rows.find((r) => r.iso === "2026-07-20")!;
    expect(jul20.isHoliday).toBe(true);
    expect(jul20.holidayName).toBe("Día de la Independencia");
  });

  it("skip: omite festivos y recompleta hasta N", () => {
    const rows = buildSessionPlan({
      start: D("2026-07-13"),
      days: new Set([1]),
      count: 3,
      policy: "skip",
    });
    // 07-20 (Independencia) omitido → 07-13, 07-27, 08-03.
    expect(rows.map((r) => r.iso)).toEqual(["2026-07-13", "2026-07-27", "2026-08-03"]);
    expect(rows.every((r) => !r.isHoliday)).toBe(true);
    expect(rows.length).toBe(3);
  });

  it("move: reubica el festivo al siguiente día hábil (sin duplicar)", () => {
    const rows = buildSessionPlan({
      start: D("2026-07-13"),
      days: new Set([1]),
      count: 3,
      policy: "move",
    });
    // base 07-13/07-20/07-27; 07-20 festivo→07-27; 07-27 ya usado→08-03.
    expect(rows.map((r) => r.iso)).toEqual(["2026-07-13", "2026-07-27", "2026-08-03"]);
    expect(new Set(rows.map((r) => r.iso)).size).toBe(3); // sin duplicados
  });
});

describe("buildSessionPlan — degradado", () => {
  it("devuelve [] si count<=0 o sin días", () => {
    expect(buildSessionPlan({ start: D("2026-07-13"), days: new Set(), count: 3 })).toEqual([]);
    expect(buildSessionPlan({ start: D("2026-07-13"), days: new Set([1]), count: 0 })).toEqual([]);
  });
  it("títulos default 'Sesión N' y titleFor override", () => {
    const def = buildSessionPlan({ start: D("2026-07-13"), days: new Set([1]), count: 2, policy: "include" });
    expect(def.map((r) => r.title)).toEqual(["Sesión 1", "Sesión 2"]);
    const custom = buildSessionPlan({
      start: D("2026-07-13"), days: new Set([1]), count: 2, policy: "include",
      titleFor: (i) => `Clase ${i + 1}`,
    });
    expect(custom.map((r) => r.title)).toEqual(["Clase 1", "Clase 2"]);
  });
});
