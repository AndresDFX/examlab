/**
 * Tests de los helpers `readTenantOverride` / `setTenantOverride`.
 *
 * El "override" vive en localStorage `examlab_tenant_override`. Lo
 * usa el SuperAdmin para "Ver como X" — `useTenant` lo lee y resuelve
 * a ESE tenant en vez del de `profile.tenant_id`.
 *
 * (Hubo un intento previo de moverlo a URL slug `/t/<slug>/...` pero
 * fracasó por 307 redirects del SSR de Lovable — ver
 * `TenantUrlGuard.tsx` para historia.)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readTenantOverride, setTenantOverride, clearTenantOverrideSilent } from "./use-tenant";

const OVERRIDE_KEY = "examlab_tenant_override";

describe("readTenantOverride() — localStorage", () => {
  beforeEach(() => {
    window.localStorage.removeItem(OVERRIDE_KEY);
  });

  it("retorna slug válido del localStorage", () => {
    window.localStorage.setItem(OVERRIDE_KEY, "acme");
    expect(readTenantOverride()).toBe("acme");
  });

  it("retorna slug con dígitos y guiones", () => {
    window.localStorage.setItem(OVERRIDE_KEY, "sena-bogota-2");
    expect(readTenantOverride()).toBe("sena-bogota-2");
  });

  it("retorna null cuando localStorage está vacío", () => {
    expect(readTenantOverride()).toBeNull();
  });

  it("retorna null si el slug en storage es inválido (mayúsculas)", () => {
    window.localStorage.setItem(OVERRIDE_KEY, "INVALID");
    expect(readTenantOverride()).toBeNull();
  });

  it("acepta formato legacy JSON { slug, ts } (era URL-based)", () => {
    window.localStorage.setItem(
      OVERRIDE_KEY,
      JSON.stringify({ slug: "acme", ts: Date.now() }),
    );
    expect(readTenantOverride()).toBe("acme");
  });

  it("retorna null si el JSON legacy tiene slug inválido", () => {
    window.localStorage.setItem(
      OVERRIDE_KEY,
      JSON.stringify({ slug: "INVALID", ts: Date.now() }),
    );
    expect(readTenantOverride()).toBeNull();
  });
});

describe("setTenantOverride() — localStorage", () => {
  beforeEach(() => {
    window.localStorage.removeItem(OVERRIDE_KEY);
  });

  it("escribe slug válido al localStorage", () => {
    setTenantOverride("acme");
    expect(window.localStorage.getItem(OVERRIDE_KEY)).toBe("acme");
  });

  it("null limpia el localStorage", () => {
    window.localStorage.setItem(OVERRIDE_KEY, "acme");
    setTenantOverride(null);
    expect(window.localStorage.getItem(OVERRIDE_KEY)).toBeNull();
  });

  it("slug inválido limpia el localStorage (no persiste basura)", () => {
    window.localStorage.setItem(OVERRIDE_KEY, "acme");
    setTenantOverride("INVALID-CAPS");
    expect(window.localStorage.getItem(OVERRIDE_KEY)).toBeNull();
  });

  it("dispara CustomEvent para notificar a useTenant hooks montados", () => {
    let received = false;
    const handler = () => {
      received = true;
    };
    window.addEventListener("examlab:tenant-override-changed", handler);
    setTenantOverride("acme");
    window.removeEventListener("examlab:tenant-override-changed", handler);
    expect(received).toBe(true);
  });
});

describe("clearTenantOverrideSilent()", () => {
  it("limpia el localStorage sin lanzar", () => {
    window.localStorage.setItem(OVERRIDE_KEY, "acme");
    expect(() => clearTenantOverrideSilent()).not.toThrow();
    expect(window.localStorage.getItem(OVERRIDE_KEY)).toBeNull();
  });

  it("no lanza si no hay nada", () => {
    expect(() => clearTenantOverrideSilent()).not.toThrow();
  });
});
