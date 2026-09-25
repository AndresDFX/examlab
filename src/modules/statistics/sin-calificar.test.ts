import { describe, it, expect } from "vitest";
import { pendientesPorCorte, unirPorNombreDeCorte } from "./sin-calificar";
import type { Cut, SubmissionLike } from "@/shared/lib/statistics";

const cut = (id: string, name: string): Cut =>
  ({ id, name, weight: 30 }) as unknown as Cut;

const entrega = (over: Partial<SubmissionLike>): SubmissionLike =>
  ({
    id: `s-${Math.random()}`,
    user_id: "u1",
    status: "entregado",
    ai_grade: null,
    final_grade: null,
    ai_detected: null,
    ai_detected_score: null,
    ref_id: "act1",
    course_id: "c1",
    cut_id: "k1",
    max_score: 5,
    is_external: false,
    ...over,
  }) as SubmissionLike;

const K1 = cut("k1", "Corte 1");
const K2 = cut("k2", "Corte 2");

describe("pendientesPorCorte", () => {
  it("el denominador son las entregas ESPERADAS, no las existentes", () => {
    // El punto del módulo: con 2 actividades y 10 estudiantes se esperan 20
    // notas aunque solo haya una entrega cargada. Si el denominador fueran las
    // entregas, el corte se vería 100% calificado con media clase sin nota.
    const r = pendientesPorCorte(
      [K1],
      [
        { id: "act1", cut_id: "k1" },
        { id: "act2", cut_id: "k1" },
      ],
      [entrega({ ref_id: "act1", user_id: "u1", final_grade: 4 })],
      10,
    );
    expect(r[0].esperadas).toBe(20);
    expect(r[0].calificadas).toBe(1);
    expect(r[0].pctSinCalificar).toBe(95);
  });

  it("una entrega sin nota NO cuenta como calificada", () => {
    const r = pendientesPorCorte(
      [K1],
      [{ id: "act1", cut_id: "k1" }],
      [entrega({ user_id: "u1" }), entrega({ user_id: "u2", final_grade: 3 })],
      2,
    );
    expect(r[0].calificadas).toBe(1);
    expect(r[0].pctSinCalificar).toBe(50);
  });

  it("un taller con sustentacion pendiente cuenta como SIN calificar", () => {
    // `effectiveGrade` no cae a ai_grade mientras falte la sustentación:
    // tratarla como nota daría por calificado algo que no lo está.
    const r = pendientesPorCorte(
      [K1],
      [{ id: "act1", cut_id: "k1" }],
      [entrega({ requires_defense: true, ai_grade: 4.5, final_grade: null })],
      1,
    );
    expect(r[0].calificadas).toBe(0);
    expect(r[0].pctSinCalificar).toBe(100);
  });

  it("varios intentos del mismo examen cuentan UNA sola vez", () => {
    // La nota es una sola aunque haya varias filas.
    const r = pendientesPorCorte(
      [K1],
      [{ id: "act1", cut_id: "k1" }],
      [
        entrega({ ref_id: "act1", user_id: "u1", final_grade: 3 }),
        entrega({ ref_id: "act1", user_id: "u1", final_grade: 4 }),
      ],
      2,
    );
    expect(r[0].calificadas).toBe(1);
  });

  it("solo mira las actividades de SU corte", () => {
    const r = pendientesPorCorte(
      [K1, K2],
      [
        { id: "act1", cut_id: "k1" },
        { id: "act2", cut_id: "k2" },
      ],
      [
        entrega({ ref_id: "act1", final_grade: 4 }),
        entrega({ ref_id: "act2", final_grade: 4 }),
      ],
      1,
    );
    expect(r[0].calificadas).toBe(1);
    expect(r[1].calificadas).toBe(1);
    expect(r[0].esperadas).toBe(1);
  });

  it("una actividad SIN corte no entra en ninguno", () => {
    const r = pendientesPorCorte([K1], [{ id: "act1", cut_id: null }], [], 5);
    expect(r[0].esperadas).toBe(0);
    expect(r[0].pctSinCalificar).toBeNull();
  });

  it("un corte sin actividades devuelve null, no 100%", () => {
    // «No hay nada que calificar» y «falta todo» son cosas distintas: pintar
    // 100% sobre un corte vacío manda al docente a buscar trabajo inexistente.
    const r = pendientesPorCorte([K1], [], [], 30);
    expect(r[0].pctSinCalificar).toBeNull();
    expect(r[0].estudiantesSinNingunaNota).toBe(0);
  });

  it("cuenta los estudiantes que no tienen NINGUNA nota del corte", () => {
    const r = pendientesPorCorte(
      [K1],
      [
        { id: "act1", cut_id: "k1" },
        { id: "act2", cut_id: "k1" },
      ],
      [entrega({ ref_id: "act1", user_id: "u1", final_grade: 4 })],
      3,
    );
    expect(r[0].estudiantesSinNingunaNota).toBe(2);
  });

  it("sin estudiantes matriculados no se esperan notas", () => {
    const r = pendientesPorCorte([K1], [{ id: "act1", cut_id: "k1" }], [], 0);
    expect(r[0].esperadas).toBe(0);
    expect(r[0].pctSinCalificar).toBeNull();
  });
});

describe("unirPorNombreDeCorte", () => {
  it("suma el mismo corte de cursos distintos", () => {
    // Cada curso tiene sus propios `grade_cuts`, pero «Corte 1» es la misma
    // pregunta para el docente.
    const a = pendientesPorCorte([cut("a1", "Corte 1")], [{ id: "x", cut_id: "a1" }], [], 10);
    const b = pendientesPorCorte([cut("b1", "Corte 1")], [{ id: "y", cut_id: "b1" }], [], 5);
    const total = unirPorNombreDeCorte([a, b]);
    expect(total).toHaveLength(1);
    expect(total[0].esperadas).toBe(15);
    expect(total[0].pctSinCalificar).toBe(100);
  });

  it("agrupa sin distinguir mayusculas ni espacios de mas", () => {
    const a = pendientesPorCorte([cut("a1", "Corte 1")], [{ id: "x", cut_id: "a1" }], [], 1);
    const b = pendientesPorCorte([cut("b1", " corte 1 ")], [{ id: "y", cut_id: "b1" }], [], 1);
    expect(unirPorNombreDeCorte([a, b])).toHaveLength(1);
  });

  it("ordena numericamente: Corte 10 va despues de Corte 2", () => {
    const mk = (n: string) => pendientesPorCorte([cut(n, n)], [{ id: "x", cut_id: n }], [], 1);
    const total = unirPorNombreDeCorte([mk("Corte 10"), mk("Corte 2"), mk("Corte 1")]);
    expect(total.map((t) => t.cutName)).toEqual(["Corte 1", "Corte 2", "Corte 10"]);
  });

  it("recalcula el porcentaje sobre el total, no promedia porcentajes", () => {
    // 1 de 1 calificada en un curso y 0 de 99 en otro es 99% sin calificar,
    // no 50%.
    const a = pendientesPorCorte(
      [cut("a1", "Corte 1")],
      [{ id: "x", cut_id: "a1" }],
      [entrega({ ref_id: "x", final_grade: 4 })],
      1,
    );
    const b = pendientesPorCorte([cut("b1", "Corte 1")], [{ id: "y", cut_id: "b1" }], [], 99);
    expect(unirPorNombreDeCorte([a, b])[0].pctSinCalificar).toBe(99);
  });

  it("sin cursos devuelve vacio", () => {
    expect(unirPorNombreDeCorte([])).toEqual([]);
  });
});
