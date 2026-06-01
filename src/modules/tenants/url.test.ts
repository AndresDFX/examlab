/**
 * Tests para los helpers de URL del routing multi-tenant.
 *
 * `getTenantSlugFromUrl` y `computeRouterBasepath` son puras (sin side
 * effects) — pasamos un pathname explícito o stubbeamos
 * `window.location.pathname`. `hardNavigateToTenant` haría reload real
 * en browser, no la testeamos acá.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getTenantSlugFromUrl, buildTenantUrl, computeRouterBasepath } from "./url";

describe("getTenantSlugFromUrl(pathname)", () => {
  it("extrae el slug de /t/<slug>/app/...", () => {
    expect(getTenantSlugFromUrl("/t/acme/app/admin/users")).toBe("acme");
  });

  it("extrae el slug cuando el path es exactamente /t/<slug>", () => {
    expect(getTenantSlugFromUrl("/t/acme")).toBe("acme");
  });

  it("extrae el slug con guion + dígitos", () => {
    expect(getTenantSlugFromUrl("/t/sena-bogota-2/app")).toBe("sena-bogota-2");
  });

  it("retorna null si no hay prefijo /t/", () => {
    expect(getTenantSlugFromUrl("/app/admin/users")).toBeNull();
    expect(getTenantSlugFromUrl("/auth")).toBeNull();
    expect(getTenantSlugFromUrl("/")).toBeNull();
  });

  it("retorna null para slug inválido (mayúsculas, símbolos)", () => {
    expect(getTenantSlugFromUrl("/t/ACME/app")).toBeNull();
    expect(getTenantSlugFromUrl("/t/acme!/app")).toBeNull();
    expect(getTenantSlugFromUrl("/t/-acme/app")).toBeNull();
  });

  it("retorna null para slug demasiado corto", () => {
    expect(getTenantSlugFromUrl("/t/ab/app")).toBeNull();
  });

  it("no matchea si /t/ aparece más adelante en el path", () => {
    expect(getTenantSlugFromUrl("/app/t/acme/foo")).toBeNull();
  });

  it("matchea cuando el slug está seguido de un slash o fin", () => {
    expect(getTenantSlugFromUrl("/t/acme/")).toBe("acme");
    expect(getTenantSlugFromUrl("/t/acme")).toBe("acme");
  });
});

describe("buildTenantUrl(slug, path)", () => {
  it("agrega prefix si slug válido", () => {
    expect(buildTenantUrl("acme", "/app/admin/users")).toBe("/t/acme/app/admin/users");
  });

  it("normaliza path sin slash inicial", () => {
    expect(buildTenantUrl("acme", "app/admin")).toBe("/t/acme/app/admin");
  });

  it("retorna path sin prefix si slug es null", () => {
    expect(buildTenantUrl(null, "/app")).toBe("/app");
  });

  it("retorna path sin prefix si slug es inválido", () => {
    expect(buildTenantUrl("ACME", "/app")).toBe("/app");
    expect(buildTenantUrl("", "/app")).toBe("/app");
  });
});

describe("computeRouterBasepath()", () => {
  // Stub window.location.pathname para cada test.
  let originalPath: string;
  beforeEach(() => {
    originalPath = window.location.pathname;
  });
  afterEach(() => {
    window.history.replaceState({}, "", originalPath);
  });

  it("retorna /t/<slug> cuando URL tiene prefix válido", () => {
    window.history.replaceState({}, "", "/t/acme/app/admin");
    expect(computeRouterBasepath()).toBe("/t/acme");
  });

  it("retorna string vacío cuando URL no tiene prefix", () => {
    window.history.replaceState({}, "", "/app/admin");
    expect(computeRouterBasepath()).toBe("");
  });

  it("retorna string vacío en /auth", () => {
    window.history.replaceState({}, "", "/auth");
    expect(computeRouterBasepath()).toBe("");
  });
});
