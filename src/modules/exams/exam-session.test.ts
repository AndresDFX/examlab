import { describe, expect, it } from "vitest";
import {
  computeExtraSeconds,
  applyExtraTime,
  restoreQuestionIndex,
  applyClearOneWarning,
  applyClearAllWarnings,
  type WarningEventLike,
} from "./exam-session";

// ─── computeExtraSeconds ───────────────────────────────────────────────────

describe("computeExtraSeconds", () => {
  it("devuelve 0 para array vacío", () => {
    expect(computeExtraSeconds([])).toBe(0);
  });

  it("suma los segundos de filas add_time", () => {
    expect(
      computeExtraSeconds([
        { action: "add_time", extra_seconds: 300, target_user_id: "u1" },
        { action: "add_time", extra_seconds: 120, target_user_id: null },
      ]),
    ).toBe(420);
  });

  it("ignora filas pause y resume (no son tiempo extra)", () => {
    expect(
      computeExtraSeconds([
        { action: "pause", extra_seconds: 0, target_user_id: null },
        { action: "resume", extra_seconds: 0, target_user_id: null },
        { action: "add_time", extra_seconds: 60, target_user_id: "u1" },
      ]),
    ).toBe(60);
  });

  it("acumula múltiples add_time para el mismo estudiante", () => {
    expect(
      computeExtraSeconds([
        { action: "add_time", extra_seconds: 300, target_user_id: "u1" },
        { action: "add_time", extra_seconds: 300, target_user_id: "u1" },
      ]),
    ).toBe(600);
  });

  it("trata extra_seconds null como 0 (sin crashear)", () => {
    expect(
      computeExtraSeconds([
        { action: "add_time", extra_seconds: null, target_user_id: "u1" },
        { action: "add_time", extra_seconds: 180, target_user_id: "u1" },
      ]),
    ).toBe(180);
  });

  it("ignora valores no numéricos usando Number() con fallback 0", () => {
    expect(
      computeExtraSeconds([
        // @ts-expect-error: prueba de robustez con valor malo
        { action: "add_time", extra_seconds: "no-number", target_user_id: "u1" },
        { action: "add_time", extra_seconds: 90, target_user_id: "u1" },
      ]),
    ).toBe(90);
  });
});

// ─── applyExtraTime ────────────────────────────────────────────────────────

describe("applyExtraTime", () => {
  const BASE = "2026-05-15T14:00:00.000Z";

  it("devuelve el endTime original si extraSeconds es 0", () => {
    expect(applyExtraTime(BASE, 0)).toBe(BASE);
  });

  it("devuelve el endTime original si extraSeconds es negativo", () => {
    expect(applyExtraTime(BASE, -60)).toBe(BASE);
  });

  it("extiende el endTime por los segundos dados", () => {
    const extended = applyExtraTime(BASE, 300); // +5 minutos
    const expectedMs = new Date(BASE).getTime() + 300_000;
    expect(new Date(extended).getTime()).toBe(expectedMs);
  });

  it("devuelve ISO string válido", () => {
    const result = applyExtraTime(BASE, 600);
    expect(() => new Date(result)).not.toThrow();
    expect(isNaN(new Date(result).getTime())).toBe(false);
  });

  it("maneja extras grandes (1 hora)", () => {
    const result = applyExtraTime(BASE, 3600);
    const expected = new Date(new Date(BASE).getTime() + 3_600_000).toISOString();
    expect(result).toBe(expected);
  });
});

// ─── restoreQuestionIndex ─────────────────────────────────────────────────

describe("restoreQuestionIndex", () => {
  it("devuelve 0 para answers vacío", () => {
    expect(restoreQuestionIndex({})).toBe(0);
  });

  it("devuelve el índice persistido cuando es un número válido", () => {
    expect(restoreQuestionIndex({ __current_idx: 4 })).toBe(4);
  });

  it("devuelve 0 si el índice es 0 (primera pregunta)", () => {
    expect(restoreQuestionIndex({ __current_idx: 0 })).toBe(0);
  });

  it("devuelve 0 si __current_idx es string (no número)", () => {
    expect(restoreQuestionIndex({ __current_idx: "3" })).toBe(0);
  });

  it("devuelve 0 si __current_idx es undefined", () => {
    expect(restoreQuestionIndex({ __current_idx: undefined })).toBe(0);
  });

  it("devuelve 0 si __current_idx es null", () => {
    expect(restoreQuestionIndex({ __current_idx: null })).toBe(0);
  });

  it("devuelve 0 si __current_idx es negativo (estado corrupto)", () => {
    expect(restoreQuestionIndex({ __current_idx: -1 })).toBe(0);
  });

  it("ignora otras claves de answers (session_id, warnings, etc.)", () => {
    expect(
      restoreQuestionIndex({
        __session_id: "abc",
        __current_idx: 7,
        __warning_events: [],
        "q-1": "respuesta",
      }),
    ).toBe(7);
  });
});

