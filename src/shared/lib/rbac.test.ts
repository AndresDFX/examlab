import { describe, expect, it } from "vitest";

import { checkAccess, findRouteRule, homeForRole } from "./rbac";

describe("findRouteRule", () => {
  it("picks the longest matching prefix", () => {
    expect(findRouteRule("/app/admin/users")?.prefix).toBe("/app/admin");
    // /app/teacher/exams tiene regla específica para incluir SuperAdmin
    // (paridad con item del NAV) — longest-prefix la elige sobre la regla
    // genérica /app/teacher. Mismo patrón para los demás subpaths con
    // SA documentados en rbac.ts.
    expect(findRouteRule("/app/teacher/exams/123")?.prefix).toBe("/app/teacher/exams");
    expect(findRouteRule("/app/teacher/anything-else")?.prefix).toBe("/app/teacher");
    expect(findRouteRule("/app/student/take/abc")?.prefix).toBe("/app/student");
    expect(findRouteRule("/app/superadmin/tenants")?.prefix).toBe("/app/superadmin");
  });

  it("SuperAdmin tiene reglas explícitas sobre /app/teacher/* listadas en el NAV", () => {
    // Sin estas reglas el SA veía los items en el sidebar pero el guard
    // los redirigía a /unauthorized (bug detectado en auditoría 2026-09).
    const teacherSubpaths = [
      "/app/teacher/question-bank",
      "/app/teacher/exams",
      "/app/teacher/monitor",
      "/app/teacher/workshops",
      "/app/teacher/projects",
      "/app/teacher/gradebook",
      "/app/teacher/grading",
      "/app/teacher/attendance",
      "/app/teacher/calendar",
      "/app/teacher/contents",
      "/app/teacher/whiteboards",
      "/app/teacher/polls",
    ];
    for (const path of teacherSubpaths) {
      const rule = findRouteRule(path);
      expect(rule?.roles).toContain("SuperAdmin");
    }
  });

  it("falls back to /app for generic app routes", () => {
    expect(findRouteRule("/app")?.prefix).toBe("/app");
  });

  it("returns null for routes outside the app shell", () => {
    expect(findRouteRule("/auth")).toBeNull();
  });
});

describe("checkAccess", () => {
  it("grants access when the active role matches the rule", () => {
    expect(checkAccess("/app/admin/users", "Admin", ["Admin"])).toBeNull();
    expect(checkAccess("/app/teacher/exams", "Docente", ["Docente"])).toBeNull();
    expect(checkAccess("/app/student/exams", "Estudiante", ["Estudiante"])).toBeNull();
  });

  it("redirects to /app/unauthorized when role mismatches", () => {
    expect(checkAccess("/app/admin/users", "Estudiante", ["Estudiante"])).toBe("/app/unauthorized");
    expect(checkAccess("/app/teacher/exams", "Estudiante", ["Estudiante"])).toBe(
      "/app/unauthorized",
    );
  });

  it("redirects to /auth when there is no active role", () => {
    expect(checkAccess("/app/admin/users", null, [])).toBe("/auth");
  });

  it("grants access on open routes regardless of role", () => {
    expect(checkAccess("/app", "Estudiante", ["Estudiante"])).toBeNull();
    expect(checkAccess("/app/unauthorized", "Estudiante", ["Estudiante"])).toBeNull();
  });

  it("SuperAdmin accede a /app/admin (rutas Admin) y a /app/superadmin", () => {
    expect(checkAccess("/app/admin/users", "SuperAdmin", ["SuperAdmin"])).toBeNull();
    expect(checkAccess("/app/admin/settings", "SuperAdmin", ["SuperAdmin"])).toBeNull();
    expect(
      checkAccess("/app/superadmin/tenants", "SuperAdmin", ["SuperAdmin"]),
    ).toBeNull();
  });

  it("Admin NO accede a /app/superadmin (es cross-tenant)", () => {
    expect(checkAccess("/app/superadmin/tenants", "Admin", ["Admin"])).toBe(
      "/app/unauthorized",
    );
  });

  it("Docente y Estudiante NO acceden a /app/superadmin", () => {
    expect(checkAccess("/app/superadmin/tenants", "Docente", ["Docente"])).toBe(
      "/app/unauthorized",
    );
    expect(
      checkAccess("/app/superadmin/tenants", "Estudiante", ["Estudiante"]),
    ).toBe("/app/unauthorized");
  });

  it("Estudiante NO accede a /app/videos ni /app/certificates (staff-only)", () => {
    // Sin reglas explícitas el alumno entraba por la fallback /app
    // (any auth). RLS recortaba data pero defensa-en-profundidad pide
    // RBAC explícito (auditoría 2026-09).
    expect(checkAccess("/app/videos", "Estudiante", ["Estudiante"])).toBe(
      "/app/unauthorized",
    );
    expect(checkAccess("/app/certificates", "Estudiante", ["Estudiante"])).toBe(
      "/app/unauthorized",
    );
  });

  it("SuperAdmin accede a /app/teacher/exams (paridad con NAV)", () => {
    // Antes el SA tenía el item en el sidebar pero el guard lo bloqueaba.
    expect(checkAccess("/app/teacher/exams", "SuperAdmin", ["SuperAdmin"])).toBeNull();
    expect(checkAccess("/app/teacher/gradebook", "SuperAdmin", ["SuperAdmin"])).toBeNull();
    expect(checkAccess("/app/teacher/question-bank", "SuperAdmin", ["SuperAdmin"])).toBeNull();
  });

  it("Docente sigue accediendo a las rutas relajadas con SuperAdmin", () => {
    // El SA se agrega como segundo rol permitido; el Docente no pierde acceso.
    expect(checkAccess("/app/teacher/exams", "Docente", ["Docente"])).toBeNull();
    expect(checkAccess("/app/teacher/gradebook", "Docente", ["Docente"])).toBeNull();
  });
});

describe("homeForRole", () => {
  it("returns /app for authenticated roles", () => {
    expect(homeForRole("Admin")).toBe("/app");
    expect(homeForRole("Docente")).toBe("/app");
    expect(homeForRole("Estudiante")).toBe("/app");
    expect(homeForRole("SuperAdmin")).toBe("/app");
  });

  it("returns /auth when there is no role", () => {
    expect(homeForRole(null)).toBe("/auth");
  });
});
