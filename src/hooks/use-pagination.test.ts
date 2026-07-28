/**
 * Tests for usePagination — verifica el comportamiento crítico
 * (clamp, reset on filter change, page size change preserva contexto).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePagination } from "./use-pagination";

const seq = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

beforeEach(() => {
  // Cada test inicia con localStorage vacío (jsdom lo provee).
  if (typeof window !== "undefined") window.localStorage.clear();
});

describe("usePagination", () => {
  it("paginates an array correctly with default size", () => {
    const { result } = renderHook(() => usePagination(seq(60), { defaultPageSize: 25 }));
    expect(result.current.totalItems).toBe(60);
    expect(result.current.totalPages).toBe(3);
    expect(result.current.currentPage).toBe(1);
    expect(result.current.paginatedItems).toEqual(seq(25));
    expect(result.current.startIndex).toBe(1);
    expect(result.current.endIndex).toBe(25);
  });

  it("navigates to next page", () => {
    const { result } = renderHook(() => usePagination(seq(60), { defaultPageSize: 25 }));
    act(() => result.current.setCurrentPage(2));
    expect(result.current.currentPage).toBe(2);
    expect(result.current.paginatedItems[0]).toBe(26);
    expect(result.current.paginatedItems).toHaveLength(25);
    expect(result.current.endIndex).toBe(50);
  });

  it("last page may have fewer items than pageSize", () => {
    const { result } = renderHook(() => usePagination(seq(60), { defaultPageSize: 25 }));
    act(() => result.current.setCurrentPage(3));
    expect(result.current.paginatedItems).toHaveLength(10);
    expect(result.current.endIndex).toBe(60);
  });

  it("clamps setCurrentPage to valid range", () => {
    const { result } = renderHook(() => usePagination(seq(30), { defaultPageSize: 10 }));
    act(() => result.current.setCurrentPage(99));
    expect(result.current.currentPage).toBe(3);
    act(() => result.current.setCurrentPage(-5));
    expect(result.current.currentPage).toBe(1);
  });

  it("clamps current page down when items shrink", () => {
    const { result, rerender } = renderHook(
      ({ items }) => usePagination(items, { defaultPageSize: 10 }),
      {
        initialProps: { items: seq(100) },
      },
    );
    act(() => result.current.setCurrentPage(8));
    expect(result.current.currentPage).toBe(8);
    rerender({ items: seq(15) });
    // 15 items / 10 per page = 2 pages; clamp page 8 → 2
    expect(result.current.totalPages).toBe(2);
    expect(result.current.currentPage).toBe(2);
  });

  it("resets to page 1 when resetKey changes (filter applied)", () => {
    const { result, rerender } = renderHook(
      ({ items, key }) => usePagination(items, { defaultPageSize: 10, resetKey: key }),
      { initialProps: { items: seq(100), key: "filter-a" } },
    );
    act(() => result.current.setCurrentPage(5));
    expect(result.current.currentPage).toBe(5);
    // Cambia el filtro — debe volver a página 1.
    rerender({ items: seq(50), key: "filter-b" });
    expect(result.current.currentPage).toBe(1);
  });

  it("setPageSize keeps the first visible item in view", () => {
    const { result } = renderHook(() => usePagination(seq(100), { defaultPageSize: 10 }));
    act(() => result.current.setCurrentPage(3)); // items 21-30
    act(() => result.current.setPageSize(25)); // first visible (21) should be in page 1 (1-25)
    expect(result.current.pageSize).toBe(25);
    expect(result.current.currentPage).toBe(1);
    expect(result.current.paginatedItems).toContain(21);
  });

  it("pageSize=0 disables pagination", () => {
    const { result } = renderHook(() => usePagination(seq(100), { defaultPageSize: 0 }));
    expect(result.current.totalPages).toBe(1);
    expect(result.current.paginatedItems).toHaveLength(100);
    expect(result.current.endIndex).toBe(100);
  });

  it("handles empty list", () => {
    const { result } = renderHook(() => usePagination<number>([], { defaultPageSize: 25 }));
    expect(result.current.totalItems).toBe(0);
    expect(result.current.totalPages).toBe(1);
    expect(result.current.paginatedItems).toEqual([]);
    expect(result.current.startIndex).toBe(0);
    expect(result.current.endIndex).toBe(0);
  });

  it("persists page + pageSize across remount when storageKey provided", () => {
    const key = "test_pag_key";
    const { result, unmount } = renderHook(() =>
      usePagination(seq(100), { defaultPageSize: 10, storageKey: key }),
    );
    act(() => result.current.setCurrentPage(4));
    act(() => result.current.setPageSize(50));
    unmount();

    const { result: result2 } = renderHook(() =>
      usePagination(seq(100), { defaultPageSize: 10, storageKey: key }),
    );
    expect(result2.current.pageSize).toBe(50);
    // page 4 with old pageSize=10 → first visible was item 31 → with new size 50, page 1
    expect(result2.current.currentPage).toBe(1);
    expect(result2.current.paginatedItems).toContain(31);
  });

  // REGRESIÓN (hidratación / React #418): el PRIMER render NO debe leer
  // localStorage. Si lo hace, el árbol del cliente difiere del HTML
  // pre-renderizado (que no tiene localStorage) y React tira
  // "Minified React error #418". Se observó en producción en
  // /app/student/workshops (lista paginada con storageKey). El valor
  // persistido debe aplicarse recién DESPUÉS del mount.
  it("primer render usa el default determinista; el persistido llega post-mount", () => {
    const key = "test_pag_hydration";
    window.localStorage.setItem(key, JSON.stringify({ page: 3, pageSize: 50 }));

    const seen: Array<{ page: number; size: number }> = [];
    const { result } = renderHook(() => {
      const p = usePagination(seq(200), { defaultPageSize: 10, storageKey: key });
      seen.push({ page: p.currentPage, size: p.pageSize });
      return p;
    });

    // Primer render: default puro, SIN mirar localStorage.
    expect(seen[0]).toEqual({ page: 1, size: 10 });
    // Tras los efectos: el pageSize guardado ya está aplicado.
    expect(result.current.pageSize).toBe(50);
  });

  it("no pisa el valor guardado durante el primer commit", () => {
    const key = "test_pag_no_clobber";
    window.localStorage.setItem(key, JSON.stringify({ page: 2, pageSize: 100 }));
    renderHook(() => usePagination(seq(500), { defaultPageSize: 10, storageKey: key }));
    // El pageSize persistido sobrevive (no quedó sobreescrito por el default 10).
    expect(JSON.parse(window.localStorage.getItem(key)!).pageSize).toBe(100);
  });

  // El efecto de `resetKey` corre también al montar, así que pisaba la página
  // restaurada: el "recordar que estabas en la página 3" que documenta el hook
  // nunca se cumplía (solo se restauraba el pageSize). Con el guard de primera
  // ejecución, la página SÍ se restaura y el reset queda para cambios reales
  // de filtro.
  it("restaura la página guardada al montar, incluso pasando resetKey", () => {
    const key = "test_pag_restore_page";
    window.localStorage.setItem(key, JSON.stringify({ page: 3, pageSize: 10 }));
    const { result } = renderHook(() =>
      usePagination(seq(100), { defaultPageSize: 10, storageKey: key, resetKey: "filtro-inicial" }),
    );
    expect(result.current.currentPage).toBe(3);
    expect(result.current.paginatedItems[0]).toBe(21); // página 3 con size 10
  });

  it("un cambio REAL de resetKey (post-mount) sí vuelve a página 1", () => {
    const key = "test_pag_reset_after_mount";
    window.localStorage.setItem(key, JSON.stringify({ page: 3, pageSize: 10 }));
    const { result, rerender } = renderHook(
      ({ rk }: { rk: string }) =>
        usePagination(seq(100), { defaultPageSize: 10, storageKey: key, resetKey: rk }),
      { initialProps: { rk: "sin-filtro" } },
    );
    expect(result.current.currentPage).toBe(3); // restaurada
    rerender({ rk: "curso=abc" }); // el usuario aplica un filtro
    expect(result.current.currentPage).toBe(1);
  });

  it("clampea la página restaurada si quedó fuera de rango", () => {
    const key = "test_pag_restore_clamp";
    window.localStorage.setItem(key, JSON.stringify({ page: 9, pageSize: 10 }));
    // Solo 12 items → 2 páginas. La página 9 guardada debe clampearse.
    const { result } = renderHook(() =>
      usePagination(seq(12), { defaultPageSize: 10, storageKey: key, resetKey: "x" }),
    );
    expect(result.current.currentPage).toBe(2);
    expect(result.current.paginatedItems).toEqual([11, 12]);
  });
});
