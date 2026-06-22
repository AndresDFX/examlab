import { describe, expect, it } from "vitest";
import { examShuffleSeed, seededShuffle } from "./shuffle";

describe("seededShuffle — determinístico + estable + uniforme-ish", () => {
  const items = ["a", "b", "c", "d", "e", "f", "g", "h"];

  it("mismo seed → MISMO orden (estable entre recargas)", () => {
    const r1 = seededShuffle(items, "exam1:user1");
    const r2 = seededShuffle(items, "exam1:user1");
    expect(r1).toEqual(r2);
  });

  it("seeds distintos → órdenes (casi siempre) distintos", () => {
    const r1 = seededShuffle(items, "exam1:userA");
    const r2 = seededShuffle(items, "exam1:userB");
    expect(r1).not.toEqual(r2);
  });

  it("NO muta el arreglo de entrada", () => {
    const original = [...items];
    seededShuffle(items, "exam1:user1");
    expect(items).toEqual(original);
  });

  it("es una permutación (mismo conjunto de elementos)", () => {
    const r = seededShuffle(items, "exam1:user1");
    expect([...r].sort()).toEqual([...items].sort());
    expect(r).toHaveLength(items.length);
  });

  it("arreglo vacío / de 1 elemento → copia igual", () => {
    expect(seededShuffle([], "x")).toEqual([]);
    expect(seededShuffle(["solo"], "x")).toEqual(["solo"]);
  });

  it("preserva objetos por referencia (no clona elementos)", () => {
    const objs = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const r = seededShuffle(objs, "s");
    expect(r.every((o) => objs.includes(o))).toBe(true);
  });

  it("cobertura razonable: con muchos seeds las 24 permutaciones de 4 elementos aparecen", () => {
    const base = ["1", "2", "3", "4"];
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      seen.add(seededShuffle(base, `seed-${i}`).join(""));
    }
    // 4! = 24 permutaciones; un shuffle decente las cubre todas en 2000 tiros.
    expect(seen.size).toBe(24);
  });

  it("examShuffleSeed compone examId:userId", () => {
    expect(examShuffleSeed("E", "U")).toBe("E:U");
  });
});
