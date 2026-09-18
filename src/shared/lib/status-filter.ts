/**
 * Filtro de estado para los grids de actividades del docente (exámenes,
 * talleres, proyectos, pizarras), cuyo `status` es `draft | published | closed`.
 *
 * ── Selección MÚLTIPLE, con un default NO vacío ───────────────────────
 * El filtro pasó de un `<Select>` de una opción a un menú de casillas
 * (`MultiSelectFilter`), para poder ver, p. ej., borradores Y cerrados a la vez.
 * La semántica central la fija `filtro-multiple.ts`: **arreglo vacío = sin
 * filtrar (todos los estados)**.
 *
 * Eso choca con una regla de UX que hay que preservar: al abrir el grid NO se
 * ven los cerrados (solo borradores + publicados). Como "vacío = todos" ya está
 * tomado por "mostrar TODO, incluidos los cerrados", el default NO puede ser
 * vacío: es el conjunto `["borradores", "publicados"]`. Por eso este filtro es
 * el único donde `DEFAULT ≠ []`, y por eso "Limpiar" restaura ese conjunto en
 * vez de vaciar (vaciar mostraría los cerrados). El item "Todos" del menú sí
 * vacía: es el "mostrar todo" explícito.
 *
 * Antes existía una opción-preajuste "activos" (draft+published de un clic); con
 * casillas deja de tener sentido (se marcan las dos), así que las opciones son
 * los tres estados atómicos.
 */
import { coincideFiltro } from "@/shared/lib/filtro-multiple";

/** Los tres estados atómicos que se pueden marcar. */
export type ActivityStatusValue = "borradores" | "publicados" | "cerrados";

/** Opciones marcables, en orden de presentación. */
export const ACTIVITY_STATUS_VALUES: readonly ActivityStatusValue[] = [
  "borradores",
  "publicados",
  "cerrados",
] as const;

/**
 * Estado inicial del filtro: borradores + publicados (oculta cerrados). NO es
 * `[]` a propósito — ver el encabezado del archivo.
 */
export const DEFAULT_ACTIVITY_STATUS_FILTER: readonly ActivityStatusValue[] = [
  "borradores",
  "publicados",
];

/**
 * A qué opción atómica pertenece un `status`. `status` nullish se asume
 * `published` (mismo fallback que el resto de la app: una fila sin estado se
 * asume publicada, no cerrada).
 */
export function activityStatusValue(status: string | null | undefined): ActivityStatusValue {
  const s = status ?? "published";
  if (s === "draft") return "borradores";
  if (s === "closed") return "cerrados";
  return "publicados";
}

/**
 * `true` si una actividad con `status` debe verse bajo la selección. Sin nada
 * marcado pasa todo (regla de `filtro-multiple.ts`).
 */
export function matchesActivityStatus(
  status: string | null | undefined,
  seleccion: readonly ActivityStatusValue[],
): boolean {
  return coincideFiltro(seleccion, activityStatusValue(status));
}
