/**
 * El camino INMEDIATO (processing_mode='sync' o código "IA inmediata") debe
 * dejar un registro durable en `ai_grading_queue` ANTES de trabajar, y
 * despachar por el worker.
 *
 * Bug de campo que esto previene (tenant FESNA, 2026-07): el camino sync
 * llamaba al edge directo, sin fila en la cola. Cuando esa llamada moría
 * —red, timeout, el docente navegando— el trabajo se perdía sin nada que
 * reintentar: quedaban `ai.grading_started` en `audit_logs` sin ningún evento
 * de cierre, y la cola vacía. Un batch entero podía evaporarse en silencio.
 *
 * Lo que se fija acá:
 *   1. el ORDEN (encolar → despachar). Es la garantía real: si el proceso
 *      muere entre ambos pasos, la fila ya existe y queda reprocesable.
 *   2. que el despacho vaya por `ai-grading-worker`, no al edge directo — el
 *      worker corre con service_role y es el único que puede CERRAR el job
 *      (`complete_ai_grading` está revocada para `authenticated`).
 *   3. que `ranSync` siga siendo true, porque los callers lo usan para decidir
 *      si avisarle al alumno "quedó en cola".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Registro de llamadas en orden, para poder afirmar la secuencia. */
const calls: string[] = [];
/** Respuesta del worker en el test en curso. */
let workerResult: { data: unknown; error: unknown } = {
  data: { ok: true, mode: "single", processed: 1, succeeded: 1, failed: 0 },
  error: null,
};
/** Respuesta del edge cuando se cae al camino viejo (encolado fallido). */
let edgeResult: { data: unknown; error: unknown } = { data: { grade: 4.5 }, error: null };
/** Qué devolverá `enqueue_ai_grading`. */
let enqueueResult: { data: unknown; error: unknown } = { data: "job-123", error: null };
/** `last_error` que expone la fila del job (para el caso failed). */
let lastError: string | null = null;

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (name: string) => {
      calls.push(`rpc:${name}`);
      if (name === "get_active_processing_mode") return Promise.resolve({ data: "sync", error: null });
      if (name === "enqueue_ai_grading") return Promise.resolve(enqueueResult);
      return Promise.resolve({ data: null, error: null });
    },
    functions: {
      invoke: (target: string) => {
        calls.push(`invoke:${target}`);
        return Promise.resolve(target === "ai-grading-worker" ? workerResult : edgeResult);
      },
    },
    from: (table: string) => {
      calls.push(`from:${table}`);
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: { last_error: lastError }, error: null }),
      };
      return chain;
    },
  },
}));

// Aislamos el parseo del error del edge: acá se testea el contrato de
// durabilidad, no cómo se extrae el mensaje.
vi.mock("@/shared/lib/edge-error", () => ({
  extractEdgeError: () => Promise.resolve("boom"),
}));

const { aiGradeOrEnqueue } = await import("./ai-grading");

const req = {
  kind: "workshop_full",
  body: { submissionId: "sub-1" },
  target: { table: "workshop_submissions", rowId: "sub-1", courseId: "course-1" },
} as const;

beforeEach(() => {
  calls.length = 0;
  lastError = null;
  workerResult = {
    data: { ok: true, mode: "single", processed: 1, succeeded: 1, failed: 0 },
    error: null,
  };
  edgeResult = { data: { grade: 4.5 }, error: null };
  enqueueResult = { data: "job-123", error: null };
});

describe("camino inmediato con job durable", () => {
  it("encola ANTES de despachar (si el proceso muere, el job sobrevive)", async () => {
    await aiGradeOrEnqueue(req);

    const iEnqueue = calls.indexOf("rpc:enqueue_ai_grading");
    const iDispatch = calls.indexOf("invoke:ai-grading-worker");
    expect(iEnqueue).toBeGreaterThanOrEqual(0);
    expect(iDispatch).toBeGreaterThanOrEqual(0);
    expect(iEnqueue).toBeLessThan(iDispatch);
  });

  it("despacha por el worker, NO al edge directo", async () => {
    await aiGradeOrEnqueue(req);
    // Sólo el worker puede cerrar el job (complete_ai_grading está revocada
    // para `authenticated`), así que llamar al edge acá dejaría el job vivo.
    expect(calls).toContain("invoke:ai-grading-worker");
    expect(calls).not.toContain("invoke:ai-grade-submission");
  });

  it("mantiene ranSync=true y devuelve el jobId", async () => {
    const res = await aiGradeOrEnqueue(req);
    expect(res.ranSync).toBe(true);
    expect(res.jobId).toBe("job-123");
    expect(res.error).toBeUndefined();
  });

  it("cuando el worker reporta failed, expone el motivo real del job", async () => {
    workerResult = {
      data: { ok: true, mode: "single", processed: 0, succeeded: 0, failed: 1 },
      error: null,
    };
    lastError = "429 rate limit";
    const res = await aiGradeOrEnqueue(req);
    expect(calls).toContain("from:ai_grading_queue");
    expect(res.error).toBe("429 rate limit");
    expect(res.jobId).toBe("job-123");
  });

  it("si el encolado falla, califica igual por el edge (no calificar es peor)", async () => {
    enqueueResult = { data: null, error: { message: "rls" } };
    const res = await aiGradeOrEnqueue(req);
    expect(calls).toContain("invoke:ai-grade-submission");
    expect(calls).not.toContain("invoke:ai-grading-worker");
    expect(res.ranSync).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.jobId).toBeUndefined();
  });

  it("modo async (sin override) NO despacha: solo encola", async () => {
    // Guard de que el cambio no convirtió la cola en "todo inmediato".
    const { resolveAiGateDecision } = await import("./ai-grading");
    expect(
      resolveAiGateDecision({ isAdmin: true, mode: "async", hasOverride: false, allowQueue: true }),
    ).toBe("proceed-async");
  });
});
