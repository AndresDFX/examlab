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

  describe("workers.dev es la excepción: un Worker por institución", () => {
    it("lee el slug del nombre del Worker", () => {
      // `<worker>.<cuenta>.workers.dev`: la primera etiqueta la elegimos al
      // desplegar, así que la nombramos con el slug de la institución.
      expect(subdomainTenantSlug("uniaj.examlab.workers.dev")).toBe("uniaj");
      expect(subdomainTenantSlug("fesna.examlab.workers.dev")).toBe("fesna");
      expect(subdomainTenantSlug("demo-global-corp.examlab.workers.dev")).toBe("demo-global-corp");
    });

    it("la raíz del subdominio de cuenta no tiene Worker ni slug", () => {
      // 3 etiquetas: no hay nombre de Worker que leer. Es lo que distingue este
      // caso del de arriba y lo que hace segura la excepción.
      expect(subdomainTenantSlug("examlab.workers.dev")).toBeNull();
    });

    it("el despliegue principal usa una etiqueta reservada y conserva el selector", () => {
      expect(subdomainTenantSlug("app.examlab.workers.dev")).toBeNull();
      expect(hostDefinesTenant("app.examlab.workers.dev")).toBe(false);
    });

    it("funciona sin importar cómo se llame el subdominio de la cuenta", () => {
      // El corte es por cantidad de etiquetas, no por el nombre de la cuenta:
      // si algún día cambia, esto sigue valiendo.
      expect(subdomainTenantSlug("uniaj.otra-cuenta.workers.dev")).toBe("uniaj");
    });
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
