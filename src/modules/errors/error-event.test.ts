import { describe, it, expect } from "vitest";
import {
  errorMessage,
  ERROR_STATUSES,
  normalizeErrorMessage,
  fingerprintEvent,
  groupEvents,
  aggregateGroupStatus,
  type ErrStatus,
  type ErrorEventLike,
} from "./error-event";

// ── errorMessage ────────────────────────────────────────────────────

describe("errorMessage", () => {
  it("devuelve null para metadata nulo / no-objeto", () => {
    expect(errorMessage(null)).toBeNull();
    expect(errorMessage(undefined)).toBeNull();
    expect(errorMessage("string suelto")).toBeNull();
    expect(errorMessage(42)).toBeNull();
    expect(errorMessage(true)).toBeNull();
  });

  it("devuelve null cuando no hay ninguna clave conocida", () => {
    expect(errorMessage({ foo: "bar", code: 500 })).toBeNull();
    expect(errorMessage({})).toBeNull();
  });

  it("extrae la clave `error`", () => {
    expect(errorMessage({ error: "boom" })).toBe("boom");
  });

  it("respeta el orden de preferencia error > reason > message > detail", () => {
    expect(errorMessage({ error: "E", reason: "R", message: "M", detail: "D" })).toBe("E");
    expect(errorMessage({ reason: "R", message: "M", detail: "D" })).toBe("R");
    expect(errorMessage({ message: "M", detail: "D" })).toBe("M");
    expect(errorMessage({ detail: "D" })).toBe("D");
  });

  it("ignora valores no-string y sigue buscando", () => {
    expect(errorMessage({ error: { nested: true }, reason: "fallback" })).toBe("fallback");
    expect(errorMessage({ error: 123, message: "ok" })).toBe("ok");
  });

  it("trata la string vacía como ausente (sigue buscando)", () => {
    expect(errorMessage({ error: "", reason: "real" })).toBe("real");
    expect(errorMessage({ error: "" })).toBeNull();
  });
});

// ── ERROR_STATUSES ──────────────────────────────────────────────────

describe("ERROR_STATUSES", () => {
  it("lista los 4 estados en orden de flujo", () => {
    const expected: ErrStatus[] = ["nuevo", "revisando", "resuelto", "ignorado"];
    expect(ERROR_STATUSES).toEqual(expected);
  });
});

// ── normalizeErrorMessage ───────────────────────────────────────────

describe("normalizeErrorMessage", () => {
  it("lowercase + colapsa whitespace + trim", () => {
    expect(normalizeErrorMessage("  Hola   MUNDO  ")).toBe("hola mundo");
  });

  it("reemplaza UUIDs por `?`", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(normalizeErrorMessage(`FK violation row ${uuid} dup`)).toBe("fk violation row ? dup");
  });

  it("reemplaza ids hex largos (>=12 chars) por `?`", () => {
    expect(normalizeErrorMessage("hash deadbeefcafe12345 conflict")).toBe("hash ? conflict");
  });

  it("reemplaza números largos (>=4 dígitos) por `N` (sentinel mayúscula)", () => {
    // El lowercase corre antes, así que la N agregada después queda en
    // mayúscula — sirve como sentinel visible contra el texto normalizado.
    expect(normalizeErrorMessage("retry attempt 1234567")).toBe("retry attempt N");
  });

  it("NO toca números cortos (<4 dígitos) — ej. códigos HTTP", () => {
    expect(normalizeErrorMessage("HTTP 500 internal")).toBe("http 500 internal");
  });

  it("corta a 200 chars", () => {
    const long = "x".repeat(500);
    expect(normalizeErrorMessage(long).length).toBe(200);
  });
});

// ── fingerprintEvent ────────────────────────────────────────────────

function ev(partial: Partial<ErrorEventLike>): ErrorEventLike {
  return {
    id: "id",
    created_at: "2026-05-01T00:00:00Z",
    action: "test.action",
    category: "test",
    status: "nuevo",
    metadata: null,
    ...partial,
  };
}

