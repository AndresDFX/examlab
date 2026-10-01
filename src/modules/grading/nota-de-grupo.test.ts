import { describe, expect, it } from "vitest";

import {
  borradorInicialDeGrupo,
  conflictosAlCalificarGrupo,
  entregaEsDelGrupo,
  integrantesPorEntrega,
  nombresDeIntegrantes,
  planDeNotaDeGrupo,
  resumenDeGrupo,
  seccionesPorGrupo,
  unaVezPorEntrega,
  valorComun,
  type FilaDeNotaConGrupo,
} from "./nota-de-grupo";

const fila = (
  userId: string,
  fullName: string,
  grupo: [string, string] | null,
  originalGrade: number | null = null,
  extra: Partial<FilaDeNotaConGrupo> = {},
): FilaDeNotaConGrupo => ({
  userId,
  fullName,
  grupoId: grupo?.[0] ?? null,
  grupoNombre: grupo?.[1] ?? null,
  grade: originalGrade,
  feedback: "",
  originalGrade,
  originalFeedback: "",
  ...extra,
});

const g2: [string, string] = ["g2", "Grupo 2"];
const g10: [string, string] = ["g10", "Grupo 10"];

describe("seccionesPorGrupo", () => {
  it("agrupa, ordena «Grupo 2» antes que «Grupo 10» y deja aparte a los sin grupo", () => {
    const r = seccionesPorGrupo([
      fila("z", "Zoe", g10),
      fila("b", "Beto", g2),
      fila("a", "Ana", g2),
      fila("x", "Ximena", null),
      fila("c", "Carlos", null),
    ]);
    expect(r.grupos.map((s) => s.nombre)).toEqual(["Grupo 2", "Grupo 10"]);
    expect(r.grupos[0].filas.map((f) => f.fullName)).toEqual(["Ana", "Beto"]);
    expect(r.sinGrupo.map((f) => f.fullName)).toEqual(["Carlos", "Ximena"]);
  });

  it("sin grupos, todo queda en «sin grupo»", () => {
    const r = seccionesPorGrupo([fila("a", "Ana", null)]);
    expect(r.grupos).toEqual([]);
    expect(r.sinGrupo).toHaveLength(1);
  });
});

describe("valorComun", () => {
  it("el valor de todos, o null si difieren o no hay", () => {
    expect(valorComun([4.5, 4.5])).toBe(4.5);
    expect(valorComun([4.5, 3])).toBeNull();
    expect(valorComun([4.5, null])).toBeNull();
    expect(valorComun([])).toBeNull();
  });
});

describe("resumenDeGrupo / borradorInicialDeGrupo", () => {
  it("cuenta lo GUARDADO y detecta notas distintas", () => {
    const filas = [fila("a", "Ana", g2, 4), fila("b", "Beto", g2, 3), fila("c", "Caro", g2)];
    expect(resumenDeGrupo(filas)).toEqual({ total: 3, conNota: 2, distintas: true });
    expect(borradorInicialDeGrupo(filas)).toEqual({ grade: null, feedback: "" });
  });

  it("si todos comparten nota y observación, el grupo arranca con ellas", () => {
    const filas = [
      fila("a", "Ana", g2, 4.5, { originalFeedback: "Buena exposición " }),
      fila("b", "Beto", g2, 4.5, { originalFeedback: "Buena exposición" }),
    ];
    expect(resumenDeGrupo(filas).distintas).toBe(false);
    expect(borradorInicialDeGrupo(filas)).toEqual({ grade: 4.5, feedback: "Buena exposición" });
  });
});

describe("conflictosAlCalificarGrupo", () => {
  it("lista a quien ya tiene OTRA nota, vista o guardada", () => {
    const filas = [
      fila("a", "Ana", g2, 4.5),
      fila("b", "Beto", g2, 3),
      fila("c", "Caro", g2), // sin nota
      fila("d", "Dani", g2, 2, { grade: 4.5 }), // ya escribió 4,5 sin guardar
      fila("e", "Eva", g2, 4.5, { grade: null }), // la vació: manda lo guardado
    ];
    expect(conflictosAlCalificarGrupo(filas, 4.5).map((c) => [c.fila.userId, c.nota])).toEqual([
      ["b", 3],
    ]);
  });
});

