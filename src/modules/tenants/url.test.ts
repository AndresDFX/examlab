/**
 * Tests para `getTenantSlugFromUrl`.
 *
 * Los helpers viejos (`computeRouterBasepath`, `buildTenantUrl`,
 * `createTenantRewrite`, `hardNavigateToTenant`) se removieron tras
 * el rollback del enfoque URL-prefix `/t/<slug>/...` (causaba 307
 * redirects en SSR de Lovable). Ver historia en `url.ts`.
 */
import { describe, it, expect } from "vitest";
import { getTenantSlugFromUrl } from "./url";

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
