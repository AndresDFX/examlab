import { describe, expect, it } from "vitest";
import { computeAttemptGrade, retryModeLabel, type AttemptForGrade } from "./exam-attempts";

function attempt(partial: Partial<AttemptForGrade>): AttemptForGrade {
  return {
    status: "completado",
    ai_grade: null,
    final_override_grade: null,
    created_at: "2026-09-30T12:00:00Z",
    ...partial,
  };
}

describe("computeAttemptGrade — sin intentos", () => {
  it("retorna null para array vacio", () => {
    expect(computeAttemptGrade([], "last")).toBeNull();
  });

  it("retorna null si no hay intentos finalizados", () => {
    const a = attempt({ status: "en_progreso", ai_grade: 4 });
    expect(computeAttemptGrade([a], "last")).toBeNull();
  });

  it("retorna null si ningun intento finalizado tiene nota", () => {
    const a = attempt({ status: "completado", ai_grade: null, final_override_grade: null });
    expect(computeAttemptGrade([a], "last")).toBeNull();
  });
});

describe("computeAttemptGrade — prioridad final_override_grade > ai_grade", () => {
  it("usa final_override_grade si existe (incluso si ai_grade tambien)", () => {
    const a = attempt({ ai_grade: 3, final_override_grade: 4.5 });
    expect(computeAttemptGrade([a], "last")).toBe(4.5);
  });

  it("usa ai_grade si no hay final_override", () => {
    const a = attempt({ ai_grade: 3, final_override_grade: null });
    expect(computeAttemptGrade([a], "last")).toBe(3);
  });
});

describe("computeAttemptGrade — modo 'last'", () => {
  it("toma el intento mas reciente por created_at", () => {
    const old = attempt({
      ai_grade: 3,
      created_at: "2026-09-01T00:00:00Z",
    });
    const recent = attempt({
      ai_grade: 4,
      created_at: "2026-09-30T00:00:00Z",
    });
    expect(computeAttemptGrade([old, recent], "last")).toBe(4);
    // El orden de entrada no debe importar
    expect(computeAttemptGrade([recent, old], "last")).toBe(4);
  });
});

describe("computeAttemptGrade — modo 'average'", () => {
  it("promedia los intentos finalizados con nota", () => {
    const attempts = [
      attempt({ ai_grade: 3 }),
      attempt({ ai_grade: 4 }),
      attempt({ ai_grade: 5 }),
    ];
    expect(computeAttemptGrade(attempts, "average")).toBe(4);
  });

  it("redondea a 2 decimales", () => {
    const attempts = [attempt({ ai_grade: 3.333 }), attempt({ ai_grade: 4 })];
    // (3.333 + 4) / 2 = 3.6665 → 3.67
    expect(computeAttemptGrade(attempts, "average")).toBe(3.67);
  });

  it("ignora intentos sin nota", () => {
    const attempts = [
      attempt({ ai_grade: 4 }),
      attempt({ ai_grade: null, final_override_grade: null }),
    ];
    expect(computeAttemptGrade(attempts, "average")).toBe(4);
  });

  it("ignora intentos no finalizados", () => {
    const attempts = [
      attempt({ status: "completado", ai_grade: 4 }),
      attempt({ status: "en_progreso", ai_grade: 1 }),
    ];
    expect(computeAttemptGrade(attempts, "average")).toBe(4);
  });
});

describe("computeAttemptGrade — modo 'highest'", () => {
  it("toma el maximo", () => {
    const attempts = [
      attempt({ ai_grade: 3 }),
      attempt({ ai_grade: 4.5 }),
      attempt({ ai_grade: 4 }),
    ];
    expect(computeAttemptGrade(attempts, "highest")).toBe(4.5);
  });

  it("considera override por encima de ai_grade dentro de cada intento", () => {
    const attempts = [
      attempt({ ai_grade: 5, final_override_grade: 2 }), // efectivo 2
      attempt({ ai_grade: 3 }), // efectivo 3
    ];
    expect(computeAttemptGrade(attempts, "highest")).toBe(3);
  });
});

describe("computeAttemptGrade — status considerados finalizados", () => {
  it("status 'sospechoso' SI cuenta (es final)", () => {
    const a = attempt({ status: "sospechoso", ai_grade: 4 });
    expect(computeAttemptGrade([a], "last")).toBe(4);
  });

  it("status null tambien cuenta como finalizado (legacy)", () => {
    const a = attempt({ status: null, ai_grade: 4 });
    expect(computeAttemptGrade([a], "last")).toBe(4);
  });
});

describe("retryModeLabel", () => {
  it("traduce a humano", () => {
    expect(retryModeLabel("last")).toBe("Último intento");
    expect(retryModeLabel("average")).toBe("Promedio");
    expect(retryModeLabel("highest")).toBe("Más alto");
  });
});
