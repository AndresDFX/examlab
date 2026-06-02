/**
 * usePagination — hook genérico de paginación CLIENT-SIDE sobre un array.
 *
 * Uso típico: el grid ya carga todos los items (acotados por RLS) y
 * queremos partir en páginas para no renderizar 500 filas a la vez. NO
 * para casos con server-side pagination — esos llevan su propio range().
 *
 *   const items = useMemo(() => filterAndSort(rawItems, ...), [...]);
 *   const pag = usePagination(items, { defaultPageSize: 25 });
 *   ...
 *   {pag.paginatedItems.map(...)}
 *   <DataPagination state={pag} />
 *
 * Persistencia: la página actual y el page size se persisten en
 * localStorage por `storageKey` (opcional). Sin storageKey, sesión-only.
 * Útil para que al volver a Usuarios el grid recuerde "última vez vi
 * 50/página y estaba en la página 3".
 *
 * Reset al filtrar: cuando el array de entrada cambia (length distinto
 * O un fingerprint distinto), volvemos a página 1 automáticamente. Sin
 * eso, filtrar "alumnos del curso X" en página 5 dejaba al usuario en
 * una página fuera de rango con grid vacío.
 *
 * Page size 0 / null: deshabilita paginación (devuelve todo). Útil para
 * "Ver todo" sin tener que cambiar la API del componente.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

/** Tamaños estándar disponibles en el selector. Usar estos por defecto
 *  para no fragmentar UX entre grids — si un grid necesita un set
 *  distinto, pasarlo via `pageSizes`. */
export const DEFAULT_PAGE_SIZES = [10, 25, 50, 100] as const;

export interface UsePaginationOptions {
  /** Tamaño de página inicial. Default 25 (balance entre denso y
   *  desplazable). */
  defaultPageSize?: number;
  /** Tamaños ofrecidos en el selector. Pasar [] para ocultar el
   *  selector y forzar un tamaño único. */
  pageSizes?: readonly number[];
  /** Clave de localStorage para persistir page + pageSize entre
   *  visitas. Recomendado usar `examlab_pag:<ruta-corta>`. Si se
   *  omite, no persiste. */
  storageKey?: string;
  /** Fingerprint de filtros activos. Cuando cambia, volvemos a página
   *  1. Pasa algo como `searchTerm + courseFilter + statusFilter` para
   *  que aplicar un filtro nuevo no deje al usuario en página 7 vacía. */
  resetKey?: string;
}

export interface PaginationState<T> {
  /** Subset del array original que cae en la página actual. */
  paginatedItems: T[];
  /** Página actual, 1-indexed. */
  currentPage: number;
  /** Setter — clampea automáticamente a [1, totalPages]. */
  setCurrentPage: (page: number) => void;
  /** Total de páginas. Mínimo 1 incluso si items=[]. */
  totalPages: number;
  /** Items por página activos. 0 = todos. */
  pageSize: number;
  /** Setter — al cambiar, recalcula la página actual para mantener el
   *  primer item visible (aproximadamente) dentro de la nueva ventana. */
  setPageSize: (size: number) => void;
  /** Total de items en el array de entrada (no en la página). */
  totalItems: number;
  /** Tamaños disponibles en el selector. */
  pageSizes: readonly number[];
  /** Índice del primer item visible (1-indexed) — útil para "Mostrando
   *  X-Y de Z". */
  startIndex: number;
  /** Índice del último item visible (1-indexed). */
  endIndex: number;
}

interface PersistedState {
  page: number;
  pageSize: number;
}

function readPersisted(storageKey?: string): PersistedState | null {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (typeof parsed.page === "number" && typeof parsed.pageSize === "number") {
      return { page: parsed.page, pageSize: parsed.pageSize };
    }
  } catch {
    /* corrupt entry — ignorar */
  }
  return null;
}

function writePersisted(storageKey: string | undefined, state: PersistedState) {
  if (!storageKey || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    /* quota / private mode — ignorar */
  }
}

export function usePagination<T>(items: T[], opts: UsePaginationOptions = {}): PaginationState<T> {
  const { defaultPageSize = 25, pageSizes = DEFAULT_PAGE_SIZES, storageKey, resetKey } = opts;

  // Estado inicial: leer persistido o usar default. Solo lee localStorage
  // dentro del initializer para no causar mismatches SSR/cliente.
  const initial = useMemo<PersistedState>(() => {
    const persisted = readPersisted(storageKey);
    if (persisted) return persisted;
    return { page: 1, pageSize: defaultPageSize };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const [currentPage, setCurrentPageRaw] = useState<number>(initial.page);
  const [pageSize, setPageSizeRaw] = useState<number>(initial.pageSize);

  const totalItems = items.length;
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(totalItems / pageSize)) : 1;

  // Clamp: si totalItems baja y currentPage queda fuera de rango,
  // ajustamos hacia abajo. Sin esto, filtrar de 100→3 items con page=5
  // dejaba el grid vacío.
  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPageRaw(totalPages);
    }
  }, [currentPage, totalPages]);

  // Reset a página 1 cuando cambia el set de filtros. Distinguimos esto
  // del clamp porque aplicar un filtro debe llevar al usuario al inicio
  // de los nuevos resultados (no a "la última página del nuevo set").
  useEffect(() => {
    setCurrentPageRaw(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // Persistencia: cada vez que page o pageSize cambia, escribimos.
  useEffect(() => {
    writePersisted(storageKey, { page: currentPage, pageSize });
  }, [storageKey, currentPage, pageSize]);

  const setCurrentPage = useCallback(
    (page: number) => {
      const clamped = Math.max(1, Math.min(page, totalPages));
      setCurrentPageRaw(clamped);
    },
    [totalPages],
  );

  const setPageSize = useCallback(
    (size: number) => {
      // Al cambiar el tamaño, intentamos mantener visible el primer item
      // de la página actual. Ej. estás en page=3 con size=10 (items
      // 21-30) y cambias a size=25 — deberías terminar en page=1
      // (items 1-25, incluye los anteriores).
      const firstVisibleIndex = (currentPage - 1) * pageSize;
      setPageSizeRaw(size);
      if (size > 0) {
        const newPage = Math.floor(firstVisibleIndex / size) + 1;
        setCurrentPageRaw(Math.max(1, newPage));
      } else {
        setCurrentPageRaw(1);
      }
    },
    [currentPage, pageSize],
  );

  const paginatedItems = useMemo(() => {
    if (pageSize <= 0) return items;
    const start = (currentPage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, currentPage, pageSize]);

  const startIndex = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endIndex = pageSize > 0 ? Math.min(currentPage * pageSize, totalItems) : totalItems;

  return {
    paginatedItems,
    currentPage,
    setCurrentPage,
    totalPages,
    pageSize,
    setPageSize,
    totalItems,
    pageSizes,
    startIndex,
    endIndex,
  };
}
