/**
 * Tests para los helpers de URL del routing multi-tenant.
 *
 * `getTenantSlugFromUrl` y `computeRouterBasepath` son puras (sin side
 * effects) — pasamos un pathname explícito o stubbeamos
 * `window.location.pathname`. `hardNavigateToTenant` haría reload real
 * en browser, no la testeamos acá.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getTenantSlugFromUrl,
  buildTenantUrl,
  computeRouterBasepath,
  createTenantRewrite,
} from "./url";

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

describe("createTenantRewrite()", () => {
  let originalPath: string;
  beforeEach(() => {
    originalPath = window.location.pathname;
  });
  afterEach(() => {
    window.history.replaceState({}, "", originalPath);
  });

  it("INPUT strippea /t/<slug> de URLs entrantes", () => {
    window.history.replaceState({}, "", "/t/acme/app");
    const rw = createTenantRewrite();
    const url = new URL("https://x.com/t/acme/app/admin/users");
    rw.input?.({ url });
    expect(url.pathname).toBe("/app/admin/users");
  });

  it("INPUT con path = /t/<slug> a secas se vuelve /", () => {
    window.history.replaceState({}, "", "/t/acme");
    const rw = createTenantRewrite();
    const url = new URL("https://x.com/t/acme");
    rw.input?.({ url });
    expect(url.pathname).toBe("/");
  });

  it("INPUT deja pasar URLs sin prefix", () => {
    window.history.replaceState({}, "", "/t/acme/app");
    const rw = createTenantRewrite();
    const url = new URL("https://x.com/app/admin/users");
    rw.input?.({ url });
    expect(url.pathname).toBe("/app/admin/users");
  });

  it("OUTPUT agrega /t/<slug> a URLs salientes cuando hay slug capturado", () => {
    window.history.replaceState({}, "", "/t/acme/app");
    const rw = createTenantRewrite();
    const url = new URL("https://x.com/app/admin/users");
    rw.output?.({ url });
    expect(url.pathname).toBe("/t/acme/app/admin/users");
  });

  it("OUTPUT es no-op cuando NO hay slug capturado", () => {
    window.history.replaceState({}, "", "/app/admin");
    const rw = createTenantRewrite();
    const url = new URL("https://x.com/app/admin/users");
    rw.output?.({ url });
    expect(url.pathname).toBe("/app/admin/users");
  });

  it("OUTPUT no re-prefija URLs que ya tienen el prefix", () => {
    window.history.replaceState({}, "", "/t/acme/app");
    const rw = createTenantRewrite();
    const url = new URL("https://x.com/t/acme/app/admin/users");
    rw.output?.({ url });
    expect(url.pathname).toBe("/t/acme/app/admin/users");
  });

  it("OUTPUT NO prefija /auth (auth es ruta global del sistema)", () => {
    window.history.replaceState({}, "", "/t/acme/app");
    const rw = createTenantRewrite();
    const url = new URL("https://x.com/auth");
    rw.output?.({ url });
    expect(url.pathname).toBe("/auth");
  });

  it("OUTPUT NO prefija / (landing)", () => {
    window.history.replaceState({}, "", "/t/acme/app");
    const rw = createTenantRewrite();
    const url = new URL("https://x.com/");
    rw.output?.({ url });
    expect(url.pathname).toBe("/");
  });

  it("round-trip: output → input devuelve el path original", () => {
    window.history.replaceState({}, "", "/t/acme/app");
    const rw = createTenantRewrite();
    const url = new URL("https://x.com/app/teacher/courses");
    rw.output?.({ url });
    expect(url.pathname).toBe("/t/acme/app/teacher/courses");
    rw.input?.({ url });
    expect(url.pathname).toBe("/app/teacher/courses");
  });
});
