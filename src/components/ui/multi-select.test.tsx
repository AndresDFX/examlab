import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMultiSelect } from "./multi-select";

type Item = { id: string; label: string };

const items: Item[] = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
  { id: "c", label: "C" },
];

describe("useMultiSelect — estado inicial", () => {
  it("comienza vacio", () => {
    const { result } = renderHook(() => useMultiSelect(items));
    expect(result.current.count).toBe(0);
    expect(result.current.allSelected).toBe(false);
    expect(result.current.indeterminate).toBe(false);
    expect(result.current.selectedIds.size).toBe(0);
  });

  it("isSelected devuelve false para todos al inicio", () => {
    const { result } = renderHook(() => useMultiSelect(items));
    for (const it of items) {
      expect(result.current.isSelected(it.id)).toBe(false);
    }
  });
});

describe("useMultiSelect — toggle individual", () => {
  it("toggle agrega id al set", () => {
    const { result } = renderHook(() => useMultiSelect(items));
    act(() => result.current.toggle("a"));
    expect(result.current.count).toBe(1);
    expect(result.current.isSelected("a")).toBe(true);
    expect(result.current.indeterminate).toBe(true);
  });

  it("toggle dos veces sobre el mismo id lo quita", () => {
    const { result } = renderHook(() => useMultiSelect(items));
    act(() => result.current.toggle("a"));
    act(() => result.current.toggle("a"));
    expect(result.current.count).toBe(0);
    expect(result.current.isSelected("a")).toBe(false);
  });
});

describe("useMultiSelect — toggleAll", () => {
  it("toggleAll desde vacio selecciona todos", () => {
    const { result } = renderHook(() => useMultiSelect(items));
    act(() => result.current.toggleAll());
    expect(result.current.count).toBe(3);
    expect(result.current.allSelected).toBe(true);
    expect(result.current.indeterminate).toBe(false);
  });

  it("toggleAll con todos seleccionados deselecciona todo", () => {
    const { result } = renderHook(() => useMultiSelect(items));
    act(() => result.current.toggleAll());
    act(() => result.current.toggleAll());
    expect(result.current.count).toBe(0);
    expect(result.current.allSelected).toBe(false);
  });

  it("toggleAll con seleccion parcial selecciona TODOS (no des-selecciona)", () => {
    const { result } = renderHook(() => useMultiSelect(items));
    act(() => result.current.toggle("a"));
    expect(result.current.count).toBe(1);
    expect(result.current.indeterminate).toBe(true);
    act(() => result.current.toggleAll());
    expect(result.current.count).toBe(3);
    expect(result.current.allSelected).toBe(true);
  });
});

describe("useMultiSelect — indeterminate", () => {
  it("indeterminate=true con seleccion parcial", () => {
    const { result } = renderHook(() => useMultiSelect(items));
    act(() => result.current.toggle("a"));
    act(() => result.current.toggle("b"));
    expect(result.current.indeterminate).toBe(true);
    expect(result.current.allSelected).toBe(false);
  });

  it("indeterminate=false cuando esta TODO seleccionado", () => {
    const { result } = renderHook(() => useMultiSelect(items));
    items.forEach((it) => act(() => result.current.toggle(it.id)));
    expect(result.current.indeterminate).toBe(false);
    expect(result.current.allSelected).toBe(true);
  });

  it("indeterminate=false cuando NADA esta seleccionado", () => {
    const { result } = renderHook(() => useMultiSelect(items));
    expect(result.current.indeterminate).toBe(false);
  });
});

describe("useMultiSelect — clear", () => {
  it("clear vacia la seleccion", () => {
    const { result } = renderHook(() => useMultiSelect(items));
    act(() => result.current.toggle("a"));
    act(() => result.current.toggle("b"));
    expect(result.current.count).toBe(2);
    act(() => result.current.clear());
    expect(result.current.count).toBe(0);
    expect(result.current.selectedIds.size).toBe(0);
  });
});

describe("useMultiSelect — setSelected", () => {
  it("setSelected reemplaza el set con una lista de ids", () => {
    const { result } = renderHook(() => useMultiSelect(items));
    act(() => result.current.setSelected(["a", "c"]));
    expect(result.current.count).toBe(2);
    expect(result.current.isSelected("a")).toBe(true);
    expect(result.current.isSelected("c")).toBe(true);
    expect(result.current.isSelected("b")).toBe(false);
  });

  it("setSelected con array vacio limpia", () => {
    const { result } = renderHook(() => useMultiSelect(items));
    act(() => result.current.setSelected(["a", "b"]));
    act(() => result.current.setSelected([]));
    expect(result.current.count).toBe(0);
  });
});

describe("useMultiSelect — count y selección visible", () => {
  it("count cuenta solo IDs de items visibles (ignora huérfanos)", () => {
    // Si un id no esta en items (ej. fue filtrado), no entra al count.
    const { result } = renderHook(() => useMultiSelect(items));
    act(() => result.current.setSelected(["a", "ghost"]));
    expect(result.current.count).toBe(1); // solo 'a' es visible
  });

  it("allSelected=false cuando items esta vacio", () => {
    const { result } = renderHook(() => useMultiSelect([] as Item[]));
    expect(result.current.allSelected).toBe(false);
  });
});
