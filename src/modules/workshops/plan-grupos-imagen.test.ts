import { describe, expect, it } from "vitest";

import {
  construirPlan,
  validarFila,
  type ContextoPlan,
  type FilaAsignacion,
} from "./plan-grupos-imagen";

const ctx = (over: Partial<ContextoPlan> = {}): ContextoPlan => ({
  grupos: [],
  miembroPorUsuario: new Map(),
  gruposConEntrega: new Set(),
  conEntregaIndividual: new Set(),
  nombrePorUsuario: new Map([
    ["u1", "Reyes Mompotes Jean Paul"],
    ["u2", "Velandia Muñoz Ana Maria"],
    ["u3", "Velasco Velasco David"],
  ]),
  groupSizeMin: 3,
  groupSizeMax: 8,
  ...over,
});

const fila = (id: string, etiqueta: string, user_id: string | null): FilaAsignacion => ({
  id,
  leido: `leido-${id}`,
  etiqueta,
  user_id,
});

describe("validarFila", () => {
  it("sin estudiante elegido no se puede aplicar", () => {
    expect(validarFila(fila("f1", "Sala 1", null), ctx())).toBe("sin_estudiante");
  });

  it("quien ya entregó por su cuenta queda bloqueado", () => {
    // El trigger tg_block_ws_group_member_with_individual lo rechazaría con P0001 y
    // se caería el INSERT del lote completo.
    const c = ctx({ conEntregaIndividual: new Set(["u1"]) });
    expect(validarFila(fila("f1", "Sala 1", "u1"), c)).toBe("entrega_individual");
  });

  it("no se saca a nadie de un grupo que YA entregó", () => {
    const c = ctx({
      grupos: [{ id: "g1", name: "Sala 1" }],
      miembroPorUsuario: new Map([["u1", "g1"]]),
      gruposConEntrega: new Set(["g1"]),
    });
    expect(validarFila(fila("f1", "Sala 2", "u1"), c)).toBe("grupo_con_entrega");
  });

  it("tampoco se mete a nadie EN un grupo que ya entregó", () => {
    const c = ctx({
      grupos: [{ id: "g2", name: "Sala 2" }],
      gruposConEntrega: new Set(["g2"]),
    });
    expect(validarFila(fila("f1", "Sala 2", "u1"), c)).toBe("grupo_con_entrega");
  });

  it("una fila normal pasa", () => {
    expect(validarFila(fila("f1", "Sala 1", "u1"), ctx())).toBeNull();
  });
});

