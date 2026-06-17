/**
 * Filtro de estado para los grids de actividades del docente (exámenes,
 * talleres, proyectos), cuyo `status` es `draft | published | closed`.
 *
 * Regla de UX (goal): al abrir el grid, por DEFECTO se ven los ACTIVOS y los
 * BORRADORES (todo lo que NO está cerrado). Los CERRADOS (completados) no se ven
 * hasta que el docente cambia el filtro a "Cerrados" o "Todos". Antes los grids
 * mostraban todo sin distinción de estado.
 */
export type ActivityStatusFilter = "activos" | "cerrados" | "todos";

/** Estado inicial del filtro: activos + borradores (oculta cerrados). */
export const DEFAULT_ACTIVITY_STATUS_FILTER: ActivityStatusFilter = "activos";

/**
 * `true` si una actividad con `status` debe verse bajo `filter`.
 *   • `activos`  → draft + published (todo lo que NO está cerrado) — DEFAULT.
 *   • `cerrados` → solo closed.
 *   • `todos`    → todo.
 * `status` nullish se trata como `published` (mismo fallback que el resto de la
 * app: una fila sin estado se asume publicada, no cerrada).
 */
export function matchesActivityStatus(
  status: string | null | undefined,
  filter: ActivityStatusFilter,
): boolean {
  const s = status ?? "published";
  switch (filter) {
    case "todos":
      return true;
    case "cerrados":
      return s === "closed";
    case "activos":
    default:
      return s !== "closed";
  }
}
