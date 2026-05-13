import { describe, expect, it } from "vitest";
import {
  computeWorkshopAlerts,
  INTEGRITY_SIGNAL_THRESHOLD,
  type AiSignalLike,
  type CopyPairLike,
} from "./workshop-integrity-alerts";

describe("INTEGRITY_SIGNAL_THRESHOLD", () => {
  it("es 0.6 — match con el render por pregunta y el monitor de exámenes", () => {
    expect(INTEGRITY_SIGNAL_THRESHOLD).toBe(0.6);
  });
});

describe("computeWorkshopAlerts — vacío", () => {
  it("retorna todo 0 cuando no hay señales", () => {
    const out = computeWorkshopAlerts([], []);
    expect(out).toEqual({
      aiTotal: 0,
      aiPending: 0,
      copyTotal: 0,
      copyPending: 0,
      totalPending: 0,
      hasAny: false,
    });
  });
});

describe("computeWorkshopAlerts — IA solamente", () => {
  it("cuenta señales >= 0.6 y considera revisadas vs pendientes", () => {
    const ai: AiSignalLike[] = [
      { score: 0.85, reviewedAt: null }, // pendiente
      { score: 0.7, reviewedAt: "2026-05-13T00:00:00Z" }, // revisada
      { score: 0.65, reviewedAt: null }, // pendiente
    ];
    const out = computeWorkshopAlerts(ai, []);
    expect(out.aiTotal).toBe(3);
    expect(out.aiPending).toBe(2);
    expect(out.totalPending).toBe(2);
    expect(out.hasAny).toBe(true);
  });

  it("ignora señales por debajo del threshold", () => {
    const ai: AiSignalLike[] = [
      { score: 0.85, reviewedAt: null },
      { score: 0.3, reviewedAt: null }, // ruido
      { score: 0.59, reviewedAt: null }, // ruido (< 0.6 strict)
    ];
    const out = computeWorkshopAlerts(ai, []);
    expect(out.aiTotal).toBe(1);
    expect(out.aiPending).toBe(1);
  });

  it("threshold incluye exactamente 0.6", () => {
    const ai: AiSignalLike[] = [{ score: 0.6, reviewedAt: null }];
    expect(computeWorkshopAlerts(ai, []).aiTotal).toBe(1);
  });
});

describe("computeWorkshopAlerts — copia solamente", () => {
  it("cuenta pares >= 0.6 y separa revisados", () => {
    const pairs: CopyPairLike[] = [
      { score: 0.95, reviewedAt: null },
      { score: 0.8, reviewedAt: "2026-05-13T00:00:00Z" },
    ];
    const out = computeWorkshopAlerts([], pairs);
    expect(out.copyTotal).toBe(2);
    expect(out.copyPending).toBe(1);
    expect(out.totalPending).toBe(1);
    expect(out.hasAny).toBe(true);
  });

  it("ignora pares por debajo del threshold", () => {
    const pairs: CopyPairLike[] = [
      { score: 0.4, reviewedAt: null },
      { score: 0.55, reviewedAt: null },
    ];
    const out = computeWorkshopAlerts([], pairs);
    expect(out.copyTotal).toBe(0);
    expect(out.hasAny).toBe(false);
  });
});

describe("computeWorkshopAlerts — IA + copia combinadas", () => {
  it("totalPending suma ambas categorías", () => {
    const ai: AiSignalLike[] = [{ score: 0.8, reviewedAt: null }];
    const pairs: CopyPairLike[] = [
      { score: 0.9, reviewedAt: null },
      { score: 0.7, reviewedAt: null },
    ];
    const out = computeWorkshopAlerts(ai, pairs);
    expect(out.aiPending).toBe(1);
    expect(out.copyPending).toBe(2);
    expect(out.totalPending).toBe(3);
  });

  it("hasAny=true si tiene cualquier alerta (revisada o no)", () => {
    const ai: AiSignalLike[] = [{ score: 0.9, reviewedAt: "2026-05-13T00:00:00Z" }];
    const out = computeWorkshopAlerts(ai, []);
    expect(out.hasAny).toBe(true);
    expect(out.totalPending).toBe(0);
  });

  it("acepta iterables (Map.values()) no solo arrays", () => {
    // El caller real pasa los `.values()` del Map. Verificamos que el
    // helper acepta iterables sin asumir Array.
    const aiMap = new Map<string, AiSignalLike>([
      ["q1", { score: 0.9, reviewedAt: null }],
      ["q2", { score: 0.7, reviewedAt: null }],
    ]);
    const out = computeWorkshopAlerts(aiMap.values(), []);
    expect(out.aiPending).toBe(2);
  });
});
