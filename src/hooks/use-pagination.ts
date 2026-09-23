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
 *
 * ── Lo seleccionado sube al principio (`selectedIds` + `getId`) ───────
 * En un grid con acciones masivas, la barra dice "4 seleccionados" y en
 * pantalla no hay ninguna casilla marcada: los cuatro quedaron en otras
 * páginas. Con estas dos opciones lo seleccionado se reordena al frente
 * de la lista, así que cae en la primera página y se VE.
 *
 * El reordenamiento NO es en vivo, y eso es lo importante: se congela un
 * snapshot de la selección y solo se refresca al CAMBIAR de página o de
 * tamaño de página. Reordenar en cada clic mueve la fila que la persona
 * acaba de tocar —y corre una posición a todas las de abajo—, así que
 * marcar cinco casillas seguidas termina marcando otras; el modo de falla
 * es peor que el problema que se arregla, y encima es silencioso. Marcar
 * dentro de la página que estás mirando no reordena nada (ahí ya ves la
 * casilla marcada, que es el objetivo); el subido ocurre al navegar, que
 * es exactamente cuando la selección se volvería invisible.
 *
 * Al vaciarse la selección el snapshot se limpia solo: un grid reordenado
 * sin nada marcado se lee como un orden roto.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Tamaños estándar disponibles en el selector. Usar estos por defecto
 *  para no fragmentar UX entre grids — si un grid necesita un set
 *  distinto, pasarlo via `pageSizes`. */
export const DEFAULT_PAGE_SIZES = [10, 25, 50, 100] as const;

/** Set vacío compartido: evita crear uno nuevo por render y que el memo del
 *  orden se invalide sin que haya cambiado nada. */
const SIN_SELECCION: ReadonlySet<string> = new Set<string>();

