import { describe, expect, it } from "vitest";
import { optionFillPercent } from "./poll-results";

describe("optionFillPercent", () => {
  describe("slot (cupo por opción)", () => {
    it("cupo lleno 1/1 → 100% y full=true (la barra se ve COMPLETA, no 20%)", () => {
      // Reproduce el bug reportado: 5 respuestas en total, una opción 1/1.
      const r = optionFillPercent({
        pollType: "slot",
        responsesCount: 1,
        maxResponses: 1,
        totalResponses: 5,
      });
      expect(r.pct).toBe(100); // antes daba 20% (1/5)
      expect(r.full).toBe(true);
      expect(r.showPct).toBe(true);
    });

    it("cupo vacío 0/1 → 0% y full=false", () => {
      const r = optionFillPercent({
        pollType: "slot",
        responsesCount: 0,
        maxResponses: 1,
        totalResponses: 5,
      });
      expect(r.pct).toBe(0);
      expect(r.full).toBe(false);
    });

    it("cupo parcial 2/4 → 50%, no lleno", () => {
      const r = optionFillPercent({
        pollType: "slot",
        responsesCount: 2,
        maxResponses: 4,
        totalResponses: 9,
      });
      expect(r.pct).toBe(50);
      expect(r.full).toBe(false);
    });

    it("clamp a 100% si por alguna razón hay más respuestas que cupo (3/2)", () => {
      const r = optionFillPercent({
        pollType: "slot",
        responsesCount: 3,
        maxResponses: 2,
        totalResponses: 3,
      });
      expect(r.pct).toBe(100);
      expect(r.full).toBe(true);
    });

    it("sin cupo definido (max=null) → 0% y no muestra %", () => {
      const r = optionFillPercent({
        pollType: "slot",
        responsesCount: 1,
        maxResponses: null,
        totalResponses: 1,
      });
      expect(r.pct).toBe(0);
      expect(r.showPct).toBe(false);
    });
  });

  describe("single / multiple (cuota sobre el total)", () => {
    it("single 1/5 → 20% (cuota sobre el total), full=false", () => {
      const r = optionFillPercent({
        pollType: "single",
        responsesCount: 1,
        maxResponses: null,
        totalResponses: 5,
      });
      expect(r.pct).toBe(20);
      expect(r.full).toBe(false);
      expect(r.showPct).toBe(true);
    });

    it("multiple sin votos (total 0) → 0% y no muestra %", () => {
      const r = optionFillPercent({
        pollType: "multiple",
        responsesCount: 0,
        maxResponses: null,
        totalResponses: 0,
      });
      expect(r.pct).toBe(0);
      expect(r.showPct).toBe(false);
    });
  });
});
