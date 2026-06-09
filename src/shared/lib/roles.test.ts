import { describe, it, expect } from "vitest";
import { isAdminLike, isStaffActive, isStaffRole, isStudent, isSuperAdmin } from "./roles";

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

  describe("isStaffActive", () => {
    const allThree = ["Estudiante", "Docente", "Admin"];

    it("multi-rol actuando como Estudiante NO es staff (bug reportado)", () => {
      // Aunque POSEE Docente+Admin, el rol activo manda.
      expect(isStaffActive("Estudiante", allThree)).toBe(false);
    });

    it("mismo usuario actuando como Docente/Admin SÍ es staff", () => {
      expect(isStaffActive("Docente", allThree)).toBe(true);
      expect(isStaffActive("Admin", allThree)).toBe(true);
    });

    it("SuperAdmin activo es staff", () => {
      expect(isStaffActive("SuperAdmin", ["SuperAdmin"])).toBe(true);
    });

    it("rol activo manda aunque NO esté en los poseídos (no debería pasar, pero el contrato es claro)", () => {
      expect(isStaffActive("Docente", ["Estudiante"])).toBe(true);
      expect(isStaffActive("Estudiante", ["Docente"])).toBe(false);
    });

    it("activeRole null/vacío cae a los roles poseídos (primer render)", () => {
      expect(isStaffActive(null, allThree)).toBe(true);
      expect(isStaffActive(undefined, ["Docente"])).toBe(true);
      expect(isStaffActive(null, ["Estudiante"])).toBe(false);
      expect(isStaffActive("", ["Estudiante"])).toBe(false);
      expect(isStaffActive("", ["Docente"])).toBe(true);
    });
  });
});
