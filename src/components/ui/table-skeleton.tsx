import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";

/**
 * TableSkeleton — N filas placeholder con celdas pulsantes para usar
 * mientras la tabla está cargando. Reemplaza el patrón anterior de
 * mostrar "Cargando…" sobre una tabla vacía: el alumno/docente ve
 * inmediatamente el shape esperado del contenido y la transición a
 * datos reales es menos abrupta.
 *
 * Las anchuras de Skeleton varían por columna para que el placeholder
 * se vea "natural" (un nombre largo, una nota corta, etc.) en lugar
 * de barras uniformes que delatan el placeholder.
 *
 * Para casos que necesiten anchuras específicas por columna, pasar
 * `widths` con porcentajes / clases tailwind.
 */

interface TableSkeletonProps {
  /** Cantidad de filas placeholder. Default 5 — suficiente para mostrar
   *  el shape sin saturar mientras dura la carga. */
  rows?: number;
  /** Cantidad de columnas. */
  cols: number;
  /** Anchuras opcionales por columna ("60%", "w-24", etc.). Si se
   *  omite, las anchuras alternan entre 40-80% del ancho de celda. */
  widths?: string[];
}

const DEFAULT_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-1/3", "w-1/2", "w-3/4", "w-1/2"];

export function TableSkeleton({ rows = 5, cols, widths }: Readonly<TableSkeletonProps>) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIdx) => (
        <TableRow key={rowIdx}>
          {Array.from({ length: cols }).map((_, colIdx) => {
            const w = widths?.[colIdx] ?? DEFAULT_WIDTHS[colIdx % DEFAULT_WIDTHS.length];
            return (
              <TableCell key={colIdx}>
                <Skeleton className={`h-4 ${w}`} />
              </TableCell>
            );
          })}
        </TableRow>
      ))}
    </>
  );
}

/**
 * ListSkeleton — placeholder para listas de cards verticales (no
 * tablas). Usado en gradingDialog de proyectos y vistas de student
 * que muestran cards apiladas mientras carga la data real.
 */

interface ListSkeletonProps {
  rows?: number;
  /** Altura aproximada de cada card placeholder. */
  rowHeight?: string;
}

export function ListSkeleton({ rows = 3, rowHeight = "h-20" }: Readonly<ListSkeletonProps>) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, idx) => (
        <Skeleton key={idx} className={`w-full ${rowHeight}`} />
      ))}
    </div>
  );
}
