import { describe, expect, it } from "vitest";
import { tarjetaDeExamen } from "./tarjeta-de-examen";

const intento = (exam_id: string, nota: number | null, created_at: string, status = "completado") => ({
  exam_id,
  status,
  ai_grade: nota,
  final_override_grade: null as number | null,
  created_at,
});

describe("tarjeta de un examen en la lista del estudiante", () => {
  // El caso reportado: 2,6 en el primer intento, 4,8 en el segundo, modo «más alto».
  const dosIntentos = [intento("ex", 2.6, "2026-10-06T23:40:00Z"), intento("ex", 4.8, "2026-10-07T16:38:00Z")];

  it("muestra la nota del modo del examen, no la del primer intento que devuelve la base", () => {
    expect(tarjetaDeExamen({ id: "ex", retry_mode: "highest" }, [], dosIntentos).nota).toBe(4.8);
    // El orden en que llegan las filas no cambia nada.
    expect(tarjetaDeExamen({ id: "ex", retry_mode: "highest" }, [], [...dosIntentos].reverse()).nota).toBe(4.8);
  });

  it("respeta los tres modos", () => {
    expect(tarjetaDeExamen({ id: "ex", retry_mode: "average" }, [], dosIntentos).nota).toBe(3.7);
    expect(tarjetaDeExamen({ id: "ex", retry_mode: "last" }, [], [...dosIntentos].reverse()).nota).toBe(4.8);
    const alReves = [intento("ex", 4.8, "2026-10-06T23:40:00Z"), intento("ex", 2.6, "2026-10-07T16:38:00Z")];
    expect(tarjetaDeExamen({ id: "ex", retry_mode: "last" }, [], alReves).nota).toBe(2.6);
  });

  it("el estado lo manda el intento más reciente, aunque llegue primero el viejo", () => {
    const enCurso = [intento("ex", 2.6, "2026-10-06T23:40:00Z"), intento("ex", null, "2026-10-08T10:00:00Z", "en_progreso")];
    const r = tarjetaDeExamen({ id: "ex", retry_mode: "highest" }, [], enCurso);
    expect(r.intento?.status).toBe("en_progreso");
    expect(r.nota).toBe(2.6);
  });

  it("el último sin nota manda el estado (por calificar) aunque la nota venga del anterior", () => {
    const enCola = [intento("ex", 2.6, "2026-10-06T23:40:00Z"), intento("ex", null, "2026-10-07T16:38:00Z")];
    const r = tarjetaDeExamen({ id: "ex", retry_mode: "highest" }, [], enCola);
    expect(r.intento?.ai_grade).toBeNull();
    expect(r.nota).toBe(2.6);
  });

  it("sin intentos propios, el de una recuperación; y su nota cuenta como la del examen", () => {
    const examenes = [{ id: "ex", retry_mode: "highest" }, { id: "sup", parent_exam_id: "ex", status: "published" }];
    const r = tarjetaDeExamen(examenes[0], examenes, [intento("sup", 3.9, "2026-10-09T10:00:00Z")]);
    expect(r.intento?.exam_id).toBe("sup");
    expect(r.nota).toBe(3.9);
    expect(r.examIdRevision).toBe("sup");
  });

  it("con intento propio y un recuperatorio: la nota pliega las dos y el detalle abre el examen", () => {
    const original = { id: "ex", retry_mode: "last", created_at: "2026-10-01T00:00:00Z" };
    const rec = (regla: string) => ({
      id: "rec",
      parent_exam_id: "ex",
      status: "published",
      makeup_kind: "recuperatorio",
      recovery_rule: regla,
      created_at: "2026-10-10T00:00:00Z",
    });
    const intentos = [intento("ex", 2, "2026-10-06T00:00:00Z"), intento("rec", 4, "2026-10-12T00:00:00Z")];
    const mayor = tarjetaDeExamen(original, [original, rec("mayor")], intentos);
    expect(mayor.nota).toBe(4);
    expect(mayor.intento?.exam_id).toBe("ex");
    expect(mayor.examIdRevision).toBe("ex");
    const baja = [intento("ex", 4, "2026-10-06T00:00:00Z"), intento("rec", 3, "2026-10-12T00:00:00Z")];
    expect(tarjetaDeExamen(original, [original, rec("reemplaza")], baja).nota).toBe(3);
  });

  it("una recuperación devuelta a borrador no cuenta: ni para la nota ni para el estado", () => {
    const examenes = [{ id: "ex" }, { id: "sup", parent_exam_id: "ex", status: "draft" }];
    const r = tarjetaDeExamen(examenes[0], examenes, [intento("sup", 3.9, "2026-10-09T10:00:00Z")]);
    expect(r).toEqual({ intento: undefined, nota: null, examIdRevision: "ex" });
  });

  it("con dos recuperaciones y sin intentos propios, el detalle abre la que dio la nota", () => {
    const examenes = [
      { id: "ex", created_at: "2026-10-01T00:00:00Z" },
      { id: "sup", parent_exam_id: "ex", status: "published", makeup_kind: "supletorio", created_at: "2026-10-05T00:00:00Z" },
      {
        id: "rec",
        parent_exam_id: "ex",
        status: "published",
        makeup_kind: "recuperatorio",
        recovery_rule: "mayor",
        created_at: "2026-10-08T00:00:00Z",
      },
    ];
    const intentos = [intento("sup", 4, "2026-10-06T00:00:00Z"), intento("rec", 3.5, "2026-10-09T00:00:00Z")];
    const r = tarjetaDeExamen(examenes[0], examenes, intentos);
    expect(r.nota).toBe(4);
    expect(r.intento?.exam_id).toBe("rec");
    expect(r.examIdRevision).toBe("sup");
  });

  it("sin intentos, nada", () => {
    expect(tarjetaDeExamen({ id: "ex" }, [], [])).toEqual({ intento: undefined, nota: null, examIdRevision: "ex" });
  });
});
