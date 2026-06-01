/**
 * Tests de los helpers compat `readTenantOverride` / `clearTenantOverrideSilent`.
 *
 * Con la nueva arquitectura URL-driven, `readTenantOverride()` es un
 * wrapper de `getTenantSlugFromUrl()` (mantiene el nombre para no
 * romper call-sites legacy que detectan "modo SuperAdmin cross-tenant"
 * con `!readTenantOverride()`). Verificamos que efectivamente lea de la
 * URL y no del localStorage viejo.
 *
 * `setTenantOverride` hace `window.location.href = ...` (hard nav) que
 * jsdom no ejecuta — no se testea acá. El comportamiento real se cubre
 * en los tests de URL helpers en `url.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readTenantOverride, clearTenantOverrideSilent } from "./use-tenant";

describe("readTenantOverride() — URL-driven", () => {
  let originalPath: string;
  beforeEach(() => {
    originalPath = window.location.pathname;
  });
  afterEach(() => {
    window.history.replaceState({}, "", originalPath);
  });

  it("retorna slug del path /t/<slug>/...", () => {
    window.history.replaceState({}, "", "/t/acme/app/admin");
    expect(readTenantOverride()).toBe("acme");
  });

  it("retorna null cuando el path no tiene prefijo /t/", () => {
    window.history.replaceState({}, "", "/app/admin");
    expect(readTenantOverride()).toBeNull();
  });

  it("retorna null en /auth (login)", () => {
    window.history.replaceState({}, "", "/auth");
    expect(readTenantOverride()).toBeNull();
  });

  it("IGNORA el localStorage viejo (no es la fuente de verdad)", () => {
    // Aunque alguien dejó valor en localStorage (sesión vieja), la URL
    // manda. Esto verifica que migramos correctamente.
    window.localStorage.setItem("examlab_tenant_override", "stale-tenant");
    window.history.replaceState({}, "", "/app/admin");
    expect(readTenantOverride()).toBeNull();
    window.localStorage.removeItem("examlab_tenant_override");
  });
});

describe("clearTenantOverrideSilent() — compat no-op", () => {
  it("no lanza", () => {
    expect(() => clearTenantOverrideSilent()).not.toThrow();
  });
});