export interface UsePaginationOptions<T> {
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
  /** Ids seleccionados del grid (el `selectedIds` de `useMultiSelect`).
   *  Junto con `getId` activa el SUBIDO de lo seleccionado al principio
   *  de la lista — ver el bloque «Lo seleccionado sube al principio» en
   *  la cabecera de este archivo. Sin los dos, el orden no se toca. */
  selectedIds?: ReadonlySet<string>;
  /** Cómo sacar el id de un item. Obligatorio para que `selectedIds`
   *  tenga efecto; no se adivina `item.id` porque no todo grid lo tiene
   *  con ese nombre (la papelera arma su propia clave compuesta). */
  getId?: (item: T) => string;
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

export function usePagination<T>(items: T[], opts: UsePaginationOptions<T> = {}): PaginationState<T> {
  const {
    defaultPageSize = 25,
    pageSizes = DEFAULT_PAGE_SIZES,
    storageKey,
    resetKey,
    selectedIds,
    getId,
  } = opts;

  // Estado inicial DETERMINISTA (página 1 + default): NO se lee localStorage
  // acá. Leerlo en el primer render (initializer o useMemo) hace que el árbol
  // del cliente difiera del HTML pre-renderizado (que no tiene localStorage) →
  // `Minified React error #418` (hydration mismatch). Se observó en producción
  // en /app/student/workshops, una lista paginada con storageKey.
  // El valor persistido se aplica POST-MOUNT en el efecto de hidratación.
  const [currentPage, setCurrentPageRaw] = useState<number>(1);
  const [pageSize, setPageSizeRaw] = useState<number>(defaultPageSize);

  // Bandera de hidratación en ESTADO (no en ref) a propósito: el efecto de
  // escritura la mira para no correr en el primer commit. Con un ref, la
  // escritura del primer commit veía page=1/default y pisaba en localStorage el
  // valor que el usuario tenía guardado (aunque después se re-escribiera el
  // correcto, un unmount inmediato dejaba el default). React 18 agrupa este
  // setState con los de abajo → un solo re-render con todo aplicado.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const persisted = readPersisted(storageKey);
    if (persisted) {
      setCurrentPageRaw(persisted.page);
      setPageSizeRaw(persisted.pageSize);
    }
    setHydrated(true);
    // Solo al montar / si cambia la clave (cambio de vista).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // Snapshot congelado de la selección — ver «Lo seleccionado sube al
  // principio» arriba. Vive en estado (no en ref) porque el orden depende de
  // él y tiene que provocar re-render.
  const [idsArriba, setIdsArriba] = useState<ReadonlySet<string>>(SIN_SELECCION);

  // La selección más reciente, para leerla desde los setters sin que su
  // identidad los recree en cada render (`selectedIds` es un Set nuevo por
  // toggle y volvería a crear los callbacks de paginación todo el tiempo).
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;

  const refrescarSubida = useCallback(() => {
    const actual = selectedIdsRef.current;
    setIdsArriba(actual && actual.size > 0 ? new Set(actual) : SIN_SELECCION);
  }, []);

  // Selección vaciada (botón "Limpiar", o un bulk que borró las filas) ⇒ nada
  // sube. Sin esto la lista quedaba reordenada sin ninguna casilla marcada.
  const haySeleccion = !!selectedIds && selectedIds.size > 0;
  useEffect(() => {
    if (!haySeleccion) {
      setIdsArriba((prev) => (prev.size === 0 ? prev : SIN_SELECCION));
    }
  }, [haySeleccion]);

  // `items` cuando no hay nada que subir: MISMA identidad de array que la
  // entrada, así que el caso normal no cuesta nada ni invalida memos de abajo.
  const ordenados = useMemo(() => {
    if (!getId || idsArriba.size === 0) return items;
    const arriba: T[] = [];
    const resto: T[] = [];
    for (const item of items) {
      (idsArriba.has(getId(item)) ? arriba : resto).push(item);
    }
    return arriba.length === 0 ? items : [...arriba, ...resto];
    // `getId` se omite a propósito: los grids lo pasan como flecha inline, así
    // que su identidad cambia en cada render y la lista se recrearía siempre.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, idsArriba]);

  const totalItems = items.length;
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(totalItems / pageSize)) : 1;

  // Clamp: si totalItems baja y currentPage queda fuera de rango,
  // ajustamos hacia abajo. Sin esto, filtrar de 100→3 items con page=5
  // dejaba el grid vacío.
  useEffect(() => {
    if (currentPage > totalPages) {
      refrescarSubida();
      setCurrentPageRaw(totalPages);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, totalPages]);

  // Reset a página 1 cuando cambia el set de filtros. Distinguimos esto
  // del clamp porque aplicar un filtro debe llevar al usuario al inicio
  // de los nuevos resultados (no a "la última página del nuevo set").
  //
  // Se SALTA la primera ejecución (la del mount): un useEffect con deps corre
  // igual al montar, así que este reset pisaba la página que acabábamos de
  // restaurar de localStorage — y lo hacía incluso sin pasar `resetKey`. Por eso
  // el "recordar que estabas en la página 3" que promete este hook nunca se
  // cumplió en los ~40 grids (solo se restauraba el pageSize). Con el guard, el
  // reset queda para los cambios REALES de filtro post-mount, que es su
  // propósito. Si la página restaurada quedó fuera de rango, el efecto de clamp
  // de arriba la corrige.
  const resetKeyFirstRunRef = useRef(true);
  useEffect(() => {
    if (resetKeyFirstRunRef.current) {
      resetKeyFirstRunRef.current = false;
      return;
    }
    // Los TRES caminos que mueven la página refrescan el snapshot, no solo los
    // dos setters públicos. Filtrar con una selección repartida en varias
    // páginas es el caso MÁS común, y sin esto la lista volvía a la página 1
    // dejando lo marcado enterrado: exactamente el problema que esto arregla.
    refrescarSubida();
    setCurrentPageRaw(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // Persistencia: cada vez que page o pageSize cambia, escribimos. Se salta
  // hasta que `hydrated` es true para no pisar el valor guardado con el default
  // del primer render (ver el efecto de hidratación arriba).
  useEffect(() => {
    if (!hydrated) return;
    writePersisted(storageKey, { page: currentPage, pageSize });
  }, [hydrated, storageKey, currentPage, pageSize]);

  const setCurrentPage = useCallback(
    (page: number) => {
      const clamped = Math.max(1, Math.min(page, totalPages));
      // Refrescar ACÁ y no en un efecto sobre `currentPage`: el efecto corre
      // después del commit, así que la página nueva se pintaría una vez sin lo
      // subido y otra con ello — un salto visible. Acá entra en el mismo lote.
      refrescarSubida();
      setCurrentPageRaw(clamped);
    },
    [totalPages, refrescarSubida],
  );

  const setPageSize = useCallback(
    (size: number) => {
      // Al cambiar el tamaño, intentamos mantener visible el primer item
      // de la página actual. Ej. estás en page=3 con size=10 (items
      // 21-30) y cambias a size=25 — deberías terminar en page=1
      // (items 1-25, incluye los anteriores).
      const firstVisibleIndex = (currentPage - 1) * pageSize;
      refrescarSubida();
      setPageSizeRaw(size);
      if (size > 0) {
        const newPage = Math.floor(firstVisibleIndex / size) + 1;
        setCurrentPageRaw(Math.max(1, newPage));
      } else {
        setCurrentPageRaw(1);
      }
    },
    [currentPage, pageSize, refrescarSubida],
  );

  const paginatedItems = useMemo(() => {
    if (pageSize <= 0) return ordenados;
    const start = (currentPage - 1) * pageSize;
    return ordenados.slice(start, start + pageSize);
  }, [ordenados, currentPage, pageSize]);

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