// ─── applyClearOneWarning ──────────────────────────────────────────────────

describe("applyClearOneWarning", () => {
  const mkEvents = (n: number): WarningEventLike[] =>
    Array.from({ length: n }, (_, i) => ({ type: "pestaña", at: `2026-04-20T12:00:0${i}Z` }));

  it("decrementa focus_warnings y borra el evento del índice indicado", () => {
    const result = applyClearOneWarning(
      {
        status: "en_progreso",
        focusWarnings: 2,
        events: mkEvents(2),
        examMaxWarnings: 3,
        examIsOpen: true,
      },
      0,
    );
    expect(result.focusWarnings).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].at).toBe("2026-04-20T12:00:01Z");
  });

  it("no-op cuando el índice está fuera de rango (sin mutar)", () => {
    const result = applyClearOneWarning(
      {
        status: "en_progreso",
        focusWarnings: 2,
        events: mkEvents(2),
        examMaxWarnings: 3,
        examIsOpen: true,
      },
      99,
    );
    expect(result.focusWarnings).toBe(2);
    expect(result.events).toHaveLength(2);
    expect(result.clearSubmittedAt).toBe(false);
    expect(result.restoredToInProgress).toBe(false);
  });

  it("no-op para índice negativo", () => {
    const result = applyClearOneWarning(
      {
        status: "en_progreso",
        focusWarnings: 2,
        events: mkEvents(2),
        examMaxWarnings: 3,
        examIsOpen: true,
      },
      -1,
    );
    expect(result.focusWarnings).toBe(2);
  });

  it("restaura sospechoso → en_progreso cuando warnings cae bajo el umbral", () => {
    const result = applyClearOneWarning(
      {
        status: "sospechoso",
        focusWarnings: 3,
        events: mkEvents(3),
        examMaxWarnings: 3,
        examIsOpen: true,
      },
      0,
    );
    expect(result.status).toBe("en_progreso");
    expect(result.focusWarnings).toBe(2);
    expect(result.clearSubmittedAt).toBe(true);
    expect(result.restoredToInProgress).toBe(true);
  });

  it("NO restaura si sigue en o sobre el umbral después de borrar", () => {
    const result = applyClearOneWarning(
      {
        status: "sospechoso",
        focusWarnings: 5, // 5 advertencias, max 3 → cae a 4, sigue sospechoso
        events: mkEvents(5),
        examMaxWarnings: 3,
        examIsOpen: true,
      },
      0,
    );
    expect(result.status).toBe("sospechoso");
    expect(result.focusWarnings).toBe(4);
    expect(result.clearSubmittedAt).toBe(false);
    expect(result.restoredToInProgress).toBe(false);
  });

  it("no restaura si el status no era sospechoso (idempotente)", () => {
    const result = applyClearOneWarning(
      {
        status: "completado",
        focusWarnings: 1,
        events: mkEvents(1),
        examMaxWarnings: 3,
        examIsOpen: true,
      },
      0,
    );
    expect(result.status).toBe("completado");
    expect(result.clearSubmittedAt).toBe(false);
  });

  it("respeta un examMax custom (más alto)", () => {
    // Examen con max=5, estaba sospechoso con 5 → al borrar 1, cae a 4 < 5 → restaura
    const result = applyClearOneWarning(
      {
        status: "sospechoso",
        focusWarnings: 5,
        events: mkEvents(5),
        examMaxWarnings: 5,
        examIsOpen: true,
      },
      0,
    );
    expect(result.status).toBe("en_progreso");
    expect(result.focusWarnings).toBe(4);
  });

  it("focus_warnings no baja de 0", () => {
    const result = applyClearOneWarning(
      {
        status: "en_progreso",
        focusWarnings: 0,
        events: mkEvents(1),
        examMaxWarnings: 3,
        examIsOpen: true,
      },
      0,
    );
    expect(result.focusWarnings).toBe(0);
  });

  it("no muta el input (pureza)", () => {
    const events = mkEvents(2);
    const input = {
      status: "sospechoso",
      focusWarnings: 3,
      events,
      examMaxWarnings: 3,
      examIsOpen: true,
    };
    const snapshot = JSON.stringify(input);
    applyClearOneWarning(input, 0);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// ─── applyClearAllWarnings ─────────────────────────────────────────────────

describe("applyClearAllWarnings", () => {
  const mkEvents = (n: number): WarningEventLike[] =>
    Array.from({ length: n }, (_, i) => ({ type: "pestaña", at: `2026-04-20T12:00:0${i}Z` }));

  it("resetea focus_warnings a 0 y vacía el array de eventos", () => {
    const result = applyClearAllWarnings({
      status: "en_progreso",
      focusWarnings: 3,
      events: mkEvents(3),
      examMaxWarnings: 3,
      examIsOpen: true,
    });
    expect(result.focusWarnings).toBe(0);
    expect(result.events).toEqual([]);
  });

  it("restaura sospechoso → en_progreso y marca clearSubmittedAt", () => {
    const result = applyClearAllWarnings({
      status: "sospechoso",
      focusWarnings: 3,
      events: mkEvents(3),
      examMaxWarnings: 3,
      examIsOpen: true,
    });
    expect(result.status).toBe("en_progreso");
    expect(result.clearSubmittedAt).toBe(true);
    expect(result.restoredToInProgress).toBe(true);
  });

  it("no toca status si no era sospechoso", () => {
    const result = applyClearAllWarnings({
      status: "completado",
      focusWarnings: 2,
      events: mkEvents(2),
      examMaxWarnings: 3,
      examIsOpen: true,
    });
    expect(result.status).toBe("completado");
    expect(result.clearSubmittedAt).toBe(false);
    expect(result.restoredToInProgress).toBe(false);
  });

  it("funciona con array de eventos vacío (idempotente)", () => {
    const result = applyClearAllWarnings({
      status: "en_progreso",
      focusWarnings: 0,
      events: [],
      examMaxWarnings: 3,
      examIsOpen: true,
    });
    expect(result.focusWarnings).toBe(0);
    expect(result.events).toEqual([]);
    expect(result.clearSubmittedAt).toBe(false);
  });

  it("no muta el input (pureza)", () => {
    const events = mkEvents(3);
    const input = {
      status: "sospechoso",
      focusWarnings: 3,
      events,
      examMaxWarnings: 3,
      examIsOpen: true,
    };
    const snapshot = JSON.stringify(input);
    applyClearAllWarnings(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(events).toHaveLength(3);
  });

  it("restaura aun cuando focus_warnings sea > examMax (caso histórico)", () => {
    const result = applyClearAllWarnings({
      status: "sospechoso",
      focusWarnings: 10,
      events: mkEvents(10),
      examMaxWarnings: 3,
      examIsOpen: true,
    });
    expect(result.status).toBe("en_progreso");
    expect(result.focusWarnings).toBe(0);
    expect(result.clearSubmittedAt).toBe(true);
  });

  // ── examIsOpen=false: si el examen ya cerró, no podemos reabrir
  it("examIsOpen=false: restaura a 'completado' (no 'en_progreso') y NO limpia submitted_at", () => {
    const result = applyClearAllWarnings({
      status: "sospechoso",
      focusWarnings: 3,
      events: mkEvents(3),
      examMaxWarnings: 3,
      examIsOpen: false,
    });
    expect(result.status).toBe("completado");
    expect(result.focusWarnings).toBe(0);
    expect(result.clearSubmittedAt).toBe(false);
    expect(result.restoredToInProgress).toBe(false);
    expect(result.closedAsCompletado).toBe(true);
  });

  it("examIsOpen=false: si no era sospechoso, no toca status (idempotente)", () => {
    const result = applyClearAllWarnings({
      status: "completado",
      focusWarnings: 2,
      events: mkEvents(2),
      examMaxWarnings: 3,
      examIsOpen: false,
    });
    expect(result.status).toBe("completado");
    expect(result.closedAsCompletado).toBe(false);
  });
});

describe("applyClearOneWarning — examIsOpen=false (ventana cerrada)", () => {
  const mkEvents = (n: number): WarningEventLike[] =>
    Array.from({ length: n }, () => ({ type: "pestaña" }));

  it("sospechoso → completado cuando cae bajo umbral pero el examen ya cerró", () => {
    const result = applyClearOneWarning(
      {
        status: "sospechoso",
        focusWarnings: 3,
        events: mkEvents(3),
        examMaxWarnings: 3,
        examIsOpen: false,
      },
      0,
    );
    expect(result.status).toBe("completado");
    expect(result.focusWarnings).toBe(2);
    expect(result.clearSubmittedAt).toBe(false);
    expect(result.restoredToInProgress).toBe(false);
    expect(result.closedAsCompletado).toBe(true);
  });

  it("si sigue sobre el umbral, sigue sospechoso aunque examen cerró", () => {
    const result = applyClearOneWarning(
      {
        status: "sospechoso",
        focusWarnings: 5,
        events: mkEvents(5),
        examMaxWarnings: 3,
        examIsOpen: false,
      },
      0,
    );
    expect(result.status).toBe("sospechoso");
    expect(result.focusWarnings).toBe(4);
    expect(result.closedAsCompletado).toBe(false);
  });
});
