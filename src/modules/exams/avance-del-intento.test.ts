import { describe, expect, it } from "vitest";
import { avanceDelIntento } from "./avance-del-intento";
import type { QuestionForAnswered } from "./answered";

const preguntas: QuestionForAnswered[] = Array.from({ length: 5 }, (_, i) => ({
  id: `q${i + 1}`,
  type: "abierta",
}));

describe("avanceDelIntento", () => {
  it("cuenta las respondidas sin importar el orden ni la posición", () => {
    // Orden mezclado: el estudiante respondió 4 y volvió a su pregunta 1.
    const a = { q5: "x", q3: "y", q1: "z", q4: "w", __current_idx: 0 };
    const r = avanceDelIntento(preguntas, a, { enCurso: true, mezcla: true });
    expect(r.respondidas).toBe(4);
    expect(r.enBlanco).toBe(1);
    expect(r.posicion).toBe(1);
    expect(r.ordenPropio).toBe(true);
  });

  it("estar adelante no es haber respondido", () => {
    const a = { q1: "x", __current_idx: 4 };
    const r = avanceDelIntento(preguntas, a, { enCurso: true, mezcla: false });
    expect(r.respondidas).toBe(1);
    expect(r.posicion).toBe(5);
    expect(r.ordenPropio).toBe(false);
  });

  it("las claves de metadatos no cuentan como respuestas", () => {
    const a = { __current_idx: 2, __session_id: "s", __warning_events: [], __saved_at: 1 };
    expect(avanceDelIntento(preguntas, a, { enCurso: true, mezcla: true }).respondidas).toBe(0);
  });

  it("sin intento en curso no hay posición", () => {
    const a = { q1: "x", __current_idx: 3 };
    expect(avanceDelIntento(preguntas, a, { enCurso: false, mezcla: true }).posicion).toBeNull();
  });

  it("una posición fuera de rango se acota y una inválida se descarta", () => {
    expect(avanceDelIntento(preguntas, { __current_idx: 99 }, { enCurso: true, mezcla: false }).posicion).toBe(5);
    expect(avanceDelIntento(preguntas, { __current_idx: -1 }, { enCurso: true, mezcla: false }).posicion).toBeNull();
    expect(avanceDelIntento(preguntas, { __current_idx: "3" }, { enCurso: true, mezcla: false }).posicion).toBeNull();
    expect(avanceDelIntento(preguntas, null, { enCurso: true, mezcla: false })).toMatchObject({
      respondidas: 0,
      enBlanco: 5,
      posicion: null,
    });
  });

  it("una pregunta de código con la plantilla intacta no cuenta como respondida", () => {
    const qs: QuestionForAnswered[] = [{ id: "c1", type: "codigo", starter_code: "class A {}" }];
    expect(avanceDelIntento(qs, { c1: "class A {}" }, { enCurso: true, mezcla: false }).respondidas).toBe(0);
    expect(avanceDelIntento(qs, { c1: "class A { int x; }" }, { enCurso: true, mezcla: false }).respondidas).toBe(1);
  });
});