describe("fingerprintEvent", () => {
  it("combina action + category + mensaje normalizado", () => {
    const fp = fingerprintEvent(ev({ action: "x.y", category: "c", metadata: { error: "boom" } }));
    expect(fp).toBe("x.y::c::boom");
  });

  it("dos eventos con el mismo error solo cambiando un UUID producen el MISMO fingerprint", () => {
    const a = fingerprintEvent(
      ev({ metadata: { error: "FK row 550e8400-e29b-41d4-a716-446655440000" } }),
    );
    const b = fingerprintEvent(
      ev({ metadata: { error: "FK row aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } }),
    );
    expect(a).toBe(b);
  });

  it("acción distinta → fingerprint distinto aunque el mensaje sea el mismo", () => {
    const a = fingerprintEvent(ev({ action: "a", metadata: { error: "x" } }));
    const b = fingerprintEvent(ev({ action: "b", metadata: { error: "x" } }));
    expect(a).not.toBe(b);
  });

  it("eventos sin metadata útil agrupan por action+category solamente", () => {
    const a = fingerprintEvent(ev({ action: "a", category: "c", metadata: null }));
    const b = fingerprintEvent(ev({ action: "a", category: "c", metadata: { code: 500 } }));
    expect(a).toBe(b);
    expect(a).toBe("a::c::");
  });
});

// ── groupEvents ─────────────────────────────────────────────────────

describe("groupEvents", () => {
  it("agrupa eventos con el mismo fingerprint", () => {
    const events: ErrorEventLike[] = [
      ev({ id: "1", action: "a", metadata: { error: "boom 12345678" } }),
      ev({ id: "2", action: "a", metadata: { error: "boom 87654321" } }),
      ev({ id: "3", action: "b", metadata: { error: "boom 12345678" } }),
    ];
    const groups = groupEvents(events);
    expect(groups).toHaveLength(2);
    const g1 = groups.find((g) => g.action === "a")!;
    expect(g1.count).toBe(2);
    expect(g1.events.map((e) => e.id).sort()).toEqual(["1", "2"]);
  });

  it("cuenta estados por grupo", () => {
    const events: ErrorEventLike[] = [
      ev({ id: "1", status: "nuevo" }),
      ev({ id: "2", status: "nuevo" }),
      ev({ id: "3", status: "resuelto" }),
    ];
    const [g] = groupEvents(events);
    expect(g.statusCounts).toEqual({ nuevo: 2, revisando: 0, resuelto: 1, ignorado: 0 });
  });

  it("firstSeen / lastSeen reflejan los extremos temporales", () => {
    const events: ErrorEventLike[] = [
      ev({ id: "1", created_at: "2026-05-02T10:00:00Z" }),
      ev({ id: "2", created_at: "2026-05-01T08:00:00Z" }),
      ev({ id: "3", created_at: "2026-05-03T12:00:00Z" }),
    ];
    const [g] = groupEvents(events);
    expect(g.firstSeen).toBe("2026-05-01T08:00:00Z");
    expect(g.lastSeen).toBe("2026-05-03T12:00:00Z");
  });

  it("ordena grupos por lastSeen desc (los más recientes primero)", () => {
    const events: ErrorEventLike[] = [
      ev({ id: "old", action: "viejo", created_at: "2026-01-01T00:00:00Z" }),
      ev({ id: "new", action: "nuevo", created_at: "2026-06-01T00:00:00Z" }),
    ];
    const groups = groupEvents(events);
    expect(groups[0].action).toBe("nuevo");
    expect(groups[1].action).toBe("viejo");
  });

  it("ordena los eventos DENTRO del grupo por created_at desc", () => {
    const events: ErrorEventLike[] = [
      ev({ id: "old", created_at: "2026-01-01T00:00:00Z" }),
      ev({ id: "mid", created_at: "2026-03-01T00:00:00Z" }),
      ev({ id: "new", created_at: "2026-06-01T00:00:00Z" }),
    ];
    const [g] = groupEvents(events);
    expect(g.events.map((e) => e.id)).toEqual(["new", "mid", "old"]);
  });

  it("devuelve [] para input vacío", () => {
    expect(groupEvents([])).toEqual([]);
  });

  it("toma sampleMessage del primer evento procesado, o del siguiente con mensaje real", () => {
    const events: ErrorEventLike[] = [
      ev({ id: "1", metadata: null }), // sin mensaje
      ev({ id: "2", metadata: { error: "real msg" } }),
    ];
    const [g] = groupEvents(events);
    expect(g.sampleMessage).toBe("real msg");
  });
});

// ── aggregateGroupStatus ────────────────────────────────────────────

describe("aggregateGroupStatus", () => {
  it("nuevo gana sobre cualquier otro", () => {
    expect(aggregateGroupStatus({ nuevo: 1, revisando: 5, resuelto: 3, ignorado: 2 })).toBe(
      "nuevo",
    );
  });

  it("revisando gana si no hay nuevo", () => {
    expect(aggregateGroupStatus({ nuevo: 0, revisando: 1, resuelto: 3, ignorado: 2 })).toBe(
      "revisando",
    );
  });

  it("resuelto si solo hay resueltos + ignorados", () => {
    expect(aggregateGroupStatus({ nuevo: 0, revisando: 0, resuelto: 1, ignorado: 2 })).toBe(
      "resuelto",
    );
  });

  it("ignorado si todo está ignorado o todo en 0", () => {
    expect(aggregateGroupStatus({ nuevo: 0, revisando: 0, resuelto: 0, ignorado: 3 })).toBe(
      "ignorado",
    );
    expect(aggregateGroupStatus({ nuevo: 0, revisando: 0, resuelto: 0, ignorado: 0 })).toBe(
      "ignorado",
    );
  });
});

/**
 * Casos sacados de eventos REALES de producción (auditoría del 2026-09-04).
 *
 * Los tres se veían mal en el panel de Errores y ninguno estaba clasificado: dos acciones
 * salían como «(sin mensaje)» aunque el motivo estaba en el registro, y un mismo rechazo de
 * SMTP se partía en decenas de grupos por el id de sesión que Gmail agrega al final.
 */
describe("errores reales que el panel no sabía mostrar", () => {
  it("saca el motivo de `error_message` (lo escribe bulk-import-users)", () => {
    // 64 fallos de importación en un mes se veían como «(sin mensaje)» con el
    // motivo ahí mismo.
    expect(
      errorMessage({
        email: "alguien@estudiante.uniajc.edu.co",
        error_name: "Error",
        error_message: "No se pudo asignar el rol Estudiante: Cuota de estudiantes alcanzada (100 / 100).",
      }),
    ).toMatch(/Cuota de estudiantes alcanzada/);
  });

  it("sintetiza una etiqueta con `kind` + `http_status` cuando no hay mensaje", () => {
    // `ai.grading_failed` no guarda un mensaje: guarda el tipo de falla. Sin esto,
    // un 429 de cuota y un modelo que no emite tool_call caían en el mismo grupo
    // mudo, y son dos problemas distintos con dos respuestas distintas.
    expect(errorMessage({ kind: "http", http_status: 429, scope: "batch" })).toBe("http (HTTP 429)");
    expect(errorMessage({ kind: "no_tool_call", scope: "batch" })).toBe("no_tool_call");
  });

  it("un mensaje de verdad le gana a la etiqueta sintetizada", () => {
    // El metadata de correo trae `kind` (el tipo de notificación) Y `error`. Si
    // ganara `kind`, todos los fallos de correo dirían "report_signature".
    expect(errorMessage({ kind: "report_signature", error: "Gateway Timeout" })).toBe(
      "Gateway Timeout",
    );
  });

  it("dos rechazos de la MISMA credencial SMTP dan el mismo fingerprint", () => {
    const rechazo = (sesion: string) =>
      `535: 5.7.8 Username and Password not accepted. For more information, go to,5.7.8 https://support.google.com/mail/?p=BadCredentials ${sesion} - gsmtp`;
    expect(normalizeErrorMessage(rechazo("af79cd13be357-93749abeba9sm605545185a.3"))).toBe(
      normalizeErrorMessage(rechazo("d75a77b69052e-52e09aae6f4sm50954461cf.3")),
    );
  });

  it("pero NO junta dos códigos HTTP distintos", () => {
    // La regla de arriba no puede llevarse por delante la distinción entre un 429
    // (que se reintenta solo) y un 503 (que es del proveedor).
    expect(normalizeErrorMessage("fallo del proveedor HTTP 429")).not.toBe(
      normalizeErrorMessage("fallo del proveedor HTTP 503"),
    );
  });
});
