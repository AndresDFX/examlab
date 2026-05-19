import { describe, expect, it } from "vitest";
import { INTEGRITY_ALERT_THRESHOLD, computeIntegritySuggestion } from "./integrity";

describe("INTEGRITY_ALERT_THRESHOLD", () => {
  it("vale 0.6 (sincronizado con detect-plagiarism + ai_detected)", () => {
    expect(INTEGRITY_ALERT_THRESHOLD).toBe(0.6);
  });
});

describe("computeIntegritySuggestion", () => {
  it("retorna null cuando no hay señales sobre el umbral", () => {
    expect(computeIntegritySuggestion(5, 0.3, 0.5)).toBeNull();
    expect(computeIntegritySuggestion(5, null, null)).toBeNull();
    expect(computeIntegritySuggestion(5, 0.59, 0.59)).toBeNull();
  });

  it("retorna null si currentGrade es null", () => {
    expect(computeIntegritySuggestion(null, 0.8, null)).toBeNull();
  });

  it("aplica formula nota × (1 - severidad) cuando IA supera umbral", () => {
    // 4.5 × (1 - 0.6) = 1.8
    expect(computeIntegritySuggestion(4.5, 0.6, null)).toEqual({
      severity: 0.6,
      suggested: 1.8,
      source: "ai",
    });
  });

  it("aplica formula con max(ia, plagio) cuando solo plagio supera umbral", () => {
    // 5 × (1 - 0.7) = 1.5
    expect(computeIntegritySuggestion(5, 0.3, 0.7)).toEqual({
      severity: 0.7,
      suggested: 1.5,
      source: "plagio",
    });
  });

  it("toma el max cuando ambas señales superan umbral", () => {
    // max(0.85, 0.6) = 0.85; 4 × (1 - 0.85) = 0.6
    expect(computeIntegritySuggestion(4, 0.85, 0.6)).toEqual({
      severity: 0.85,
      suggested: 0.6,
      source: "ambas",
    });
  });

  it("clampa a 0 cuando severidad es 1.0 (100% IA)", () => {
    // 4.5 × (1 - 1.0) = 0
    expect(computeIntegritySuggestion(4.5, 1.0, null)).toEqual({
      severity: 1,
      suggested: 0,
      source: "ai",
    });
  });

  it("redondea suggested a 2 decimales", () => {
    // 4.5 × (1 - 0.85) = 4.5 × 0.15 = 0.675 → 0.68 (toFixed(2))
    const r = computeIntegritySuggestion(4.5, 0.85, null);
    expect(r?.suggested).toBe(0.68);
  });

  it("nota 0 → sugerencia 0", () => {
    expect(computeIntegritySuggestion(0, 0.9, null)).toEqual({
      severity: 0.9,
      suggested: 0,
      source: "ai",
    });
  });

  it("ignora plagio bajo umbral cuando IA sí supera", () => {
    // IA 0.7 cuenta; plagio 0.3 NO cuenta → source: "ai", no "ambas"
    expect(computeIntegritySuggestion(5, 0.7, 0.3)).toEqual({
      severity: 0.7,
      suggested: 1.5,
      source: "ai",
    });
  });
});