describe("planDeNotaDeGrupo", () => {
  const filas = [fila("a", "Ana", g2, null, { feedback: "Llegó tarde" }), fila("b", "Beto", g2)];

  it("la misma nota para todos; la observación del grupo reemplaza solo si se escribió", () => {
    expect(
      planDeNotaDeGrupo(filas, { grade: 4, feedback: "  " }).map((p) => [
        p.fila.userId,
        p.grade,
        p.feedback,
      ]),
    ).toEqual([
      ["a", 4, "Llegó tarde"],
      ["b", 4, ""],
    ]);
    expect(
      planDeNotaDeGrupo(filas, { grade: 4, feedback: "Muy clara" }).map((p) => p.feedback),
    ).toEqual(["Muy clara", "Muy clara"]);
  });

  it("sin nota no hay plan (no se borran las notas del grupo)", () => {
    expect(planDeNotaDeGrupo(filas, { grade: null, feedback: "x" })).toEqual([]);
    expect(planDeNotaDeGrupo(filas, { grade: Number.NaN, feedback: "" })).toEqual([]);
  });
});

describe("integrantesPorEntrega", () => {
  it("una entrega de grupo la comparten sus integrantes; la individual no aparece", () => {
    const grupos = new Map([
      ["ana", new Set(["g2"])],
      ["beto", new Set(["g2"])],
      ["caro", new Set(["g10"])],
    ]);
    const r = integrantesPorEntrega(
      [
        { id: "s-grupo", group_id: "g2" },
        { id: "s-indiv", group_id: null },
        { id: "s-otro", group_id: "g99" },
      ],
      grupos,
      ["ana", "beto", "caro", "dani"],
    );
    expect(r.get("s-grupo")).toEqual(["ana", "beto"]);
    expect(r.has("s-indiv")).toBe(false);
    expect(r.has("s-otro")).toBe(false);
  });

  it("solo cuenta a los estudiantes de la lista", () => {
    const grupos = new Map([
      ["ana", new Set(["g2"])],
      ["fuera", new Set(["g2"])],
    ]);
    expect(integrantesPorEntrega([{ id: "s", group_id: "g2" }], grupos, ["ana"]).get("s")).toEqual([
      "ana",
    ]);
  });
});

describe("entregaEsDelGrupo", () => {
  it("solo en una actividad EN LÍNEA con trabajo en grupo", () => {
    expect(entregaEsDelGrupo({ group_mode: "teacher_assigned" })).toBe(true);
    expect(entregaEsDelGrupo({ group_mode: "group_required", is_external: false })).toBe(true);
    expect(entregaEsDelGrupo({ group_mode: "individual" })).toBe(false);
    expect(entregaEsDelGrupo({ group_mode: null })).toBe(false);
  });

  it("en una EXTERNA la nota es la fila de cada integrante, aunque tenga grupos", () => {
    expect(entregaEsDelGrupo({ group_mode: "teacher_assigned", is_external: true })).toBe(false);
  });
});

describe("nombresDeIntegrantes", () => {
  it("en orden alfabético; sin perfil, una raya", () => {
    const perfiles = new Map([
      ["b", { full_name: "Beto Ruiz" }],
      ["a", { full_name: " Ana Pérez " }],
    ]);
    expect(nombresDeIntegrantes(["b", "x", "a"], perfiles)).toEqual([
      "Ana Pérez",
      "Beto Ruiz",
      "—",
    ]);
  });
});

describe("unaVezPorEntrega", () => {
  it("deja la última edición de cada entrega y todas las sin entrega", () => {
    const entradas = [
      { k: "ana", sub: "s1", v: 4 },
      { k: "beto", sub: "s1", v: 4 },
      { k: "caro", sub: null, v: 3 },
      { k: "dani", sub: "s2", v: 5 },
      { k: "eva", sub: null, v: 2 },
    ];
    expect(unaVezPorEntrega(entradas, (e) => e.sub).map((e) => e.k)).toEqual([
      "beto",
      "caro",
      "dani",
      "eva",
    ]);
  });
});
