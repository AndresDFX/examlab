import { describe, expect, it, vi, beforeEach } from "vitest";

// Estado del mock: el último payload con el que se llamó a `.rpc()` y el
// resultado a devolver (para verificar el comportamiento fire-and-forget).
const mockState: {
  lastRpcName: string | null;
  lastRpcArgs: Record<string, unknown> | null;
  shouldReject: boolean;
} = {
  lastRpcName: null,
  lastRpcArgs: null,
  shouldReject: false,
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    // Devolvemos Promise real (PostgrestBuilder es thenable y se comporta
    // como promise nativa para la cadena .then().catch() del wrapper).
    rpc: vi.fn((name: string, args: Record<string, unknown>) => {
      mockState.lastRpcName = name;
      mockState.lastRpcArgs = args;
      return mockState.shouldReject
        ? Promise.reject(new Error("RPC simulated failure"))
        : Promise.resolve({ data: null, error: null });
    }),
  },
}));

import { logEvent } from "./audit";

beforeEach(() => {
  mockState.lastRpcName = null;
  mockState.lastRpcArgs = null;
  mockState.shouldReject = false;
});

describe("logEvent — payload mapping", () => {
  it("llama RPC 'log_audit_event' con todos los parámetros mapeados", async () => {
    await logEvent({
      action: "user.created",
      category: "user",
      severity: "warning",
      entityType: "user",
      entityId: "u-123",
      entityName: "Andre",
      courseId: "c-1",
      courseName: "Curso X",
      metadata: { foo: "bar" },
    });
    expect(mockState.lastRpcName).toBe("log_audit_event");
    expect(mockState.lastRpcArgs).toEqual({
      p_action: "user.created",
      p_category: "user",
      p_severity: "warning",
      p_entity_type: "user",
      p_entity_id: "u-123",
      p_entity_name: "Andre",
      p_course_id: "c-1",
      p_course_name: "Curso X",
      p_metadata: { foo: "bar" },
    });
  });

  it("severity defaultea a 'info' si no se pasa", async () => {
    await logEvent({ action: "x", category: "system" });
    expect(mockState.lastRpcArgs?.p_severity).toBe("info");
  });

  it("entityType/entityId/entityName/courseId/courseName defaultean a null", async () => {
    await logEvent({ action: "x", category: "system" });
    expect(mockState.lastRpcArgs?.p_entity_type).toBeNull();
    expect(mockState.lastRpcArgs?.p_entity_id).toBeNull();
    expect(mockState.lastRpcArgs?.p_entity_name).toBeNull();
    expect(mockState.lastRpcArgs?.p_course_id).toBeNull();
    expect(mockState.lastRpcArgs?.p_course_name).toBeNull();
  });

  it("metadata defaultea a objeto vacío {}", async () => {
    await logEvent({ action: "x", category: "system" });
    expect(mockState.lastRpcArgs?.p_metadata).toEqual({});
  });

  it("usa la key 'p_metadata' (no 'p_details') — fix del typo histórico", async () => {
    // Migration 20260509150000_audit_logs.sql usa `p_metadata`. Si volvemos
    // al typo `p_details`, la RPC tira 404 silenciosamente. Este test
    // bloquea esa regresión.
    await logEvent({ action: "x", category: "system", metadata: { k: "v" } });
    expect(mockState.lastRpcArgs).toHaveProperty("p_metadata");
    expect(mockState.lastRpcArgs).not.toHaveProperty("p_details");
  });
});

describe("logEvent — fire-and-forget", () => {
  it("NO lanza cuando la RPC falla (catch interno)", async () => {
    mockState.shouldReject = true;
    await expect(logEvent({ action: "x", category: "system" })).resolves.toBeUndefined();
  });

  it("devuelve void (la API no expone result del rpc)", async () => {
    const out = await logEvent({ action: "x", category: "system" });
    expect(out).toBeUndefined();
  });
});
