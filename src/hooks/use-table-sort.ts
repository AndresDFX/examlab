/**
 * useTableSort — ordenamiento CLIENT-SIDE de un array por columna, con
 * toggle ascendente/descendente desde el encabezado del grid.
 *
 * Convención del design system: TODO grid de listado (Usuarios, Cursos,
 * Exámenes, Talleres, etc.) debe poder ordenarse por sus columnas
 * principales clicando el encabezado. Este hook + el componente
 * `<SortableHead>` (en components/ui/table.tsx) son la pieza estándar.
 *
 * Flujo típico en un grid (el orden va ENTRE el filtro y la paginación):
 *
 *   const filtered = useMemo(() => filterRows(rows, search, ...), [...]);
 *   const sort = useTableSort(filtered, {
 *     columns: {
 *       name: (r) => r.name,
 *       created_at: (r) => r.created_at,      // ISO string o Date
 *       enrolled: (r) => r.enrolled_count,    // number
 *     },
 *     defaultSort: { key: "name", dir: "asc" },
 *     storageKey: "examlab_sort:admin_users",
 *   });
 *   const pag = usePagination(sort.sorted, {
 *     resetKey: `${search}|${sort.resetKey}`,  // re-ordenar vuelve a pág 1
 *     ...
 *   });
 *   // En el thead:
 *   <SortableHead sortKey="name" sort={sort}>Nombre</SortableHead>
 *
 * IMPORTANTE: `useMultiSelect` debe seguir operando sobre el array
 * filtrado+ordenado COMPLETO (sort.sorted), NO sobre la página, para que
 * "seleccionar todo" abarque todo el set visible.
 *
 * Persistencia: la columna + dirección se persisten en localStorage por
 * `storageKey` (opcional), igual que usePagination. Sin storageKey,
 * sesión-only. Mismo patrón de lectura en el initializer que usePagination
 * (useMemo + useState) para mantener consistencia entre los grids.
 *
 * Comparación: locale es-CO con `numeric:true` (así "Taller 2" < "Taller
 * 10") y `sensitivity:"base"` (case/acentos-insensible). Números y fechas
 * se comparan numéricamente. Los valores null/undefined van SIEMPRE al
 * final, sin importar la dirección (no tener dato no debería "ganar" el
 * primer lugar al ordenar descendente). El orden es ESTABLE: empates
 * preservan el orden original del array de entrada.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type SortDir = "asc" | "desc";

/** Valor comparable que puede devolver un accessor de columna. */
export type SortValue = string | number | boolean | Date | null | undefined;

export interface UseTableSortOptions<T> {
  /** Mapa columnKey → accessor que devuelve el valor comparable de la fila. */
  columns: Record<string, (row: T) => SortValue>;
  /** Orden inicial cuando no hay nada persistido. */
  defaultSort?: { key: string; dir: SortDir };
  /** Clave de localStorage para recordar columna+dirección entre visitas. */
  storageKey?: string;
}

/** Estado del orden que consume `<SortableHead>`. */
export interface TableSortState {
  sortKey: string | null;
  sortDir: SortDir;
  /** Click en un encabezado: misma columna alterna asc↔desc; columna
   *  nueva arranca en asc. */
  toggleSort: (key: string) => void;
  /** Fingerprint `key:dir` para pasar al `resetKey` de usePagination. */
  resetKey: string;
}

export interface UseTableSortResult<T> extends TableSortState {
  /** El array de entrada ordenado según la columna+dirección activas. */
  sorted: T[];
}

interface PersistedSort {
  key: string | null;
  dir: SortDir;
}

function readPersisted(storageKey?: string): PersistedSort | null {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedSort>;
    if ((typeof parsed.key === "string" || parsed.key === null) && (parsed.dir === "asc" || parsed.dir === "desc")) {
      return { key: parsed.key ?? null, dir: parsed.dir };
    }
  } catch {
    /* corrupto — ignorar */
  }
  return null;
}

function isEmpty(v: SortValue): boolean {
  return v === null || v === undefined || v === "";
}

/** Comparador de valores NO vacíos: números/fechas numérico, strings con
 *  collation es-CO (numeric + base). El manejo de null/vacío NO va acá —
 *  vive en el sort, fuera de la negación por dirección, para que los
 *  vacíos queden al final tanto en asc como en desc. */
function compareNonEmpty(a: SortValue, b: SortValue): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  return String(a).localeCompare(String(b), "es-CO", { numeric: true, sensitivity: "base" });
}

export function useTableSort<T>(items: T[], opts: UseTableSortOptions<T>): UseTableSortResult<T> {
  const { columns, defaultSort, storageKey } = opts;

  // Estado inicial: persistido o default. Solo se lee localStorage en el
  // initializer (mismo patrón que usePagination) para no fragmentar UX.
  const initial = useMemo<PersistedSort>(() => {
    const persisted = readPersisted(storageKey);
    if (persisted) return persisted;
    return { key: defaultSort?.key ?? null, dir: defaultSort?.dir ?? "asc" };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const [sortKey, setSortKey] = useState<string | null>(initial.key);
  const [sortDir, setSortDir] = useState<SortDir>(initial.dir);

  // `columns` se recrea en cada render (objeto literal). Lo guardamos en un
  // ref para no meterlo en las deps del useMemo de orden (evita re-sort por
  // identidad nueva del objeto). Los accessors de un grid son puros field
  // getters, así que leer la versión actual del ref es seguro.
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const toggleSort = useCallback((key: string) => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return prevKey;
      }
      setSortDir("asc");
      return key;
    });
  }, []);

  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ key: sortKey, dir: sortDir }));
    } catch {
      /* quota / private mode — ignorar */
    }
  }, [storageKey, sortKey, sortDir]);

  const sorted = useMemo(() => {
    const accessor = sortKey ? columnsRef.current[sortKey] : undefined;
    if (!accessor) return items;
    // Decorate-sort-undecorate para estabilidad: el índice original
    // desempata para preservar el orden de entrada en valores iguales.
    const decorated = items.map((row, i) => [row, i] as const);
    decorated.sort((x, y) => {
      const av = accessor(x[0]);
      const bv = accessor(y[0]);
      // Vacíos SIEMPRE al final, independiente de la dirección.
      const ae = isEmpty(av);
      const be = isEmpty(bv);
      if (ae && be) return x[1] - y[1];
      if (ae) return 1;
      if (be) return -1;
      const c = compareNonEmpty(av, bv);
      if (c !== 0) return sortDir === "asc" ? c : -c;
      return x[1] - y[1];
    });
    return decorated.map((d) => d[0]);
  }, [items, sortKey, sortDir]);

  return {
    sorted,
    sortKey,
    sortDir,
    toggleSort,
    resetKey: `${sortKey ?? ""}:${sortDir}`,
  };
}
