import { describe, expect, it } from "vitest";
import { hostDefinesTenant, subdomainTenantSlug, tenantUrlForSlug } from "./subdomain";

describe("tenantUrlForSlug", () => {
  const loc = (hostname: string, protocol = "https:", port = "") => ({ hostname, protocol, port });

  it("reemplaza la etiqueta del despliegue general por el slug", () => {
    expect(tenantUrlForSlug("sena", loc("app.examlab.workers.dev"))).toBe(
      "https://sena.examlab.workers.dev",
    );
    expect(tenantUrlForSlug("sena", loc("app.midominio.co"))).toBe("https://sena.midominio.co");
  });

  it("reemplaza el slug de otra institución, no lo apila", () => {
    // Estando en uniaj.*, la direccion de `sena` NO es sena.uniaj.* — eso
    // ademas sumaria un nivel que el certificado no cubre.
    expect(tenantUrlForSlug("sena", loc("uniaj.examlab.workers.dev"))).toBe(
      "https://sena.examlab.workers.dev",
    );
  });

  it("antepone cuando la primera etiqueta ES el dominio", () => {
    expect(tenantUrlForSlug("sena", loc("midominio.co"))).toBe("https://sena.midominio.co");
    // Dominio colombiano de dos partes: contar etiquetas daria `sena.com.co`.
    expect(tenantUrlForSlug("sena", loc("midominio.com.co"))).toBe("https://sena.midominio.com.co");
    // Raiz del subdominio de cuenta (sin Worker): daria `sena.workers.dev`.
    expect(tenantUrlForSlug("sena", loc("examlab.workers.dev"))).toBe(
      "https://sena.examlab.workers.dev",
    );
  });

  it("en desarrollo usa *.localhost con su puerto", () => {
    expect(tenantUrlForSlug("sena", loc("localhost", "http:", "5173"))).toBe(
      "http://sena.localhost:5173",
    );
    expect(tenantUrlForSlug("sena", loc("uniaj.localhost", "http:", "5173"))).toBe(
      "http://sena.localhost:5173",
    );
  });

  it("no promete direccion donde no puede haberla", () => {
    // Preferimos no mostrar nada a mostrar una direccion equivocada.
    expect(tenantUrlForSlug("sena", loc("examlab.lovable.app"))).toBeNull();
    expect(tenantUrlForSlug("sena", loc("x.pages.dev"))).toBeNull();
    expect(tenantUrlForSlug("sena", loc("127.0.0.1"))).toBeNull();
  });

  it("rechaza slugs invalidos y entradas vacias, sin lanzar", () => {
    expect(tenantUrlForSlug("", loc("app.examlab.workers.dev"))).toBeNull();
    expect(tenantUrlForSlug("no_valido", loc("app.examlab.workers.dev"))).toBeNull();
    expect(tenantUrlForSlug(null, loc("app.examlab.workers.dev"))).toBeNull();
    expect(tenantUrlForSlug("sena", null)).toBeNull();
    expect(tenantUrlForSlug("sena", loc(""))).toBeNull();
  });

  it("normaliza mayusculas y espacios del slug tipeado", () => {
    expect(tenantUrlForSlug("  SENA  ", loc("app.examlab.workers.dev"))).toBe(
      "https://sena.examlab.workers.dev",
    );
  });

  it("limitacion conocida: sobre el subdominio de OTRA institucion en dominio propio, apila", () => {
    // Sin la Public Suffix List no se puede distinguir `uniaj.midominio.co`
    // (subdominio) de `midominio.com.co` (dominio de dos partes). Se eligio
    // fallar de este lado: apilar da una direccion visiblemente rara, mientras
    // que el error opuesto (`sena.com.co`) inventa un dominio ajeno con pinta
    // de correcto. Caso raro: el SuperAdmin opera desde el despliegue general.
    expect(tenantUrlForSlug("sena", loc("uniaj.midominio.co"))).toBe(
      "https://sena.uniaj.midominio.co",
    );
  });
});

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
