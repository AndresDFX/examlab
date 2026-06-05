/**
 * Helpers puros para la lista de pizarras del docente
 * (`/app/teacher/whiteboards`).
 *
 * Extraídos del componente para que sean testables sin React. El
 * componente los usa via `useMemo`. Mantener sin dependencias para
 * que el test corra sin DOM.
 */

export interface WhiteboardListItem {
  id: string;
  name: string;
  description: string | null;
}

export interface WhiteboardSortableItem extends WhiteboardListItem {
  /** Cualquier campo de fecha ISO. `null` significa "valor mínimo" en
   *  los sort por fecha — se usa epoch 0 como fallback. */
  updated_at?: string | null;
  created_at?: string | null;
}

export type WhiteboardSort =
  | "updated_desc"
  | "updated_asc"
  | "name_asc"
  | "name_desc"
  | "created_desc";

/**
 * Filtra pizarras por nombre o descripción. Case-insensitive,
 * tolera descripciones null, trimea la query (espacios al borde no
 * cuentan). Si la query es vacía o solo espacios, retorna el array
 * original sin tocar referencias (estable para `useMemo`).
 */
export function filterWhiteboards<T extends WhiteboardListItem>(items: T[], search: string): T[] {
  if (!search.trim()) return items;
  const q = search.trim().toLowerCase();
  return items.filter(
    (w) => w.name.toLowerCase().includes(q) || (w.description ?? "").toLowerCase().includes(q),
  );
}

/**
 * Ordena la lista según el modo elegido. NO muta el array entrada
 * (devuelve uno nuevo) — necesario porque el padre usa `useMemo` y
 * mutar `items` rompería referencias compartidas con otros memos.
 *
 * Para sort por fecha: valores null o ausentes caen a epoch 0 (orden
 * "más viejo posible") así no llegan al top en sort `desc`.
 */
export function sortWhiteboards<T extends WhiteboardSortableItem>(
  items: T[],
  sort: WhiteboardSort,
): T[] {
  const dateOrZero = (v: string | null | undefined): number => (v ? new Date(v).getTime() : 0);
  const copy = items.slice();
  switch (sort) {
    case "updated_desc":
      return copy.sort((a, b) => dateOrZero(b.updated_at) - dateOrZero(a.updated_at));
    case "updated_asc":
      return copy.sort((a, b) => dateOrZero(a.updated_at) - dateOrZero(b.updated_at));
    case "created_desc":
      return copy.sort((a, b) => dateOrZero(b.created_at) - dateOrZero(a.created_at));
    case "name_asc":
      return copy.sort((a, b) => a.name.localeCompare(b.name, "es"));
    case "name_desc":
      return copy.sort((a, b) => b.name.localeCompare(a.name, "es"));
    default:
      return copy;
  }
}
