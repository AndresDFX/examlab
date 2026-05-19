import { describe, expect, it } from "vitest";

import { checkAccess, findRouteRule, homeForRole } from "./rbac";

describe("findRouteRule", () => {
  it("picks the longest matching prefix", () => {
    expect(findRouteRule("/app/admin/users")?.prefix).toBe("/app/admin");
    expect(findRouteRule("/app/teacher/exams/123")?.prefix).toBe("/app/teacher");
    expect(findRouteRule("/app/student/take/abc")?.prefix).toBe("/app/student");
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
});

describe("homeForRole", () => {
  it("returns /app for authenticated roles", () => {
    expect(homeForRole("Admin")).toBe("/app");
    expect(homeForRole("Docente")).toBe("/app");
    expect(homeForRole("Estudiante")).toBe("/app");
  });

  it("returns /auth when there is no role", () => {
    expect(homeForRole(null)).toBe("/auth");
  });
});
