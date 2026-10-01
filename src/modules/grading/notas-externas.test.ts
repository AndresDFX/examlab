import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { filaDeNotaExterna } from "./notas-externas";

// Las filas son las MISMAS que escribía «Notas externas» antes de compartir la
// escritura con la ventana de grupos: si cambian, cambia lo que ve el libro de
// notas (el estado decide si la entrega cuenta como calificada).
const AHORA = "2026-10-01T20:00:00.000Z";
const nota = { userId: "u1", submissionId: null, grade: 4.5, feedback: "" };

describe("filaDeNotaExterna", () => {
  it("examen: nota de anulación, intento completado con su inicio y respuestas vacías", () => {
    expect(filaDeNotaExterna("exam", "e1", nota, AHORA)).toEqual({
      update: {
        final_override_grade: 4.5,
        teacher_feedback: null,
        status: "completado",
        submitted_at: AHORA,
      },
      insert: {
        exam_id: "e1",
        user_id: "u1",
        final_override_grade: 4.5,
        teacher_feedback: null,
        status: "completado",
        submitted_at: AHORA,
        started_at: AHORA,
        answers: {},
      },
    });
  });

  it("taller y proyecto: final_grade y estado calificado", () => {
    const t = filaDeNotaExterna("workshop", "w1", { ...nota, feedback: "Muy clara" }, AHORA);
    expect(t.update).toEqual({
      final_grade: 4.5,
      teacher_feedback: "Muy clara",
      status: "calificado",
      submitted_at: AHORA,
    });
    expect(t.insert).toEqual({
      workshop_id: "w1",
      user_id: "u1",
      final_grade: 4.5,
      teacher_feedback: "Muy clara",
      status: "calificado",
      submitted_at: AHORA,
    });
    expect(filaDeNotaExterna("project", "p1", nota, AHORA).insert).toMatchObject({
      project_id: "p1",
      final_grade: 4.5,
    });
  });

  it("sin nota guarda null (no 0)", () => {
    expect(
      filaDeNotaExterna("workshop", "w1", { ...nota, grade: null }, AHORA).update.final_grade,
    ).toBeNull();
  });
});
