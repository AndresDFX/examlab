/**
 * Filtro de estado para los grids de actividades del docente (exámenes,
 * talleres, proyectos), cuyo `status` es `draft | published | closed`.
 *
 * Regla de UX (goal): al abrir el grid, por DEFECTO se ven los ACTIVOS y los
 * BORRADORES (todo lo que NO está cerrado). Los CERRADOS (completados) no se ven
 * hasta que el docente cambia el filtro a "Cerrados" o "Todos". Antes los grids
 * mostraban todo sin distinción de estado.
 */
export type ActivityStatusFilter =
  | "activos"
  | "borradores"
  | "publicados"
  | "cerrados"
  | "todos";

/**
 * Opciones en el orden en que se muestran. La combinada va primera porque es el
 * default; después los estados individuales; "Todos" al final.
 *
 * WHY existen las individuales: el filtro solo ofrecía activos / cerrados /
 * todos, así que un docente NO podía ver únicamente sus BORRADORES — quedaban
 * mezclados con los publicados dentro de "Activos". Reportado sobre Pizarras, y
 * aplicaba a los cuatro grids que comparten este componente. La grilla de Cursos
 * ya ofrecía una opción por estado; esto la alinea.
 */
export const ACTIVITY_STATUS_OPTIONS: readonly ActivityStatusFilter[] = [
  "activos",
  "borradores",
  "publicados",
  "cerrados",
  "todos",
] as const;

/** Estado inicial del filtro: activos + borradores (oculta cerrados). */
export const DEFAULT_ACTIVITY_STATUS_FILTER: ActivityStatusFilter = "activos";

/**
 * `true` si una actividad con `status` debe verse bajo `filter`.
 *   • `activos`     → draft + published (todo lo que NO está cerrado) — DEFAULT.
 *   • `borradores`  → solo draft.
 *   • `publicados`  → solo published.
 *   • `cerrados`    → solo closed.
 *   • `todos`       → todo.
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
    case "borradores":
      return s === "draft";
    case "publicados":
      return s === "published";
    case "cerrados":
      return s === "closed";
    case "activos":
    default:
      return s !== "closed";
  }
}
