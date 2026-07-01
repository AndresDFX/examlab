import { describe, expect, it, vi, beforeEach } from "vitest";

// Estado mockeado para idb-keyval. La librería usa IndexedDB que NO está
// disponible en jsdom, así que la simulamos con un Map en memoria. El
// fallback localStorage SÍ funciona en jsdom — lo usamos para verificar
// el branch "IndexedDB no disponible".
const idbStore = new Map<string, unknown>();
let idbBroken = false;

vi.mock("idb-keyval", () => ({
  get: vi.fn(async (k: string) => {
    if (idbBroken) throw new Error("idb broken");
    return idbStore.get(k);
  }),
  set: vi.fn(async (k: string, v: unknown) => {
    if (idbBroken) throw new Error("idb broken");
    idbStore.set(k, v);
  }),
  del: vi.fn(async (k: string) => {
    if (idbBroken) throw new Error("idb broken");
    idbStore.delete(k);
  }),
  keys: vi.fn(async () => {
    if (idbBroken) throw new Error("idb broken");
    return Array.from(idbStore.keys());
  }),
}));

// Mock chainable de supabase. `syncPendingAnswers` hace
// `.from().update().eq("id").eq("status","en_progreso").select("id")` y
// distingue "escribió 1 fila" (data.length>0 → cuenta como sincronizada) de
// "matcheó 0" (entrega ya no en_progreso → no cuenta, pero limpia el pending
// obsoleto). El resultado del `.select()` es configurable por test vía
// `vi.hoisted` (el factory de vi.mock se hoistea por encima de los `const`).
const mockSync = vi.hoisted(() => ({
  result: { data: [{ id: "sub-1" }] as Array<{ id: string }>, error: null as unknown },
}));
// Resultado del read de sesión que syncPendingAnswers hace ANTES del update
// (`.select("answers").eq("id",...).maybeSingle()`). Default: fila sin sesión →
// el guard anti-sobreescritura no dispara y se procede al update (comportamiento
// legacy). Un test lo configura para simular "otra sesión activa".
const mockServer = vi.hoisted(() => ({
  result: { data: null as { answers?: Record<string, unknown> } | null },
}));
vi.mock("@/integrations/supabase/client", () => {
  const makeChain = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      update: () => chain,
      select: () => chain,
      eq: () => chain,
      // Read del guard de sesión (terminal .maybeSingle()).
      maybeSingle: () => Promise.resolve(mockServer.result),
      // El update termina en `.select("id")` y se hace `await`: la cadena es
      // thenable y resuelve al resultado del update.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then: (resolve: (v: unknown) => unknown) => resolve(mockSync.result),
    };
    return chain;
  };
  return { supabase: { from: () => makeChain() } };
});

import {
  clearLocalAnswers,
  getPendingSyncs,
  isOnline,
  saveAnswersLocally,
  syncPendingAnswers,
  type PendingAnswer,
} from "./offline-sync";

beforeEach(() => {
  idbStore.clear();
  idbBroken = false;
  localStorage.clear();
  // Default: el UPDATE matcheó 1 fila (entrega en_progreso) → sync exitoso.
  mockSync.result = { data: [{ id: "sub-1" }], error: null };
  // Default: el read de sesión no encuentra otra sesión → guard no dispara.
  mockServer.result = { data: null };
});

describe("saveAnswersLocally / getPendingSyncs", () => {
  it("escribe en IndexedDB y lo lee de vuelta con el examId", async () => {
    const data: PendingAnswer = {
      submissionId: "sub-1",
      answers: { q1: "a", q2: "b" },
      warnings: 0,
      timestamp: 1700000000000,
    };
    await saveAnswersLocally("exam-1", data);
    const pending = await getPendingSyncs();
    expect(pending).toHaveLength(1);
    expect(pending[0].examId).toBe("exam-1");
    expect(pending[0].data.submissionId).toBe("sub-1");
    expect(pending[0].data.answers).toEqual({ q1: "a", q2: "b" });
  });

  it("usa la key 'pending-sync-<examId>'", async () => {
    await saveAnswersLocally("exam-XYZ", {
      submissionId: "s",
      answers: {},
      warnings: 0,
      timestamp: 0,
    });
    // Verificamos via idbStore directamente (interna al mock).
    expect(idbStore.has("pending-sync-exam-XYZ")).toBe(true);
  });

  it("cae a localStorage cuando IndexedDB falla", async () => {
    idbBroken = true;
    const data: PendingAnswer = {
      submissionId: "sub-2",
      answers: { x: 1 },
      warnings: 1,
      timestamp: 1,
    };
    await saveAnswersLocally("exam-2", data);
    const raw = localStorage.getItem("pending-sync-exam-2");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.submissionId).toBe("sub-2");
  });

  it("getPendingSyncs lee también del localStorage", async () => {
    // Simular fallback localStorage previo
    const data: PendingAnswer = {
      submissionId: "from-ls",
      answers: { z: 9 },
      warnings: 0,
      timestamp: 0,
    };
    localStorage.setItem("pending-sync-exam-ls", JSON.stringify(data));
    const pending = await getPendingSyncs();
    expect(pending.some((p) => p.examId === "exam-ls" && p.data.submissionId === "from-ls")).toBe(
      true,
    );
  });

  it("getPendingSyncs ignora claves de localStorage que NO tienen el prefijo", async () => {
    localStorage.setItem("otra-cosa", "valor");
    localStorage.setItem("pending-sync-real", JSON.stringify({ submissionId: "x" }));
    const pending = await getPendingSyncs();
    expect(pending.find((p) => p.examId === "real")).toBeTruthy();
    expect(pending.find((p) => p.examId === "otra-cosa")).toBeUndefined();
  });

  it("getPendingSyncs tolera localStorage con JSON inválido", async () => {
    localStorage.setItem("pending-sync-bad", "no-es-json{");
    const pending = await getPendingSyncs();
    // El JSON inválido es ignorado silenciosamente
    expect(pending.find((p) => p.examId === "bad")).toBeUndefined();
  });

  it("getPendingSyncs retorna [] cuando no hay nada", async () => {
    expect(await getPendingSyncs()).toEqual([]);
  });
});

