import * as React from "react";
import { Calendar } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDate, formatDateOnly, formatDateTime, formatDateShort } from "@/lib/format";

/**
 * Celda estandarizada para mostrar una fecha en grids/tablas. Unifica:
 *  - el helper de formato según el tipo de columna DB,
 *  - el ícono de calendario opcional,
 *  - el estado vacío ("—" tenue) cuando la fecha es null,
 *  - el estilo tabular (tabular-nums) para alineación entre filas.
 *
 * Para los headers de columna usar literalmente "Fecha inicio" / "Fecha
 * fin" (no "Inicio"/"Fin"/"Fecha límite") en cursos, exámenes, talleres
 * y proyectos. Esto mantiene los grids docentes consistentes.
 *
 * Variantes de formato:
 *  - "auto" (default): si el value es "YYYY-MM-DD" usa formatDateOnly
 *    (DATE sin TZ, anclado a 12:00 local); si trae hora usa formatDateTime.
 *  - "date": fuerza solo fecha (formatDate).
 *  - "datetime": fuerza fecha + hora (formatDateTime).
 *  - "short": día/mes sin año (formatDateShort).
 *
 * El ícono se omite por default para no saturar grids con muchas
 * columnas. Activarlo con `withIcon` cuando la columna sea protagonista.
 */

type DateCellProps = {
  value: string | Date | number | null | undefined;
  variant?: "auto" | "date" | "datetime" | "short";
  withIcon?: boolean;
  fallback?: string;
  className?: string;
};

function formatByVariant(value: DateCellProps["value"], variant: DateCellProps["variant"]) {
  if (value == null || value === "") return null;
  switch (variant) {
    case "date":
      return formatDate(value);
    case "datetime":
      return formatDateTime(value);
    case "short":
      return formatDateShort(value);
    case "auto":
    default: {
      // "YYYY-MM-DD" → DATE sin TZ → formatDateOnly evita el bug de
      // descontar un día por interpretación UTC.
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return formatDateOnly(value);
      }
      return formatDateTime(value);
    }
  }
}

export function DateCell({
  value,
  variant = "auto",
  withIcon = false,
  fallback = "—",
  className,
}: DateCellProps) {
  const text = formatByVariant(value, variant);
  if (text == null) {
    return <span className={cn("text-muted-foreground/60 text-sm", className)}>{fallback}</span>;
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm tabular-nums whitespace-nowrap",
        className,
      )}
    >
      {withIcon && <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />}
      {text}
    </span>
  );
}
