import { describe, it, expect } from "vitest";
import { groupCohortWeights, type CohortWeightRow } from "./cohort-weights";

const row = (p: Partial<CohortWeightRow>): CohortWeightRow => ({
  cohorte: "2025-1",
  kind: "exam",
  item_id: "i1",
  title: "Item",
  weight: 10,
  cut_name: "Corte 1",
  cut_position: 0,
  ...p,
});

describe("groupCohortWeights", () => {
  it("agrupa por cohorte y suma los pesos", () => {
    const out = groupCohortWeights([
      row({ cohorte: "A", item_id: "e1", title: "Parcial", weight: 15 }),
      row({ cohorte: "A", kind: "workshop", item_id: "w1", title: "Taller", weight: 10 }),
      row({ cohorte: "B", item_id: "e1", title: "Parcial", weight: 15 }),
    ]);
    expect(out).toHaveLength(2);
    const a = out.find((g) => g.cohorte === "A")!;
    expect(a.items).toHaveLength(2);
    expect(a.totalWeight).toBe(25);
    const b = out.find((g) => g.cohorte === "B")!;
    expect(b.items).toHaveLength(1);
    expect(b.totalWeight).toBe(15);
  });

  it("dedup por (cohorte,item) — no suma dos veces el mismo item", () => {
    const out = groupCohortWeights([
      row({ cohorte: "A", item_id: "e1", weight: 15 }),
      row({ cohorte: "A", item_id: "e1", weight: 15 }),
    ]);
    expect(out[0].items).toHaveLength(1);
    expect(out[0].totalWeight).toBe(15);
  });

  it("ignora cohortes vacías o solo espacios", () => {
    const out = groupCohortWeights([
      row({ cohorte: "" }),
      row({ cohorte: "   " }),
      row({ cohorte: "A", weight: 5 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].cohorte).toBe("A");
  });

  it("ordena cohortes con collation es-CO numérica", () => {
    const out = groupCohortWeights([
      row({ cohorte: "Cohorte 10" }),
      row({ cohorte: "Cohorte 2" }),
      row({ cohorte: "Cohorte 1" }),
    ]);
    expect(out.map((g) => g.cohorte)).toEqual(["Cohorte 1", "Cohorte 2", "Cohorte 10"]);
  });

  it("tolera weight como string o null (lo trata como número / 0)", () => {
    const out = groupCohortWeights([
      row({ cohorte: "A", item_id: "e1", weight: "12.5" as unknown as number }),
      row({ cohorte: "A", kind: "workshop", item_id: "w1", weight: null }),
    ]);
    expect(out[0].totalWeight).toBe(12.5);
    expect(out[0].items).toHaveLength(2);
  });

  it("redondea el total a 2 decimales", () => {
    const out = groupCohortWeights([
      row({ cohorte: "A", item_id: "e1", weight: 3.333 }),
      row({ cohorte: "A", kind: "workshop", item_id: "w1", weight: 3.333 }),
    ]);
    expect(out[0].totalWeight).toBe(6.67);
  });

  it("lista vacía → []", () => {
    expect(groupCohortWeights([])).toEqual([]);
  });
});