describe("construirPlan", () => {
  it("crea los grupos que no existen y asigna a cada quien", () => {
    const p = construirPlan(
      [fila("f1", "Sala 1", "u1"), fila("f2", "Sala 1", "u2"), fila("f3", "Sala 2", "u3")],
      ctx(),
    );
    expect(p.gruposACrear.map((g) => g.etiqueta)).toEqual(["Sala 1", "Sala 2"]);
    expect(p.gruposAReusar).toEqual([]);
    expect(p.membresiasAInsertar).toHaveLength(3);
    expect(p.membresiasABorrar).toEqual([]);
    expect(p.resumen).toEqual({ personas: 3, grupos: 2, bloqueadas: 0 });
  });

  it("REUSA el grupo que ya existe, aunque la capitalización difiera", () => {
    // El índice de nombre es case-insensitive: crear "sala 1" junto a "Sala 1" falla,
    // y crearlo con otro nombre le esconde al docente que ya tenía ese grupo.
    const p = construirPlan([fila("f1", "sala 1", "u1")], ctx({ grupos: [{ id: "g1", name: "Sala 1" }] }));
    expect(p.gruposACrear).toEqual([]);
    expect(p.gruposAReusar).toEqual([{ etiqueta: "sala 1", groupId: "g1" }]);
  });

  it("borra la membresía previa ANTES de insertar cuando alguien cambia de grupo", () => {
    const c = ctx({
      grupos: [{ id: "g1", name: "Sala 1" }],
      miembroPorUsuario: new Map([["u1", "g1"]]),
    });
    const p = construirPlan([fila("f1", "Sala 2", "u1")], c);
    expect(p.membresiasABorrar).toEqual([{ groupId: "g1", userId: "u1" }]);
    expect(p.membresiasAInsertar).toEqual([{ etiqueta: "Sala 2", userId: "u1" }]);
  });

  it("a quien ya está donde va no se le toca nada", () => {
    // Sin esto, aplicar dos veces la misma captura borra e inserta 30 filas por gusto.
    const c = ctx({
      grupos: [{ id: "g1", name: "Sala 1" }],
      miembroPorUsuario: new Map([["u1", "g1"]]),
    });
    const p = construirPlan([fila("f1", "Sala 1", "u1")], c);
    expect(p.membresiasABorrar).toEqual([]);
    expect(p.membresiasAInsertar).toEqual([]);
    expect(p.resumen.personas).toBe(0);
  });

  it("la misma persona en dos grupos: gana la primera y la otra se bloquea", () => {
    const p = construirPlan([fila("f1", "Sala 1", "u1"), fila("f2", "Sala 2", "u1")], ctx());
    expect(p.membresiasAInsertar).toEqual([{ etiqueta: "Sala 1", userId: "u1" }]);
    expect(p.bloqueadas).toHaveLength(1);
    expect(p.bloqueadas[0].motivo).toBe("repetido_en_el_plan");
    expect(p.bloqueadas[0].nombre).toBe("Reyes Mompotes Jean Paul");
  });

  it("las descartadas por el docente no cuentan ni bloquean", () => {
    const p = construirPlan(
      [{ ...fila("f1", "Sala 1", null), descartada: true }, fila("f2", "Sala 1", "u1")],
      ctx(),
    );
    expect(p.bloqueadas).toEqual([]);
    expect(p.resumen.personas).toBe(1);
  });

  it("las bloqueadas traen el nombre para poder decir a quién le pasa", () => {
    const c = ctx({ conEntregaIndividual: new Set(["u2"]) });
    const p = construirPlan([fila("f1", "Sala 1", "u2")], c);
    expect(p.bloqueadas[0]).toMatchObject({
      motivo: "entrega_individual",
      nombre: "Velandia Muñoz Ana Maria",
    });
    expect(p.membresiasAInsertar).toEqual([]);
  });

  it("avisa del tamaño sin bloquear", () => {
    // min=3: un grupo de 1 se avisa, pero el docente manda.
    const p = construirPlan([fila("f1", "Sala 1", "u1")], ctx());
    expect(p.avisosDeTamano).toEqual([{ nombre: "Sala 1", integrantes: 1, motivo: "min" }]);
    expect(p.membresiasAInsertar).toHaveLength(1);
  });

  it("cuenta a los que se QUEDAN en un grupo reusado para el aviso de tamaño", () => {
    // u2 y u3 ya están en Sala 1 y no se mueven; entra u1. El grupo queda en 3, que
    // cumple el mínimo: si solo se contaran los que entran, avisaría de menos.
    const c = ctx({
      grupos: [{ id: "g1", name: "Sala 1" }],
      miembroPorUsuario: new Map([
        ["u2", "g1"],
        ["u3", "g1"],
      ]),
    });
    const p = construirPlan([fila("f1", "Sala 1", "u1")], c);
    expect(p.avisosDeTamano).toEqual([]);
  });

  it("plan vacío cuando no hay nada válido", () => {
    const p = construirPlan([fila("f1", "Sala 1", null), fila("f2", "Sala 2", null)], ctx());
    expect(p.membresiasAInsertar).toEqual([]);
    expect(p.gruposACrear).toEqual([]);
    expect(p.resumen).toEqual({ personas: 0, grupos: 0, bloqueadas: 2 });
  });

  it("una etiqueta vacía recibe un nombre libre que no choca con los existentes", () => {
    const p = construirPlan([fila("f1", "", "u1")], ctx({ grupos: [{ id: "g1", name: "Grupo 1" }] }));
    expect(p.gruposACrear).toHaveLength(1);
    expect(p.gruposACrear[0].nombre.toLowerCase()).not.toBe("grupo 1");
  });
});