describe("clearLocalAnswers", () => {
  it("borra del IndexedDB", async () => {
    await saveAnswersLocally("exam-1", {
      submissionId: "s",
      answers: {},
      warnings: 0,
      timestamp: 0,
    });
    expect(idbStore.has("pending-sync-exam-1")).toBe(true);
    await clearLocalAnswers("exam-1");
    expect(idbStore.has("pending-sync-exam-1")).toBe(false);
  });

  it("también borra del localStorage (cleanup defensivo)", async () => {
    localStorage.setItem("pending-sync-exam-9", "x");
    await clearLocalAnswers("exam-9");
    expect(localStorage.getItem("pending-sync-exam-9")).toBeNull();
  });

  it("no throwea cuando la key no existe", async () => {
    await expect(clearLocalAnswers("inexistente")).resolves.toBeUndefined();
  });
});

describe("isOnline", () => {
  it("usa navigator.onLine cuando existe", () => {
    // jsdom expone navigator.onLine = true por defecto
    expect(typeof isOnline()).toBe("boolean");
  });

  it("respeta el valor mockeado de navigator.onLine", () => {
    const spy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(isOnline()).toBe(false);
    spy.mockRestore();
  });
});

describe("syncPendingAnswers", () => {
  it("retorna 0 cuando no hay pendientes", async () => {
    expect(await syncPendingAnswers()).toBe(0);
  });

  it("borra del store tras sync exitoso (entrega en_progreso → 1 fila actualizada)", async () => {
    await saveAnswersLocally("exam-sync", {
      submissionId: "sub-1",
      answers: {},
      warnings: 0,
      timestamp: 0,
    });
    expect(idbStore.has("pending-sync-exam-sync")).toBe(true);
    const synced = await syncPendingAnswers();
    expect(synced).toBe(1);
    expect(idbStore.has("pending-sync-exam-sync")).toBe(false);
  });

  it("entrega que YA NO está en_progreso (0 filas): NO cuenta como sincronizada pero limpia el pending obsoleto", async () => {
    // El UPDATE con .eq('status','en_progreso') matcheó 0 filas → el .select('id')
    // devuelve []. La entrega ya fue enviada/cerrada: NO la sobreescribimos (no
    // suma al contador → sin toast espurio) pero limpiamos el pending para no
    // reintentarlo eternamente.
    mockSync.result = { data: [], error: null };
    await saveAnswersLocally("exam-stale", {
      submissionId: "sub-x",
      answers: {},
      warnings: 0,
      timestamp: 0,
    });
    const synced = await syncPendingAnswers();
    expect(synced).toBe(0);
    expect(idbStore.has("pending-sync-exam-stale")).toBe(false);
  });

  it("OTRA sesión activa en el servidor: descarta el pending sin sobreescribir", async () => {
    // El alumno reanudó en otro dispositivo (sesión "B"); el servidor tiene
    // answers.__session_id="B". Este pending local es de la sesión "A" → NO debe
    // pisar el estado de B. Se descarta (clear) y NO cuenta como sincronizado.
    mockServer.result = { data: { answers: { __session_id: "B" } } };
    await saveAnswersLocally("exam-othersession", {
      submissionId: "sub-a",
      answers: { __session_id: "A", q1: "viejo" },
      warnings: 0,
      timestamp: 0,
    });
    const synced = await syncPendingAnswers();
    expect(synced).toBe(0);
    expect(idbStore.has("pending-sync-exam-othersession")).toBe(false);
  });

  it("MISMA sesión: procede al update normal (sync exitoso)", async () => {
    mockServer.result = { data: { answers: { __session_id: "A" } } };
    await saveAnswersLocally("exam-samesession", {
      submissionId: "sub-a",
      answers: { __session_id: "A", q1: "nuevo" },
      warnings: 0,
      timestamp: 0,
    });
    const synced = await syncPendingAnswers();
    expect(synced).toBe(1);
    expect(idbStore.has("pending-sync-exam-samesession")).toBe(false);
  });

  it("error de red/DB: NO limpia el pending (se reintenta en el próximo online)", async () => {
    mockSync.result = { data: [], error: { message: "network error" } };
    await saveAnswersLocally("exam-err", {
      submissionId: "sub-e",
      answers: {},
      warnings: 0,
      timestamp: 0,
    });
    const synced = await syncPendingAnswers();
    expect(synced).toBe(0);
    // con error NO se limpia → sobrevive para reintentar
    expect(idbStore.has("pending-sync-exam-err")).toBe(true);
  });
});
