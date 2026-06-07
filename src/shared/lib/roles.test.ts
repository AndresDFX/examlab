import { describe, it, expect } from "vitest";
import { isAdminLike, isStaffRole, isStudent, isSuperAdmin } from "./roles";

describe("roles helpers", () => {
  describe("isSuperAdmin", () => {
    it("true cuando incluye SuperAdmin", () => {
      expect(isSuperAdmin(["SuperAdmin"])).toBe(true);
      expect(isSuperAdmin(["Admin", "SuperAdmin"])).toBe(true);
    });
    it("false si no", () => {
      expect(isSuperAdmin([])).toBe(false);
      expect(isSuperAdmin(["Admin"])).toBe(false);
      expect(isSuperAdmin(["Docente", "Estudiante"])).toBe(false);
    });
  });

  describe("isAdminLike", () => {
    it("true para Admin", () => {
      expect(isAdminLike(["Admin"])).toBe(true);
    });
    it("true para SuperAdmin", () => {
      expect(isAdminLike(["SuperAdmin"])).toBe(true);
    });
    it("false para Docente / Estudiante", () => {
      expect(isAdminLike(["Docente"])).toBe(false);
      expect(isAdminLike(["Estudiante"])).toBe(false);
    });
  });

  describe("isStaffRole", () => {
    it("incluye Docente, Admin y SuperAdmin", () => {
      expect(isStaffRole(["Docente"])).toBe(true);
      expect(isStaffRole(["Admin"])).toBe(true);
      expect(isStaffRole(["SuperAdmin"])).toBe(true);
    });
    it("false para Estudiante", () => {
      expect(isStaffRole(["Estudiante"])).toBe(false);
    });
    it("false para array vacío", () => {
      expect(isStaffRole([])).toBe(false);
    });
  });

  describe("isStudent", () => {
    it("true SOLO si tiene Estudiante", () => {
      expect(isStudent(["Estudiante"])).toBe(true);
      expect(isStudent(["Docente"])).toBe(false);
      expect(isStudent(["SuperAdmin"])).toBe(false);
    });
  });
});
