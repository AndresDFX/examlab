// Pruebas de la consolidación de la nota de cabecera de un taller.
//
// Importan el módulo del EDGE por ruta relativa a propósito (mismo patrón que
// `identify-questions.test.ts`): es un import real, no una copia, así que si la
// fórmula cambia estas pruebas lo ven.
//
// Por qué importa cubrirlo: esta fórmula es la que decide la nota que el alumno
// ve y la que el gradebook lee, y hasta el 2026-09-07 la calculaba el NAVEGADOR
// del alumno — el candado de la base lo rechazaba y ninguna entrega de taller se
// podía cerrar. Ahora la calcula el servidor, o sea que un error acá se le
// escribe a todos los estudiantes sin que nadie lo teclee.
import { describe, expect, it } from "vitest";
import {
  ESCALA_POR_DEFECTO,
  consolidarNotaTaller,
  escalaDeTaller,
  patchCabeceraTaller,
} from "./workshop-grading.ts";

const q = (id: string, points: number | null, type = "abierta") => ({ id, type, points });

describe("escalaDeTaller", () => {
  it("usa max_score cuando es positivo", () => {
    expect(escalaDeTaller(5)).toBe(5);
    expect(escalaDeTaller(100)).toBe(100);
  });

  it("cae a 100 con null, 0 o negativo — igual que el COALESCE(_max, 100) del trigger SQL", () => {
    expect(escalaDeTaller(null)).toBe(ESCALA_POR_DEFECTO);
    expect(escalaDeTaller(undefined)).toBe(ESCALA_POR_DEFECTO);
    expect(escalaDeTaller(0)).toBe(ESCALA_POR_DEFECTO);
    expect(escalaDeTaller(-3)).toBe(ESCALA_POR_DEFECTO);
  });
});

describe("consolidarNotaTaller", () => {
  it("todo bien calificado da la escala completa", () => {
    const r = consolidarNotaTaller({
      questions: [q("a", 1), q("b", 1), q("c", 1), q("d", 1)],
      notasPorPregunta: new Map([
        ["a", 1],
        ["b", 1],
        ["c", 1],
        ["d", 1],
      ]),
      maxScore: 5,
    });
    expect(r.totalPoints).toBe(4);
    expect(r.totalEarned).toBe(4);
    expect(r.finalGrade).toBe(5);
    expect(r.calificadas).toBe(4);
    expect(r.faltanIA).toBe(0);
  });

  it("las preguntas SIN nota cuentan 0, no se reescala sobre las calificadas", () => {
    // 2 de 4 en 1: si se reescalara sobre lo calificado daría 5; la regla del
    // repo es que lo que no tiene nota es nota perdida.
    const r = consolidarNotaTaller({
      questions: [q("a", 1), q("b", 1), q("c", 1), q("d", 1)],
      notasPorPregunta: new Map([
        ["a", 1],
        ["b", 1],
      ]),
      maxScore: 5,
    });
    expect(r.finalGrade).toBe(2.5);
    expect(r.calificadas).toBe(2);
  });

  it("una nota mayor que los puntos de la pregunta se topa, y una negativa se piso a 0", () => {
    const r = consolidarNotaTaller({
      questions: [q("a", 2), q("b", 2)],
      notasPorPregunta: new Map([
        ["a", 999],
        ["b", -5],
      ]),
      maxScore: 10,
    });
    expect(r.totalEarned).toBe(2); // 2 (topado) + 0 (pisado)
    expect(r.finalGrade).toBe(5);
  });

  it("una cerrada sin nota NO bloquea el cierre; una abierta sin nota SI", () => {
    const cerradas = consolidarNotaTaller({
      questions: [q("a", 1, "cerrada"), q("b", 1, "cerrada_multi")],
      notasPorPregunta: new Map(),
      maxScore: 5,
    });
    expect(cerradas.faltanIA).toBe(0);

    const abierta = consolidarNotaTaller({
      questions: [q("a", 1, "cerrada"), q("b", 1, "abierta")],
      notasPorPregunta: new Map([["a", 1]]),
      maxScore: 5,
    });
    expect(abierta.faltanIA).toBe(1);
  });

  it("un taller sin puntos no divide por cero", () => {
    const r = consolidarNotaTaller({
      questions: [q("a", 0), q("b", null)],
      notasPorPregunta: new Map([["a", 0]]),
      maxScore: 5,
    });
    expect(r.totalPoints).toBe(0);
    expect(r.finalGrade).toBe(0);
  });
});

describe("patchCabeceraTaller", () => {
  const base = {
    finalGrade: 4,
    calificadas: 3,
    total: 3,
    statusActual: "entregado" as string | null,
    aiGradeActual: null as number | null,
    finalGradeActual: null as number | null,
    lang: "es" as const,
  };

  it("con preguntas pendientes de IA refresca solo la nota de IA, sin cerrar", () => {
    const p = patchCabeceraTaller({ ...base, faltanIA: 1 });
    expect(p.ai_grade).toBe(4);
    expect(p.ai_feedback).toContain("La IA calificó");
    expect(p).not.toHaveProperty("final_grade");
    expect(p).not.toHaveProperty("status");
  });

  it("sin pendientes cierra la entrega y pone la nota final", () => {
    const p = patchCabeceraTaller({ ...base, faltanIA: 0 });
    expect(p.final_grade).toBe(4);
    expect(p.status).toBe("calificado");
  });

  it("NO pisa la nota que el docente puso a mano", () => {
    // El docente dejó 5 sobre una nota de IA previa de 3: su decisión manda.
    const p = patchCabeceraTaller({
      ...base,
      faltanIA: 0,
      aiGradeActual: 3,
      finalGradeActual: 5,
    });
    expect(p.final_grade).toBe(5);
  });

  it("SI refresca una nota que venía puesta automáticamente", () => {
    // final_grade == ai_grade previo ⇒ nadie la tocó a mano.
    const p = patchCabeceraTaller({
      ...base,
      faltanIA: 0,
      aiGradeActual: 3,
      finalGradeActual: 3,
    });
    expect(p.final_grade).toBe(4);
  });

  it("no degrada una decisión humana ni una marca de revisión", () => {
    for (const estado of ["calificado", "requiere_revision", "sospechoso"]) {
      const p = patchCabeceraTaller({ ...base, faltanIA: 0, statusActual: estado });
      expect(p).not.toHaveProperty("status");
    }
  });

  it("el resumen respeta el idioma del curso", () => {
    const en = patchCabeceraTaller({ ...base, faltanIA: 0, lang: "en" });
    expect(en.ai_feedback).toBe("AI graded 3 of 3 question(s).");
  });
});
