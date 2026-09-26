import { describe, it, expect } from "vitest";
import {
  pendientesPorCorte,
  unirPorNombreDeCorte,
  estadoDeCorte,
  cuentaParaElCorte,
} from "./sin-calificar";
import type { Cut, SubmissionLike } from "@/shared/lib/statistics";

const cut = (id: string, name: string, start?: string, end?: string): Cut =>
  ({ id, name, weight: 30, start_date: start ?? null, end_date: end ?? null }) as unknown as Cut;

const entrega = (over: Partial<SubmissionLike>): SubmissionLike =>
  ({
    id: `s-${over.ref_id ?? "x"}-${over.user_id ?? "u1"}-${over.status ?? "entregado"}`,
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
// Mediodía LOCAL del 25-sep-2026. Construido por componentes y no con un
// literal ISO a propósito: un `...T12:00:00Z` es mediodía UTC, y en un CI con
// otra zona cae en otro día del calendario — exactamente el fallo que este
// repo ya tuvo en `cursos-sin-vocero.test.ts`.
const HOY = new Date(2026, 8, 25, 12, 0, 0).getTime();

describe("pendientesPorCorte", () => {
  it("el denominador son las entregas ESPERADAS, no las existentes", () => {
    // El punto del módulo: con 2 actividades y 10 estudiantes se esperan 20
    // notas aunque solo haya una entrega cargada. Si el denominador fueran las
    // entregas, el corte se vería 100% calificado con media clase sin nota.
    const r = pendientesPorCorte(
      [K1],
      [
        { id: "act1", cut_id: "k1", weight: 10 },
        { id: "act2", cut_id: "k1", weight: 10 },
      ],
      [entrega({ ref_id: "act1", user_id: "u1", final_grade: 4 })],
      10,
    );
    expect(r[0].esperadas).toBe(20);
    expect(r[0].calificadas).toBe(1);
    expect(r[0].pctSinCalificar).toBe(95);
  });

  it("separa lo que le toca al DOCENTE de lo que le toca al ESTUDIANTE", () => {
    // La razón de existir del desglose: «falta el 75%» puede ser una cola de
    // calificación o un curso que no abrió nada, y son dos acciones distintas.
    const r = pendientesPorCorte(
      [K1],
      [{ id: "act1", cut_id: "k1", weight: 10 }],
      [
        entrega({ user_id: "u1", final_grade: 4 }),
        entrega({ user_id: "u2", status: "entregado" }),
        entrega({ user_id: "u3", status: "en_progreso" }),
      ],
      4,
    );
    expect(r[0].calificadas).toBe(1);
    expect(r[0].porCalificar).toBe(1); // u2 entregó y espera nota
    expect(r[0].enCurso).toBe(1); // u3 lo abrió y lo dejó
    expect(r[0].sinEmpezar).toBe(1); // u4 no dejó ni fila
  });

  it("los cuatro estados suman SIEMPRE las esperadas", () => {
    // Invariante: si no suman, el panel muestra un total que no coincide con
    // sus propias barras — el error que nadie mira dos veces.
    const r = pendientesPorCorte(
      [K1],
      [
        { id: "act1", cut_id: "k1", weight: 10 },
        { id: "act2", cut_id: "k1", is_external: true, weight: 10 },
      ],
      [
        entrega({ ref_id: "act1", user_id: "u1", final_grade: 4 }),
        entrega({ ref_id: "act1", user_id: "u2", status: "en_progreso" }),
        entrega({ ref_id: "act2", user_id: "u1", final_grade: 3 }),
      ],
      3,
    );
    const { calificadas, porCalificar, enCurso, sinEmpezar, esperadas } = r[0];
    expect(calificadas + porCalificar + enCurso + sinEmpezar).toBe(esperadas);
  });

  it("una actividad EXTERNA sin nota es trabajo del docente, no del estudiante", () => {
    // En una externa el estudiante no entrega nada: contarlo como «no empezó»
    // sería acusarlo de no hacer algo que nunca tuvo que hacer.
    const r = pendientesPorCorte([K1], [{ id: "act1", cut_id: "k1", is_external: true, weight: 10 }], [], 5);
    expect(r[0].sinEmpezar).toBe(0);
    expect(r[0].porCalificar).toBe(5);
    expect(r[0].estudiantesSinEmpezarNada).toBe(0);
  });

  it("una entrega sin nota NO cuenta como calificada", () => {
    const r = pendientesPorCorte(
      [K1],
      [{ id: "act1", cut_id: "k1", weight: 10 }],
      [entrega({ user_id: "u1" }), entrega({ user_id: "u2", final_grade: 3 })],
      2,
    );
    expect(r[0].calificadas).toBe(1);
    expect(r[0].pctSinCalificar).toBe(50);
  });

  it("ai_revisado es una entrega hecha, no un examen a medias", () => {
    // La lista NEGRA compartida: los estados nuevos nacen del pipeline de
    // calificación, o sea DESPUÉS de entregar. Con lista blanca caerían en
    // «sin empezar» — el bug que dejó 37 entregas reales marcadas como no
    // entregadas.
    const r = pendientesPorCorte(
      [K1],
      [{ id: "act1", cut_id: "k1", weight: 10 }],
      [entrega({ user_id: "u1", status: "ai_revisado" })],
      1,
    );
    expect(r[0].porCalificar).toBe(1);
    expect(r[0].enCurso).toBe(0);
    expect(r[0].sinEmpezar).toBe(0);
  });

  it("un taller con sustentacion pendiente cuenta como SIN calificar", () => {
    // `effectiveGrade` no cae a ai_grade mientras falte la sustentación:
    // tratarla como nota daría por calificado algo que no lo está.
    const r = pendientesPorCorte(
      [K1],
      [{ id: "act1", cut_id: "k1", weight: 10 }],
      [entrega({ requires_defense: true, ai_grade: 4.5, final_grade: null })],
      1,
    );
    expect(r[0].calificadas).toBe(0);
    expect(r[0].porCalificar).toBe(1);
    expect(r[0].pctSinCalificar).toBe(100);
  });

  it("varios intentos del mismo examen cuentan UNA sola vez, y gana el mas avanzado", () => {
    // La nota es una sola aunque haya varias filas; y un intento abandonado no
    // puede degradar a un intento ya calificado.
    const r = pendientesPorCorte(
      [K1],
      [{ id: "act1", cut_id: "k1", weight: 10 }],
      [
        entrega({ ref_id: "act1", user_id: "u1", status: "en_progreso" }),
        entrega({ ref_id: "act1", user_id: "u1", final_grade: 4 }),
      ],
      2,
    );
    expect(r[0].calificadas).toBe(1);
    expect(r[0].enCurso).toBe(0);
    expect(r[0].sinEmpezar).toBe(1);
  });

  it("solo mira las actividades de SU corte", () => {
    const r = pendientesPorCorte(
      [K1, K2],
      [
        { id: "act1", cut_id: "k1", weight: 10 },
        { id: "act2", cut_id: "k2", weight: 10 },
      ],
      [entrega({ ref_id: "act1", final_grade: 4 }), entrega({ ref_id: "act2", final_grade: 4 })],
      1,
    );
    expect(r[0].calificadas).toBe(1);
    expect(r[1].calificadas).toBe(1);
    expect(r[0].esperadas).toBe(1);
  });

  it("una actividad SIN corte no entra en ninguno", () => {
    const r = pendientesPorCorte([K1], [{ id: "act1", cut_id: null, weight: 10 }], [], 5);
    expect(r[0].esperadas).toBe(0);
    expect(r[0].pctSinCalificar).toBeNull();
  });

  it("un corte sin actividades devuelve null, no 100%", () => {
    // «No hay nada que calificar» y «falta todo» son cosas distintas: pintar
    // 100% sobre un corte vacío manda al docente a buscar trabajo inexistente.
    const r = pendientesPorCorte([K1], [], [], 30);
    expect(r[0].pctSinCalificar).toBeNull();
    expect(r[0].actividades).toBe(0);
    expect(r[0].estudiantesSinNingunaNota).toBe(0);
  });

  it("cuenta los estudiantes que no tienen NINGUNA nota del corte", () => {
    const r = pendientesPorCorte(
      [K1],
      [
        { id: "act1", cut_id: "k1", weight: 10 },
        { id: "act2", cut_id: "k1", weight: 10 },
      ],
      [entrega({ ref_id: "act1", user_id: "u1", final_grade: 4 })],
      3,
    );
    expect(r[0].estudiantesSinNingunaNota).toBe(2);
  });

  it("cuenta los estudiantes que no empezaron NADA del corte", () => {
    const r = pendientesPorCorte(
      [K1],
      [{ id: "act1", cut_id: "k1", weight: 10 }],
      [entrega({ user_id: "u1", status: "en_progreso" })],
      4,
    );
    // u1 empezó (aunque no entregó); los otros 3 no aparecieron.
    expect(r[0].estudiantesSinEmpezarNada).toBe(3);
  });

  it("sin estudiantes matriculados no se esperan notas", () => {
    const r = pendientesPorCorte([K1], [{ id: "act1", cut_id: "k1", weight: 10 }], [], 0);
    expect(r[0].esperadas).toBe(0);
    expect(r[0].pctSinCalificar).toBeNull();
  });
});

describe("estadoDeCorte", () => {
  // El caso que motivó el campo: el Corte 3 salía «100% sin calificar» un mes
  // antes de empezar. Cierto, y completamente inútil.
  it("un corte que no ha empezado es futuro", () => {
    expect(estadoDeCorte(cut("k", "Corte 3", "2026-10-27", "2026-11-20"), HOY)).toBe("futuro");
  });
  it("un corte con hoy adentro esta en curso", () => {
    expect(estadoDeCorte(cut("k", "Corte 1", "2026-09-08", "2026-10-05"), HOY)).toBe("en_curso");
  });
  it("el ultimo dia todavia esta en curso", () => {
    expect(estadoDeCorte(cut("k", "Corte 1", "2026-09-08", "2026-09-25"), HOY)).toBe("en_curso");
  });
  it("el primer dia ya esta en curso", () => {
    expect(estadoDeCorte(cut("k", "Corte 1", "2026-09-25", "2026-10-05"), HOY)).toBe("en_curso");
  });
  it("un corte pasado esta terminado", () => {
    expect(estadoDeCorte(cut("k", "Corte 0", "2026-08-01", "2026-09-01"), HOY)).toBe("terminado");
  });
  it("sin fechas no se afirma nada", () => {
    // Inventar un estado a partir de una fecha ausente sería peor que no
    // decirlo: el panel decoloraría un corte que sí tiene trabajo vivo.
    expect(estadoDeCorte(cut("k", "Corte 1"), HOY)).toBe("sin_fechas");
  });
});

describe("unirPorNombreDeCorte", () => {
  it("suma el mismo corte de cursos distintos", () => {
    // Cada curso tiene sus propios `grade_cuts`, pero «Corte 1» es la misma
    // pregunta para el docente.
    const a = pendientesPorCorte([cut("a1", "Corte 1")], [{ id: "x", cut_id: "a1", weight: 10 }], [], 10);
    const b = pendientesPorCorte([cut("b1", "Corte 1")], [{ id: "y", cut_id: "b1", weight: 10 }], [], 5);
    const total = unirPorNombreDeCorte([a, b]);
    expect(total).toHaveLength(1);
    expect(total[0].esperadas).toBe(15);
    expect(total[0].sinEmpezar).toBe(15);
    expect(total[0].pctSinCalificar).toBe(100);
  });

  it("agrupa sin distinguir mayusculas ni espacios de mas", () => {
    const a = pendientesPorCorte([cut("a1", "Corte 1")], [{ id: "x", cut_id: "a1", weight: 10 }], [], 1);
    const b = pendientesPorCorte([cut("b1", " corte 1 ")], [{ id: "y", cut_id: "b1", weight: 10 }], [], 1);
    expect(unirPorNombreDeCorte([a, b])).toHaveLength(1);
  });

  it("ordena numericamente: Corte 10 va despues de Corte 2", () => {
    const mk = (n: string) => pendientesPorCorte([cut(n, n)], [{ id: "x", cut_id: n, weight: 10 }], [], 1);
    const total = unirPorNombreDeCorte([mk("Corte 10"), mk("Corte 2"), mk("Corte 1")]);
    expect(total.map((t) => t.cutName)).toEqual(["Corte 1", "Corte 2", "Corte 10"]);
  });

  it("recalcula el porcentaje sobre el total, no promedia porcentajes", () => {
    // 1 de 1 calificada en un curso y 0 de 99 en otro es 99% sin calificar,
    // no 50%.
    const a = pendientesPorCorte(
      [cut("a1", "Corte 1")],
      [{ id: "x", cut_id: "a1", weight: 10 }],
      [entrega({ ref_id: "x", final_grade: 4 })],
      1,
    );
    const b = pendientesPorCorte([cut("b1", "Corte 1")], [{ id: "y", cut_id: "b1", weight: 10 }], [], 99);
    expect(unirPorNombreDeCorte([a, b])[0].pctSinCalificar).toBe(99);
  });

  it("si a UN curso le queda el corte abierto, el conjunto no esta terminado", () => {
    // Darlo por cerrado escondería trabajo que todavía se puede hacer.
    const a = pendientesPorCorte(
      [cut("a1", "Corte 1", "2026-08-01", "2026-09-01")],
      [{ id: "x", cut_id: "a1", weight: 10 }],
      [],
      1,
      HOY,
    );
    const b = pendientesPorCorte(
      [cut("b1", "Corte 1", "2026-09-08", "2026-10-05")],
      [{ id: "y", cut_id: "b1", weight: 10 }],
      [],
      1,
      HOY,
    );
    expect(a[0].estado).toBe("terminado");
    expect(b[0].estado).toBe("en_curso");
    expect(unirPorNombreDeCorte([a, b])[0].estado).toBe("en_curso");
  });

  it("dos cursos con el corte igual de futuro siguen siendo futuro", () => {
    const mk = (id: string) =>
      pendientesPorCorte(
        [cut(id, "Corte 3", "2026-10-27", "2026-11-20")],
        [{ id: `x${id}`, cut_id: id }],
        [],
        1,
        HOY,
      );
    expect(unirPorNombreDeCorte([mk("a"), mk("b")])[0].estado).toBe("futuro");
  });

  it("sin cursos devuelve vacio", () => {
    expect(unirPorNombreDeCorte([])).toEqual([]);
  });
});

describe("cuentaParaElCorte", () => {
  // La regla que el docente pidió: el panel cuenta SOLO lo que tiene
  // porcentaje asignado.
  it("cuenta una actividad con porcentaje", () => {
    expect(cuentaParaElCorte({ id: "a", cut_id: "k1", weight: 2.4 })).toBe(true);
  });

  it("NO cuenta una actividad con peso 0", () => {
    // En producción los cursos de Introducción tienen 17 talleres «Clase N»
    // con peso 0: contarlos llenaba el panel de notas faltantes sobre
    // actividades que no mueven ninguna nota, y el docente dejaba de mirarlo.
    expect(cuentaParaElCorte({ id: "a", cut_id: "k1", weight: 0 })).toBe(false);
  });

  it("NO cuenta una actividad SIN peso asignado", () => {
    expect(cuentaParaElCorte({ id: "a", cut_id: "k1", weight: null })).toBe(false);
    expect(cuentaParaElCorte({ id: "a", cut_id: "k1" })).toBe(false);
  });

  it("NO cuenta una actividad sin corte", () => {
    expect(cuentaParaElCorte({ id: "a", cut_id: null, weight: 10 })).toBe(false);
  });

  it("NO cuenta un peso que no es un numero", () => {
    expect(cuentaParaElCorte({ id: "a", cut_id: "k1", weight: Number.NaN })).toBe(false);
  });
});

describe("pendientesPorCorte: solo lo que tiene porcentaje", () => {
  it("las actividades sin peso NO inflan el denominador", () => {
    const r = pendientesPorCorte(
      [K1],
      [
        { id: "act1", cut_id: "k1", weight: 10 },
        { id: "act2", cut_id: "k1", weight: 0 },
        { id: "act3", cut_id: "k1", weight: null },
      ],
      [],
      10,
    );
    // Solo act1 cuenta: 1 actividad × 10 estudiantes.
    expect(r[0].actividades).toBe(1);
    expect(r[0].esperadas).toBe(10);
  });

  it("un corte donde NINGUNA actividad tiene peso se comporta como vacio", () => {
    // No es «falta todo»: es «no hay nada que mueva la nota». Pintarlo al 100%
    // mandaría al docente a buscar trabajo que no cambia ninguna nota.
    const r = pendientesPorCorte([K1], [{ id: "act1", cut_id: "k1", weight: 0 }], [], 30);
    expect(r[0].actividades).toBe(0);
    expect(r[0].pctSinCalificar).toBeNull();
  });

  it("una entrega de una actividad SIN peso no se cuenta como calificada", () => {
    // Si se contara, el numerador subiría sobre un denominador que la excluye
    // y el panel podría mostrar más calificadas que esperadas.
    const r = pendientesPorCorte(
      [K1],
      [
        { id: "act1", cut_id: "k1", weight: 10 },
        { id: "act2", cut_id: "k1", weight: 0 },
      ],
      [
        entrega({ ref_id: "act1", user_id: "u1", final_grade: 4 }),
        entrega({ ref_id: "act2", user_id: "u1", final_grade: 4 }),
      ],
      2,
    );
    expect(r[0].esperadas).toBe(2);
    expect(r[0].calificadas).toBe(1);
    expect(r[0].calificadas).toBeLessThanOrEqual(r[0].esperadas);
  });
});
