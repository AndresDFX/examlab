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

  // El ciclo es asc → desc → DEFAULT. El tercer paso existe porque la mayoría
  // de los grids ordena por fecha de creación y NO tiene columna «Creado» (no
  // entra: varios ya están en el tope de 8 columnas). Sin él, clicar cualquier
  // encabezado dejaba el orden inicial fuera de alcance para siempre.
  it("tercer clic en la misma columna vuelve al orden por defecto", () => {
    const { result } = renderHook(() =>
      useTableSort(ROWS, { columns: COLUMNS, defaultSort: { key: "date", dir: "desc" } }),
    );
    expect(result.current.resetKey).toBe("date:desc");
    act(() => result.current.toggleSort("name"));
    expect(result.current.resetKey).toBe("name:asc");
    act(() => result.current.toggleSort("name"));
    expect(result.current.resetKey).toBe("name:desc");
    act(() => result.current.toggleSort("name"));
    expect(result.current.resetKey).toBe("date:desc"); // de vuelta al default
  });

  it("volver al default BORRA lo guardado, para que no resucite al volver", () => {
    const key = "test_sort_tercer_click_olvida";
    const { result } = renderHook(() =>
      useTableSort(ROWS, {
        columns: COLUMNS,
        defaultSort: { key: "date", dir: "desc" },
        storageKey: key,
      }),
    );
    act(() => result.current.toggleSort("name")); // asc
    act(() => result.current.toggleSort("name")); // desc
    expect(window.localStorage.getItem(key)).toBeTruthy();
    act(() => result.current.toggleSort("name")); // default
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("clicar una columna DISTINTA a mitad del ciclo arranca de nuevo en asc", () => {
    const { result } = renderHook(() =>
      useTableSort(ROWS, { columns: COLUMNS, defaultSort: { key: "date", dir: "desc" } }),
    );
    act(() => result.current.toggleSort("name"));
    act(() => result.current.toggleSort("name")); // name:desc
    act(() => result.current.toggleSort("count"));
    expect(result.current.resetKey).toBe("count:asc");
  });

  it("clicar la columna que YA es el default arranca el ciclo, no lo termina", () => {
    // Pasa en Usuarios, el único grid con la columna de creación visible: si el
    // primer clic cayera en la rama del «tercer clic», no haría nada visible.
    const { result } = renderHook(() =>
      useTableSort(ROWS, { columns: COLUMNS, defaultSort: { key: "date", dir: "desc" } }),
    );
    act(() => result.current.toggleSort("date"));
    expect(result.current.resetKey).toBe("date:asc");
  });

  // REGRESIÓN: ningún clic puede quedar MUERTO.
  //
  // Con el default en `desc` sobre la propia columna, «volver al default» da el
  // mismo estado que ya se ve, así que cerrar el ciclo ahí no cambiaba nada. Es
  // el caso de casi todas las grillas desde que ordenan por fecha de creación,
  // y el único grid con la columna «Creado» visible (Usuarios) lo exponía.
  it("con el default en desc sobre su propia columna, TODO clic cambia algo", () => {
    const { result } = renderHook(() =>
      useTableSort(ROWS, { columns: COLUMNS, defaultSort: { key: "date", dir: "desc" } }),
    );
    const vistos: string[] = [result.current.resetKey];
    for (let i = 0; i < 6; i++) {
      act(() => result.current.toggleSort("date"));
      vistos.push(result.current.resetKey);
    }
    // Alterna limpio, sin repetir dos veces seguidas.
    expect(vistos).toEqual([
      "date:desc",
      "date:asc",
      "date:desc",
      "date:asc",
      "date:desc",
      "date:asc",
      "date:desc",
    ]);
  });

  it("y tampoco queda muerto el primer clic tras hidratar el default guardado", () => {
    // Quien abrió la pantalla con el hook viejo tiene el default grabado, así
    // que hidrata con `elegido = true`. Sin la guarda, ESE primer clic moría.
    const key = "test_sort_sin_clic_muerto_hidratado";
    window.localStorage.setItem(key, JSON.stringify({ key: "date", dir: "desc" }));
    const { result } = renderHook(() =>
      useTableSort(ROWS, {
        columns: COLUMNS,
        defaultSort: { key: "date", dir: "desc" },
        storageKey: key,
      }),
    );
    expect(result.current.resetKey).toBe("date:desc");
    act(() => result.current.toggleSort("date"));
    expect(result.current.resetKey).toBe("date:asc");
  });

  it("resetKey refleja la columna+dirección activas", () => {
    const { result } = renderHook(() =>
      useTableSort(ROWS, { columns: COLUMNS, defaultSort: { key: "name", dir: "asc" } }),
    );
    expect(result.current.resetKey).toBe("name:asc");
    act(() => result.current.toggleSort("name"));
    expect(result.current.resetKey).toBe("name:desc");
  });

  // REGRESIÓN (hidratación / React #418): igual que usePagination — el PRIMER
  // render debe usar el defaultSort, sin leer localStorage; el orden guardado
  // se aplica después del mount.
  it("primer render usa el defaultSort; el orden guardado llega post-mount", () => {
    const key = "test_sort_hydration";
    window.localStorage.setItem(key, JSON.stringify({ key: "count", dir: "desc" }));

    const seen: Array<string | null> = [];
    const { result } = renderHook(() => {
      const s = useTableSort(ROWS, {
        columns: COLUMNS,
        defaultSort: { key: "name", dir: "asc" },
        storageKey: key,
      });
      seen.push(`${s.sortKey}:${s.sortDir}`);
      return s;
    });

    expect(seen[0]).toBe("name:asc"); // default determinista
    expect(`${result.current.sortKey}:${result.current.sortDir}`).toBe("count:desc"); // persistido
  });

  it("no pisa el orden guardado durante el primer commit", () => {
    const key = "test_sort_no_clobber";
    window.localStorage.setItem(key, JSON.stringify({ key: "count", dir: "desc" }));
    renderHook(() =>
      useTableSort(ROWS, {
        columns: COLUMNS,
        defaultSort: { key: "name", dir: "asc" },
        storageKey: key,
      }),
    );
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({ key: "count", dir: "desc" });
  });

  // REGRESIÓN: abrir un grid NO puede grabar su default.
  //
  // Antes lo grababa, y el efecto era que cambiar un `defaultSort` en el código
  // no le cambiaba nada a quien ya hubiera abierto ese grid alguna vez — el
  // valor guardado ganaba —. Peor: el cambio PARECÍA aplicado, porque en un
  // navegador limpio sí se veía. Con esto, un default nuevo llega a todos los
  // que nunca tocaron el encabezado.
  it("abrir el grid sin tocar nada NO graba el default", () => {
    const key = "test_sort_default_no_se_graba";
    const { rerender } = renderHook(() =>
      useTableSort(ROWS, {
        columns: COLUMNS,
        defaultSort: { key: "name", dir: "asc" },
        storageKey: key,
      }),
    );
    rerender();
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("pero lo que el usuario ELIGE sí se graba y sobrevive al remontaje", () => {
    const key = "test_sort_eleccion_se_graba";
    const { result, unmount } = renderHook(() =>
      useTableSort(ROWS, {
        columns: COLUMNS,
        defaultSort: { key: "name", dir: "asc" },
        storageKey: key,
      }),
    );
    act(() => result.current.toggleSort("count"));
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({ key: "count", dir: "asc" });
    unmount();

    const segunda = renderHook(() =>
      useTableSort(ROWS, {
        columns: COLUMNS,
        defaultSort: { key: "name", dir: "asc" },
        storageKey: key,
      }),
    );
    expect(`${segunda.result.current.sortKey}:${segunda.result.current.sortDir}`).toBe("count:asc");
  });
});
