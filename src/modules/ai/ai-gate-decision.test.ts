import { describe, expect, it } from "vitest";
import { resolveAiGateDecision } from "./ai-grading";

/**
 * Invariante central: en modo BATCH (`async`) SIEMPRE se respeta la cola de
 * IA — nadie corre inline salvo modo global `sync` o un código "IA inmediata"
 * vigente. Incluye a Admin/SuperAdmin (antes se saltaban la cola en batch).
 */
describe("resolveAiGateDecision", () => {
  it("modo sync global → inline para todos", () => {
    for (const isAdmin of [true, false]) {
      for (const hasOverride of [true, false]) {
        expect(
          resolveAiGateDecision({ isAdmin, mode: "sync", hasOverride, allowQueue: true }),
        ).toBe("proceed-sync");
      }
    }
  });

  it("código 'IA inmediata' vigente → inline aunque el modo sea batch", () => {
    expect(
      resolveAiGateDecision({ isAdmin: false, mode: "async", hasOverride: true, allowQueue: true }),
    ).toBe("proceed-sync");
    expect(
      resolveAiGateDecision({ isAdmin: true, mode: "async", hasOverride: true, allowQueue: true }),
    ).toBe("proceed-sync");
  });

  it("BATCH + Admin sin código → ENCOLA (no corre inline) — el fix del bug", () => {
    expect(
      resolveAiGateDecision({ isAdmin: true, mode: "async", hasOverride: false, allowQueue: true }),
    ).toBe("proceed-async");
  });

  it("BATCH + Admin sin código + flujo sin cola → dialog (no salta la cola con inline)", () => {
    expect(
      resolveAiGateDecision({ isAdmin: true, mode: "async", hasOverride: false, allowQueue: false }),
    ).toBe("dialog");
  });

  it("BATCH + Docente sin código → dialog (cancelar / encolar / activar código)", () => {
    expect(
      resolveAiGateDecision({ isAdmin: false, mode: "async", hasOverride: false, allowQueue: true }),
    ).toBe("dialog");
    expect(
      resolveAiGateDecision({ isAdmin: false, mode: "async", hasOverride: false, allowQueue: false }),
    ).toBe("dialog");
  });

  it("NUNCA devuelve proceed-sync en batch sin override (la cola se respeta)", () => {
    for (const isAdmin of [true, false]) {
      for (const allowQueue of [true, false]) {
        const out = resolveAiGateDecision({
          isAdmin,
          mode: "async",
          hasOverride: false,
          allowQueue,
        });
        expect(out).not.toBe("proceed-sync");
      }
    }
  });
});
