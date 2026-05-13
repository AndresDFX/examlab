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

// Mockeamos supabase. `syncPendingAnswers` solo se prueba en el branch
// donde NO hay nada que sincronizar (returns 0); para el caso con datos
// haría falta mockear el cliente — lo dejamos fuera de scope porque
// requiere mockear .from().update().eq() y nos llevaría a verificar el
// SDK más que la lógica.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => ({
      update: vi.fn(() => ({
        eq: vi.fn(async () => ({ error: null })),
      })),
    })),
  },
}));

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

  it("borra del store tras sync exitoso (mock supabase returns ok)", async () => {
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
});
