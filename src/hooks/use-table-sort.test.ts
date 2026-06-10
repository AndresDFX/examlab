import { describe, expect, it, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTableSort } from "./use-table-sort";

interface Row {
  name: string;
  count: number;
  date: string | null;
}

const ROWS: Row[] = [
  { name: "Taller 10", count: 3, date: "2026-01-10" },
  { name: "taller 2", count: 30, date: null },
  { name: "Álvaro", count: 3, date: "2026-03-01" },
  { name: "banana", count: 1, date: "2026-02-15" },
];

const COLUMNS = {
  name: (r: Row) => r.name,
  count: (r: Row) => r.count,
  date: (r: Row) => r.date,
};

describe("useTableSort", () => {
  beforeEach(() => {
    if (typeof window !== "undefined") window.localStorage.clear();
  });

  it("sin sortKey devuelve el array tal cual", () => {
    const { result } = renderHook(() => useTableSort(ROWS, { columns: COLUMNS }));
    expect(result.current.sorted).toEqual(ROWS);
    expect(result.current.sortKey).toBeNull();
  });

  it("respeta defaultSort (asc) al montar", () => {
    const { result } = renderHook(() =>
      useTableSort(ROWS, { columns: COLUMNS, defaultSort: { key: "name", dir: "asc" } }),
    );
    expect(result.current.sortKey).toBe("name");
    expect(result.current.sortDir).toBe("asc");
    // collation es-CO: numeric (Taller 2 < Taller 10), case/acentos-insensible
    expect(result.current.sorted.map((r) => r.name)).toEqual([
      "Álvaro",
      "banana",
      "taller 2",
      "Taller 10",
    ]);
  });

  it("toggle en la misma columna alterna asc → desc", () => {
    const { result } = renderHook(() =>
      useTableSort(ROWS, { columns: COLUMNS, defaultSort: { key: "count", dir: "asc" } }),
    );
    expect(result.current.sorted.map((r) => r.count)).toEqual([1, 3, 3, 30]);
    act(() => result.current.toggleSort("count"));
    expect(result.current.sortDir).toBe("desc");
    expect(result.current.sorted.map((r) => r.count)).toEqual([30, 3, 3, 1]);
  });

  it("toggle en columna nueva arranca en asc", () => {
    const { result } = renderHook(() =>
      useTableSort(ROWS, { columns: COLUMNS, defaultSort: { key: "name", dir: "desc" } }),
    );
    act(() => result.current.toggleSort("count"));
    expect(result.current.sortKey).toBe("count");
    expect(result.current.sortDir).toBe("asc");
  });

  it("nulls/vacíos van al final en asc Y en desc", () => {
    const { result } = renderHook(() =>
      useTableSort(ROWS, { columns: COLUMNS, defaultSort: { key: "date", dir: "asc" } }),
    );
    // El row con date=null ("taller 2") debe quedar último en asc
    expect(result.current.sorted[result.current.sorted.length - 1].name).toBe("taller 2");
    act(() => result.current.toggleSort("date")); // desc
    // ...y también último en desc (no tener fecha no debe "ganar")
    expect(result.current.sorted[result.current.sorted.length - 1].name).toBe("taller 2");
  });

  it("orden estable: empates preservan el orden de entrada", () => {
    // count=3 aparece en "Taller 10" (idx 0) y "Álvaro" (idx 2). Al ordenar
    // por count asc, deben quedar en ese orden relativo.
    const { result } = renderHook(() =>
      useTableSort(ROWS, { columns: COLUMNS, defaultSort: { key: "count", dir: "asc" } }),
    );
    const threes = result.current.sorted.filter((r) => r.count === 3).map((r) => r.name);
    expect(threes).toEqual(["Taller 10", "Álvaro"]);
  });

  it("persiste columna+dirección en localStorage por storageKey", () => {
    const { result, rerender } = renderHook(() =>
      useTableSort(ROWS, { columns: COLUMNS, storageKey: "examlab_sort:test" }),
    );
    act(() => result.current.toggleSort("count"));
    rerender();
    const raw = window.localStorage.getItem("examlab_sort:test");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual({ key: "count", dir: "asc" });
  });

  it("resetKey refleja la columna+dirección activas", () => {
    const { result } = renderHook(() =>
      useTableSort(ROWS, { columns: COLUMNS, defaultSort: { key: "name", dir: "asc" } }),
    );
    expect(result.current.resetKey).toBe("name:asc");
    act(() => result.current.toggleSort("name"));
    expect(result.current.resetKey).toBe("name:desc");
  });
});
