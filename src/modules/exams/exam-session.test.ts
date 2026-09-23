import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isStrikeEvent } from "./proctoring";
import fs from "node:fs";
import path from "node:path";
import {
  MS_BLOQUEO_SESION,
  MS_ENTRE_LATIDOS,
  MS_GUARDADO_RECIENTE,
  applyClearAllWarnings,
  applyClearOneWarning,
  applyExtraTime,
  computeExtraSeconds,
  latidoEsRedundante,
  restoreQuestionIndex,
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

// ─── El decremento solo aplica a eventos que SUMARON strike ────────────────
//
// Antes se decrementaba para cualquier índice, así que perdonar un "Intento de
// copiar" —que nunca sumó— regalaba un strike y, si eso cruzaba el umbral
// hacia abajo, DES-SUSPENDÍA al alumno. La allowlist vive en
// `isStrikeEvent` (proctoring.ts) y son exactamente los tres tipos con los que
// la pantalla de toma llama a `recordWarning`.
describe("applyClearOneWarning — solo descuenta strikes reales", () => {
  const base = {
    status: "en_progreso" as const,
    focusWarnings: 3,
    examMaxWarnings: 3,
    // La ventana sigue abierta: es el caso en vivo, donde el docente perdona
    // mientras el alumno rinde.
    examIsOpen: true,
  };

  it("borrar una señal BLANDA no baja el contador", () => {
    for (const blando of ["copiar", "pegar", "cortar", "screenshot_attempt"]) {
      const r = applyClearOneWarning(
        { ...base, events: [{ type: blando }, { type: "pestaña" }] },
        0,
      );
      expect(r.focusWarnings, `${blando} no debe descontar`).toBe(3);
      expect(r.events).toHaveLength(1);
    }
  });

  it("borrar un strike REAL sí baja el contador", () => {
    for (const duro of ["pestaña", "fullscreen_exit", "visibility_hidden"]) {
      const r = applyClearOneWarning({ ...base, events: [{ type: duro }] }, 0);
      expect(r.focusWarnings, `${duro} debe descontar`).toBe(2);
    }
  });

  it("un tipo DESCONOCIDO no descuenta — la allowlist falla hacia el lado seguro", () => {
    const r = applyClearOneWarning(
      { ...base, events: [{ type: "algo_que_alguien_agregue_manana" }] },
      0,
    );
    expect(r.focusWarnings).toBe(3);
  });

  it("borrar una blanda NO des-suspende a un alumno marcado sospechoso", () => {
    // El caso que motivó el arreglo: 3/3 sospechoso, el docente perdona el
    // "Intento de copiar" y el alumno volvía a en_progreso con 2/3.
    const r = applyClearOneWarning(
      {
        ...base,
        status: "sospechoso",
        events: [{ type: "screenshot_attempt" }, { type: "pestaña" }, { type: "pestaña" }],
      },
      0,
    );
    expect(r.focusWarnings).toBe(3);
    expect(r.status).toBe("sospechoso");
    expect(r.restoredToInProgress).toBe(false);
  });
});

describe("borrar advertencias con el intento EN CURSO", () => {
  // Es la invariante que hace seguro ofrecer el botón durante el examen: si
  // alguna de estas ramas tocara el estado, perdonar un strike TERMINARÍA el
  // intento del alumno a mitad del examen.
  const enCurso = {
    status: "en_progreso",
    focusWarnings: 2,
    events: [
      { type: "pestaña", at: "2026-01-01T10:00:00Z" },
      { type: "fullscreen_exit", at: "2026-01-01T10:05:00Z" },
      // No suma strike: está en el array para que el docente lo VEA.
      { type: "copiar", at: "2026-01-01T10:06:00Z" },
    ],
    examMaxWarnings: 3,
    examIsOpen: true,
  };

  it("borrar una deja el intento en curso y no lo da por entregado", () => {
    const r = applyClearOneWarning(enCurso, 0);
    expect(r.status).toBe("en_progreso");
    expect(r.focusWarnings).toBe(1);
    expect(r.clearSubmittedAt).toBe(false);
    expect(r.restoredToInProgress).toBe(false);
    expect(r.closedAsCompletado).toBe(false);
  });

  it("perdonar un evento que NO suma strike no baja el contador", () => {
    // Bajarlo regalaría un strike inexistente — el mismo error que el código
    // ya evita, pero ahora alcanzable a mitad del examen.
    const r = applyClearOneWarning(enCurso, 2);
    expect(r.focusWarnings).toBe(2);
    expect(r.events).toHaveLength(2);
  });

  it("borrarlas todas tampoco cambia el estado", () => {
    const r = applyClearAllWarnings(enCurso);
    expect(r.status).toBe("en_progreso");
    expect(r.focusWarnings).toBe(0);
    expect(r.events).toEqual([]);
    expect(r.clearSubmittedAt).toBe(false);
    expect(r.closedAsCompletado).toBe(false);
  });

  it("con la ventana del examen ya cerrada tampoco lo cierra", () => {
    // El docente puede estar limpiando después de la hora; eso no debe
    // convertir un `en_progreso` en `completado` por un camino lateral.
    const r = applyClearAllWarnings({ ...enCurso, examIsOpen: false });
    expect(r.status).toBe("en_progreso");
    expect(r.closedAsCompletado).toBe(false);
  });
});

describe("los tipos que suman strike: SQL ↔ TypeScript", () => {
  // Invariante cross-file. `teacher_clear_exam_warnings` (mig 20262330000000)
  // RECALCULA `focus_warnings` contando strikes en el array que queda, así que
  // su lista tiene que ser la misma que la de `proctoring.ts`. Si divergen,
  // perdonar un evento blando ("intento de copiar") regalaría un strike
  // inexistente, o al revés dejaría suspendido a alguien que ya no lo está —
  // y nada falla: el número simplemente queda mal.
  const migracion = fs.readFileSync(
    path.join(process.cwd(), "supabase/migrations/20262330000000_borrar_advertencias_examen_en_curso.sql"),
    "utf8",
  );

  it("la lista del SQL es exactamente la del cliente", () => {
    const enSql = migracion
      .slice(migracion.indexOf("_exam_warning_is_strike"))
      .match(/_type IN \(([^)]*)\)/)?.[1];
    expect(enSql, "no encontré la lista en la migración").toBeTruthy();
    const tiposSql = [...enSql!.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

    // Se deriva del comportamiento REAL de `isStrikeEvent`, no de una copia de
    // la constante: el set no se exporta, y copiarlo acá sería una tercera
    // lista que también se puede desincronizar.
    const candidatos = [
      ...tiposSql,
      "copiar", "pegar", "cortar", "screenshot_attempt", "blur", "devtools",
    ];
    const tiposCliente = candidatos.filter((t) => isStrikeEvent(t)).sort();

    expect(tiposSql).toEqual([...new Set(tiposCliente)].sort());
    // Y que ninguno de los blandos se haya colado en el SQL.
    for (const blando of ["copiar", "pegar", "cortar", "screenshot_attempt"]) {
      expect(tiposSql, `${blando} NO debería sumar strike`).not.toContain(blando);
    }
  });
});

describe("el latido no se repite cuando el autoguardado ya escribió", () => {
  it("con un guardado reciente se salta; sin actividad, late", () => {
    expect(latidoEsRedundante(0)).toBe(true);
    expect(latidoEsRedundante(MS_GUARDADO_RECIENTE - 1)).toBe(true);
    expect(latidoEsRedundante(MS_GUARDADO_RECIENTE)).toBe(false);
    // Un alumno leyendo una pregunta larga: hace rato que no guarda nada, así
    // que el latido TIENE que correr — es justo para lo que existe.
    expect(latidoEsRedundante(30_000)).toBe(false);
  });

  it("el retraso máximo que introduce queda por debajo de la ventana del bloqueo", () => {
    // ESTA es la invariante que no se puede romper. Saltarse un tick atrasa el
    // refresco de `updated_at` como mucho `MS_GUARDADO_RECIENTE + MS_ENTRE_LATIDOS`
    // (el guardado cae justo antes de un tick, se salta, y el siguiente escribe
    // un ciclo después). Si ese total alcanzara la ventana del bloqueo, el
    // intento se declararía abandonado y otro dispositivo podría reclamárselo
    // al propio alumno en mitad del examen.
    const peorCaso = MS_GUARDADO_RECIENTE + MS_ENTRE_LATIDOS;
    expect(peorCaso).toBeLessThan(MS_BLOQUEO_SESION);
    // Y con margen de verdad, no por 100 ms: la red real tarda ~600 ms por
    // consulta en un día bueno.
    expect(MS_BLOQUEO_SESION - peorCaso).toBeGreaterThanOrEqual(1500);
  });
});

describe("la ventana del bloqueo no vive duplicada en la pantalla de examen", () => {
  /**
   * El test de arriba compara las constantes ENTRE SÍ, así que si alguien
   * cambia `MS_BLOQUEO_SESION` y la pantalla sigue comparando contra un
   * `10_000` escrito a mano, el test queda verde y el margen que protege se
   * rompe en silencio: el intento se daría por abandonado antes de que el
   * latido alcance a refrescarlo, y otro dispositivo podría reclamárselo al
   * propio alumno. Por eso se mira el archivo.
   */
  const ruta = readFileSync(
    resolve(process.cwd(), "src/routes/app.student.take.$examId.tsx"),
    "utf8",
  );

  it("la pantalla usa las constantes, no números sueltos", () => {
    expect(ruta).toContain("MS_BLOQUEO_SESION");
    expect(ruta).toContain("MS_ENTRE_LATIDOS");
    // Los literales que había: la comparación de la ventana y el período.
    expect(ruta).not.toMatch(/ageMs\s*<\s*\d/);
    expect(ruta).not.toMatch(/\}\s*,\s*5000\s*\)\s*;/);
  });
});
