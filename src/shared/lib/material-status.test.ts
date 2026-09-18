import { describe, it, expect } from "vitest";
import {
  isMaterialClosed,
  materialStatusValue,
  matchesMaterialStatus,
  MATERIAL_STATUS_VALUES,
  DEFAULT_MATERIAL_STATUS_FILTER,
} from "./material-status";
import type { CourseLifecycleShape } from "@/modules/courses/course-status";

const NOW = new Date("2026-06-15T12:00:00").getTime();

function mapOf(entries: Record<string, CourseLifecycleShape>): Map<string, CourseLifecycleShape> {
  return new Map(Object.entries(entries));
}

describe("material-status", () => {
  it("default filter oculta cerrados (no es vacío)", () => {
    expect([...DEFAULT_MATERIAL_STATUS_FILTER]).toEqual(["activos"]);
    expect([...MATERIAL_STATUS_VALUES]).toEqual(["activos", "cerrados"]);
  });

  describe("isMaterialClosed", () => {
    const courses = mapOf({
      fin: { status: "finalizado" },
      cur: { status: "en_curso" },
      bor: { status: "borrador" },
      prox: { status: "en_curso", start_date: "2027-01-01" },
    });

    it("closed only when the related course is finalizado", () => {
      expect(isMaterialClosed("fin", courses, NOW)).toBe(true);
      expect(isMaterialClosed("cur", courses, NOW)).toBe(false);
      expect(isMaterialClosed("bor", courses, NOW)).toBe(false);
      expect(isMaterialClosed("prox", courses, NOW)).toBe(false);
    });

    it("material without a course (null/undefined) is never closed", () => {
      expect(isMaterialClosed(null, courses, NOW)).toBe(false);
      expect(isMaterialClosed(undefined, courses, NOW)).toBe(false);
    });

    it("a course missing from the map is treated as not closed", () => {
      expect(isMaterialClosed("ghost", courses, NOW)).toBe(false);
    });

    it("finalizado is terminal regardless of dates", () => {
      const m = mapOf({ x: { status: "finalizado", end_date: "2999-01-01" } });
      expect(isMaterialClosed("x", m, NOW)).toBe(true);
    });
  });

  describe("matchesMaterialStatus (selección múltiple)", () => {
    const courses = mapOf({
      fin: { status: "finalizado" },
      cur: { status: "en_curso" },
    });

    it("materialStatusValue mapea al estado atómico", () => {
      expect(materialStatusValue("fin", courses, NOW)).toBe("cerrados");
      expect(materialStatusValue("cur", courses, NOW)).toBe("activos");
      expect(materialStatusValue(null, courses, NOW)).toBe("activos");
    });

    it("default ['activos'] muestra no-finalizados + global, oculta finalizados", () => {
      expect(matchesMaterialStatus("cur", courses, DEFAULT_MATERIAL_STATUS_FILTER, NOW)).toBe(true);
      expect(matchesMaterialStatus(null, courses, DEFAULT_MATERIAL_STATUS_FILTER, NOW)).toBe(true);
      expect(matchesMaterialStatus("fin", courses, DEFAULT_MATERIAL_STATUS_FILTER, NOW)).toBe(false);
    });

    it("['cerrados'] muestra solo finalizados", () => {
      expect(matchesMaterialStatus("fin", courses, ["cerrados"], NOW)).toBe(true);
      expect(matchesMaterialStatus("cur", courses, ["cerrados"], NOW)).toBe(false);
      expect(matchesMaterialStatus(null, courses, ["cerrados"], NOW)).toBe(false);
    });

    it("vacío = sin filtrar: muestra todo", () => {
      expect(matchesMaterialStatus("fin", courses, [], NOW)).toBe(true);
      expect(matchesMaterialStatus("cur", courses, [], NOW)).toBe(true);
      expect(matchesMaterialStatus(null, courses, [], NOW)).toBe(true);
    });
  });
});
