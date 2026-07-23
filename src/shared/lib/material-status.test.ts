import { describe, it, expect } from "vitest";
import {
  isMaterialClosed,
  matchesMaterialStatus,
  DEFAULT_MATERIAL_STATUS_FILTER,
} from "./material-status";
import type { CourseLifecycleShape } from "@/modules/courses/course-status";

const NOW = new Date("2026-06-15T12:00:00").getTime();

function mapOf(entries: Record<string, CourseLifecycleShape>): Map<string, CourseLifecycleShape> {
  return new Map(Object.entries(entries));
}

describe("material-status", () => {
  it("default filter is 'activos'", () => {
    expect(DEFAULT_MATERIAL_STATUS_FILTER).toBe("activos");
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

  describe("matchesMaterialStatus", () => {
    const courses = mapOf({
      fin: { status: "finalizado" },
      cur: { status: "en_curso" },
    });

    it("'activos' shows non-finalized + global, hides finalized", () => {
      expect(matchesMaterialStatus("cur", courses, "activos", NOW)).toBe(true);
      expect(matchesMaterialStatus(null, courses, "activos", NOW)).toBe(true);
      expect(matchesMaterialStatus("fin", courses, "activos", NOW)).toBe(false);
    });

    it("'cerrados' shows only finalized", () => {
      expect(matchesMaterialStatus("fin", courses, "cerrados", NOW)).toBe(true);
      expect(matchesMaterialStatus("cur", courses, "cerrados", NOW)).toBe(false);
      expect(matchesMaterialStatus(null, courses, "cerrados", NOW)).toBe(false);
    });

    it("'todos' shows everything", () => {
      expect(matchesMaterialStatus("fin", courses, "todos", NOW)).toBe(true);
      expect(matchesMaterialStatus("cur", courses, "todos", NOW)).toBe(true);
      expect(matchesMaterialStatus(null, courses, "todos", NOW)).toBe(true);
    });
  });
});
