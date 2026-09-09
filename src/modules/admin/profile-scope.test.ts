import { describe, expect, it } from "vitest";

import {
  PROFILE_STATE_COLUMNS,
  conPerfilOfrecible,
  seLePuedeOfrecer,
  soloOfrecibles,
} from "./profile-scope";

describe("seLePuedeOfrecer", () => {
  it("una cuenta ELIMINADA no se ofrece (el bug reportado)", () => {
    // Caso real: la cuenta que el usuario borró desde el panel y seguía
    // apareciendo en el diálogo de matricular. Ojo que `is_active` es false y
    // `estado` sigue en "activo": el borrado no toca `estado`.
    expect(
      seLePuedeOfrecer({ deleted_at: "2026-09-09T03:17:43.451+00:00", is_active: false }),
    ).toBe(false);
  });

  it("una cuenta DESACTIVADA no se ofrece, aunque no esté eliminada", () => {
    expect(seLePuedeOfrecer({ deleted_at: null, is_active: false })).toBe(false);
  });

  it("eliminada cuenta como no ofrecible aunque `is_active` siga en true", () => {
    // Un UPDATE a mano o un flujo futuro podría poner `deleted_at` sin bajar
    // `is_active`. El predicado no puede depender de que los dos vayan juntos.
    expect(seLePuedeOfrecer({ deleted_at: "2026-01-01T00:00:00Z", is_active: true })).toBe(false);
  });

  it("`is_active` NULL es ACTIVA — es la mayoría de la base", () => {
    // 325 de 566 perfiles de producción tienen `is_active` en NULL (filas
    // anteriores a la migración que agregó la columna). Si el nulo contara como
    // inactivo, este predicado vaciaría todos los pickers de la plataforma.
    expect(seLePuedeOfrecer({ deleted_at: null, is_active: null })).toBe(true);
  });

  it("un objeto SIN las columnas de estado cuenta como activa", () => {
    // Falla hacia el comportamiento de hoy (ofrecer de más) en vez de vaciarle
    // la lista a alguien que se olvidó de pedir las columnas en el select.
    expect(seLePuedeOfrecer({})).toBe(true);
  });

  it("una cuenta activa se ofrece", () => {
    expect(seLePuedeOfrecer({ deleted_at: null, is_active: true })).toBe(true);
  });

  it("nada no se ofrece", () => {
    expect(seLePuedeOfrecer(null)).toBe(false);
    expect(seLePuedeOfrecer(undefined)).toBe(false);
  });
});

describe("soloOfrecibles", () => {
  it("saca las eliminadas y las desactivadas, y conserva el orden", () => {
    const filas = [
      { id: "a", deleted_at: null, is_active: true },
      { id: "b", deleted_at: "2026-09-09T03:17:43Z", is_active: false }, // eliminada
      { id: "c", deleted_at: null, is_active: null }, // nula = activa
      { id: "d", deleted_at: null, is_active: false }, // desactivada
      { id: "e", deleted_at: null, is_active: true },
    ];
    expect(soloOfrecibles(filas).map((f) => f.id)).toEqual(["a", "c", "e"]);
  });

  it("una lista vacía queda vacía (no devuelve todo)", () => {
    expect(soloOfrecibles([])).toEqual([]);
  });
});

describe("conPerfilOfrecible", () => {
  it("agrega el IS NULL de eliminadas y el IS NOT FALSE de desactivadas", () => {
    const llamadas: string[] = [];
    const q = {
      is(col: string, val: null) {
        llamadas.push(`is(${col},${String(val)})`);
        return q;
      },
      not(col: string, op: string, val: boolean) {
        llamadas.push(`not(${col},${op},${String(val)})`);
        return q;
      },
    };
    conPerfilOfrecible(q);
    expect(llamadas).toEqual(["is(deleted_at,null)", "not(is_active,is,false)"]);
  });

  it("NO usa `.eq(is_active, true)` — eso dejaría fuera a la mitad de la base", () => {
    // Es el error más caro posible acá: 325 de 566 perfiles de producción tienen
    // `is_active` en NULL, así que `= true` los excluye a todos. `IS NOT FALSE`
    // los deja pasar.
    const llamadas: string[] = [];
    const q = {
      is: () => q,
      not(col: string, op: string, val: boolean) {
        llamadas.push(`${col} IS NOT ${String(val).toUpperCase()}`);
        return q;
      },
      eq: () => {
        throw new Error("conPerfilOfrecible no debe usar eq(): excluye el NULL");
      },
    };
    conPerfilOfrecible(q as never);
    expect(llamadas).toEqual(["is_active IS NOT FALSE"]);
  });

  it("no gasta el `.or(...)` de la consulta (PostgREST admite uno solo)", () => {
    // El buscador global ya usa su `or` para nombre-o-correo. Si este helper
    // usara otro, ahí no se podría encadenar.
    let usoOr = false;
    const q = {
      is: () => q,
      not: () => q,
      or: () => {
        usoOr = true;
        return q;
      },
    };
    conPerfilOfrecible(q as never);
    expect(usoOr).toBe(false);
  });
});

describe("PROFILE_STATE_COLUMNS", () => {
  it("nombra las dos columnas que el predicado mira", () => {
    // Si el predicado empezara a mirar otra columna y esta constante no la
    // trajera, el filtro del cliente pasaría a ser un no-op silencioso.
    expect(PROFILE_STATE_COLUMNS).toContain("deleted_at");
    expect(PROFILE_STATE_COLUMNS).toContain("is_active");
  });
});
