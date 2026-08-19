import { describe, expect, it } from "vitest";
import { hostDefinesTenant, subdomainTenantSlug } from "./subdomain";

describe("subdomainTenantSlug", () => {
  it("toma el slug del subdominio", () => {
    expect(subdomainTenantSlug("uniaj.midominio.co")).toBe("uniaj");
    expect(subdomainTenantSlug("fesna.midominio.co")).toBe("fesna");
    // Los slugs reales del tenant llevan guiones.
    expect(subdomainTenantSlug("demo-global-corp.midominio.co")).toBe("demo-global-corp");
  });

  it("NO trata el host de Lovable como institución (la trampa principal)", () => {
    // Con la lógica naíf de "primera etiqueta", `examlab.lovable.app` —el host
    // que se usa HOY en producción— devolvería `examlab` e intentaría resolver
    // una institución inexistente en cada carga.
    expect(subdomainTenantSlug("examlab.lovable.app")).toBeNull();
    expect(subdomainTenantSlug("preview--algo.lovable.app")).toBeNull();
    for (const h of ["x.pages.dev", "x.vercel.app", "x.netlify.app", "x.workers.dev"]) {
      expect(subdomainTenantSlug(h)).toBeNull();
    }
  });

  it("dominio desnudo y www conservan el selector", () => {
    expect(subdomainTenantSlug("midominio.co")).toBeNull();
    expect(subdomainTenantSlug("www.midominio.co")).toBeNull();
  });

  it("etiquetas reservadas no son instituciones", () => {
    for (const l of ["app", "api", "admin", "auth", "cdn", "staging"]) {
      expect(subdomainTenantSlug(`${l}.midominio.co`)).toBeNull();
    }
  });

  it("localhost e IPs no tienen subdominio que interpretar", () => {
    expect(subdomainTenantSlug("localhost")).toBeNull();
    expect(subdomainTenantSlug("127.0.0.1")).toBeNull();
    expect(subdomainTenantSlug("::1")).toBeNull();
    expect(subdomainTenantSlug("[::1]")).toBeNull();
  });

  it("acepta uniaj.localhost para desarrollo", () => {
    expect(subdomainTenantSlug("uniaj.localhost")).toBe("uniaj");
  });

  it("normaliza mayúsculas, espacios y el punto final del FQDN", () => {
    expect(subdomainTenantSlug("  UNIAJ.MiDominio.CO  ")).toBe("uniaj");
    expect(subdomainTenantSlug("uniaj.midominio.co.")).toBe("uniaj");
  });

  it("rechaza etiquetas que no son un slug válido, sin lanzar", () => {
    expect(subdomainTenantSlug("no_valido.midominio.co")).toBeNull();
    expect(subdomainTenantSlug("")).toBeNull();
    expect(subdomainTenantSlug(null)).toBeNull();
    expect(subdomainTenantSlug(undefined)).toBeNull();
  });

  it("un subdominio de tercer nivel toma solo la primera etiqueta", () => {
    // Universal SSL de Cloudflare cubre UN nivel, así que esto no debería
    // ocurrir en producción; se define el comportamiento igual.
    expect(subdomainTenantSlug("uniaj.sede.midominio.co")).toBe("uniaj");
  });
});

describe("hostDefinesTenant", () => {
  it("decide si se oculta el selector", () => {
    expect(hostDefinesTenant("uniaj.midominio.co")).toBe(true);
    expect(hostDefinesTenant("examlab.lovable.app")).toBe(false);
    expect(hostDefinesTenant("midominio.co")).toBe(false);
  });
});
