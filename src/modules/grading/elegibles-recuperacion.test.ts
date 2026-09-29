import { describe, it, expect } from "vitest";
import {
  candidatosParaRecuperacion,
  notaEnEscala,
  sugerirFechasDeRecuperacion,
} from "./elegibles-recuperacion";

const escala = { min: 0, max: 5, aprobacion: 3 };

const intento = (user_id: string, exam_id: string, nota: number | null, status = "completado") => ({
  user_id,
  exam_id,
  status,
  ai_grade: nota,
  final_override_grade: null,
  created_at: "2026-09-28T23:50:00Z",
});

const parcial = { id: "parcial", parent_exam_id: null, retry_mode: "last", created_at: "2026-09-01T00:00:00Z" };

describe("recuperatorio", () => {
  const estudiantes = ["ana", "beto", "caro", "dani", "eva"];
  const intentos = [
    intento("ana", "parcial", 2.4),
    intento("beto", "parcial", 4.1),
    // caro no presentó
    intento("dani", "parcial", null), // presentó, sin nota todavía
    intento("eva", "parcial", 3), // exactamente la de aprobación: aprobó
  ];

  it("marca a quien perdió y a quien no presentó; lista sin marcar a quien no tiene nota", () => {
    const r = candidatosParaRecuperacion({
      tipo: "recuperatorio",
      estudiantes,
      examen: parcial,
      examenes: [parcial],
      intentos,
      escala,
    });
    expect(r.candidatos).toEqual([
      { userId: "ana", motivo: "perdio", nota: 2.4, sugerido: true },
      { userId: "caro", motivo: "no_presento", nota: null, sugerido: true },
      { userId: "dani", motivo: "sin_nota", nota: null, sugerido: false },
    ]);
    expect(r.aprobaron).toBe(2);
    expect(r.presentaron).toBe(4);
  });

  it("un intento EN CURSO no es haber presentado", () => {
    const r = candidatosParaRecuperacion({
      tipo: "recuperatorio",
      estudiantes: ["ana"],
      examen: parcial,
      examenes: [parcial],
      intentos: [intento("ana", "parcial", null, "en_progreso")],
      escala,
    });
    expect(r.candidatos[0].motivo).toBe("no_presento");
  });

  it("decide con la nota EFECTIVA: quien ya recuperó no vuelve a salir", () => {
    const rec1 = {
      id: "rec1",
      parent_exam_id: "parcial",
      retry_mode: "last",
      makeup_kind: "recuperatorio",
      recovery_rule: "mayor",
      created_at: "2026-10-01T00:00:00Z",
    };
    const r = candidatosParaRecuperacion({
      tipo: "recuperatorio",
      estudiantes: ["ana"],
      examen: parcial,
      examenes: [parcial, rec1],
      intentos: [intento("ana", "parcial", 2.4), intento("ana", "rec1", 3.8)],
      escala,
    });
    expect(r.candidatos).toEqual([]);
    expect(r.aprobaron).toBe(1);
  });

  it("quien no presentó el parcial pero aprobó su supletorio no es candidato", () => {
    const sup = { id: "sup", parent_exam_id: "parcial", retry_mode: "last", created_at: "2026-09-20T00:00:00Z" };
    const r = candidatosParaRecuperacion({
      tipo: "recuperatorio",
      estudiantes: ["caro"],
      examen: parcial,
      examenes: [parcial, sup],
      intentos: [intento("caro", "sup", 3.5)],
      escala,
    });
    expect(r.candidatos).toEqual([]);
  });

  it("compara en la escala del curso, no con la nota cruda", () => {
    // Escala 1..5: una cruda de 2,4 sobre 5 es 1 + 0,48 × 4 = 2,92 → perdió con 3.
    const r = candidatosParaRecuperacion({
      tipo: "recuperatorio",
      estudiantes: ["ana"],
      examen: parcial,
      examenes: [parcial],
      intentos: [intento("ana", "parcial", 2.4)],
      escala: { min: 1, max: 5, aprobacion: 3 },
    });
    expect(r.candidatos[0].motivo).toBe("perdio");
    expect(r.candidatos[0].nota).toBeCloseTo(2.92, 5);
  });
});

describe("supletorio", () => {
  it("solo quien no presentó: el supletorio no cuenta para quien sí lo hizo", () => {
    const r = candidatosParaRecuperacion({
      tipo: "supletorio",
      estudiantes: ["ana", "caro", "dani"],
      examen: parcial,
      examenes: [parcial],
      intentos: [intento("ana", "parcial", 1.2), intento("dani", "parcial", null)],
      escala,
    });
    expect(r.candidatos).toEqual([
      { userId: "caro", motivo: "no_presento", nota: null, sugerido: true },
    ]);
    expect(r.presentaron).toBe(2);
  });
});

describe("notaEnEscala", () => {
  it("es identidad en una escala que arranca en 0", () => {
    expect(notaEnEscala(3.5, { min: 0, max: 5 })).toBe(3.5);
  });
  it("una escala de máximo 0 no divide por cero", () => {
    expect(notaEnEscala(3, { min: 0, max: 0 })).toBe(0);
  });
});

describe("sugerirFechasDeRecuperacion", () => {
  // Parcial del lunes 28 de sept, 18:00–20:00 en Bogotá (UTC-5).
  const inicio = new Date("2026-09-28T23:00:00Z");
  const fin = new Date("2026-09-29T01:00:00Z");

  it("corre de a semanas enteras: mismo día y misma hora", () => {
    const r = sugerirFechasDeRecuperacion(inicio, fin, new Date("2026-09-29T18:00:00Z"));
    expect(r.inicio.toISOString()).toBe("2026-10-05T23:00:00.000Z");
    expect(r.fin.toISOString()).toBe("2026-10-06T01:00:00.000Z");
  });

  it("si el original quedó varias semanas atrás, salta a la próxima franja futura", () => {
    const r = sugerirFechasDeRecuperacion(inicio, fin, new Date("2026-10-20T12:00:00Z"));
    expect(r.inicio.toISOString()).toBe("2026-10-26T23:00:00.000Z");
  });

  it("si el original todavía no empezó, deja las fechas como están", () => {
    const r = sugerirFechasDeRecuperacion(inicio, fin, new Date("2026-09-20T12:00:00Z"));
    expect(r.inicio).toEqual(inicio);
    expect(r.fin).toEqual(fin);
  });

  it("una fecha inválida no se inventa", () => {
    const malo = new Date("no-es-fecha");
    const r = sugerirFechasDeRecuperacion(malo, fin, new Date());
    expect(Number.isNaN(r.inicio.getTime())).toBe(true);
  });
});
