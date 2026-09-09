import { describe, expect, it } from "vitest";

import {
  academicScope,
  conTenant,
  debeConsultar,
  necesitaAcotarPorInstitucion,
} from "./academic-scope";

/** Builder falso: registra cada `.eq(col, val)` y se devuelve a sí mismo. */
function fakeBuilder() {
  const llamadas: Array<[string, string]> = [];
  const q = {
    llamadas,
    eq(col: string, val: string) {
      llamadas.push([col, val]);
      return q;
    },
  };
  return q;
}

describe("necesitaAcotarPorInstitucion", () => {
  it("un Admin no necesita acotar: la RLS ya lo hace", () => {
    expect(necesitaAcotarPorInstitucion(["Admin"])).toBe(false);
    expect(necesitaAcotarPorInstitucion(["Docente", "Estudiante"])).toBe(false);
    expect(necesitaAcotarPorInstitucion([])).toBe(false);
  });

  it("quien POSEE SuperAdmin necesita acotar, sin importar los otros roles", () => {
    expect(necesitaAcotarPorInstitucion(["SuperAdmin"])).toBe(true);
    expect(necesitaAcotarPorInstitucion(["Docente", "SuperAdmin"])).toBe(true);
  });
});

describe("academicScope", () => {
  it("Admin ⇒ sin-acotar (el filtro es un no-op explícito)", () => {
    expect(academicScope({ roles: ["Admin"], institucionElegida: null })).toEqual({
      modo: "sin-acotar",
    });
    // Aun con institución elegida: un Admin nunca filtra por un id del cliente,
    // porque useTenant() puede resolver por subdominio a otra institución.
    expect(academicScope({ roles: ["Admin"], institucionElegida: "t-1" })).toEqual({
      modo: "sin-acotar",
    });
  });

  it("SuperAdmin actuando como Admin TAMBIÉN se acota (el caso que hoy está mal)", () => {
    expect(
      academicScope({ roles: ["Admin", "SuperAdmin"], institucionElegida: null }),
    ).toEqual({ modo: "sin-institucion" });
  });

  it("SuperAdmin que actúa como Admin se acota a SU institución, no a nada", () => {
    // El gate de «si hay que acotar» es el rol POSEÍDO, pero el Select de
    // institución solo se renderiza para el rol ACTIVO SuperAdmin. Un usuario
    // con [SuperAdmin, Admin] que se pasa a Admin no ve ese Select, así que
    // `institucionElegida` llega vacía: sin este camino la pantalla le quedaba
    // vacía, sin salida, y encima mostrando «No hay cursos disponibles en esta
    // institución» — el mismo mensaje que este módulo vino a eliminar.
    expect(
      academicScope({
        roles: ["Admin", "SuperAdmin"],
        institucionElegida: null,
        actuandoComoSuperAdmin: false,
        tenantPropio: "t-mio",
      }),
    ).toEqual({ modo: "institucion", tenantId: "t-mio" });
  });

  it("…y si tampoco tiene institución propia, no lista nada (nunca todo)", () => {
    for (const propio of [null, undefined, "", "   ", "all"]) {
      expect(
        academicScope({
          roles: ["SuperAdmin"],
          institucionElegida: null,
          actuandoComoSuperAdmin: false,
          tenantPropio: propio,
        }),
        `tenantPropio=${JSON.stringify(propio)}`,
      ).toEqual({ modo: "sin-institucion" });
    }
  });

  it("actuando COMO SuperAdmin manda la institución elegida, no la propia", () => {
    expect(
      academicScope({
        roles: ["Admin", "SuperAdmin"],
        institucionElegida: "t-elegida",
        actuandoComoSuperAdmin: true,
        tenantPropio: "t-mio",
      }),
    ).toEqual({ modo: "institucion", tenantId: "t-elegida" });
  });

  it("SuperAdmin con institución elegida ⇒ institucion", () => {
    expect(academicScope({ roles: ["SuperAdmin"], institucionElegida: "t-9" })).toEqual({
      modo: "institucion",
      tenantId: "t-9",
    });
  });

  it("los centinelas de los Select NO son un id ⇒ sin-institucion", () => {
    for (const centinela of ["all", "none", "__none__", "", "   "]) {
      expect(
        academicScope({ roles: ["SuperAdmin"], institucionElegida: centinela }),
      ).toEqual({ modo: "sin-institucion" });
    }
    expect(
      academicScope({ roles: ["SuperAdmin"], institucionElegida: undefined }),
    ).toEqual({ modo: "sin-institucion" });
  });

  it("recorta espacios alrededor del id", () => {
    expect(academicScope({ roles: ["SuperAdmin"], institucionElegida: "  t-3 " })).toEqual({
      modo: "institucion",
      tenantId: "t-3",
    });
  });
});

describe("debeConsultar", () => {
  it("solo corta cuando falta la institución", () => {
    expect(debeConsultar({ modo: "sin-acotar" })).toBe(true);
    expect(debeConsultar({ modo: "institucion", tenantId: "t" })).toBe(true);
    expect(debeConsultar({ modo: "sin-institucion" })).toBe(false);
  });
});

describe("conTenant", () => {
  it("sin-acotar ⇒ no agrega ningún .eq", () => {
    const q = fakeBuilder();
    expect(conTenant(q, { modo: "sin-acotar" })).toBe(q);
    expect(q.llamadas).toEqual([]);
  });

  it("institucion ⇒ exactamente un .eq('tenant_id', id)", () => {
    const q = fakeBuilder();
    conTenant(q, { modo: "institucion", tenantId: "t-7" });
    expect(q.llamadas).toEqual([["tenant_id", "t-7"]]);
  });

  it("sin-institucion ⇒ LANZA nombrando debeConsultar (nunca lista todo)", () => {
    const q = fakeBuilder();
    expect(() => conTenant(q, { modo: "sin-institucion" })).toThrow(/debeConsultar/);
    expect(q.llamadas).toEqual([]);
  });

  it("acepta otra columna", () => {
    const q = fakeBuilder();
    conTenant(q, { modo: "institucion", tenantId: "t-2" }, "tenant");
    expect(q.llamadas).toEqual([["tenant", "t-2"]]);
  });
});
