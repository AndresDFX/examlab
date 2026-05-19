import * as React from "react";
import { Calendar } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { formatDate, formatDateOnly, formatDateTime, formatDateShort } from "@/shared/lib/format";

/**
 * Celda estandarizada para mostrar una fecha en grids/tablas. Unifica:
 *  - el helper de formato según el tipo de columna DB,
 *  - el ícono de calendario opcional,
 *  - el estado vacío ("—" tenue) cuando la fecha es null,
 *  - el estilo tabular (tabular-nums) para alineación entre filas.
 *
 * Para los headers de columna en grids usar literalmente "Inicio" /
 * "Fin" (no "Fecha límite") en cursos, exámenes, talleres y proyectos.
 * Forms / Labels mantienen "Fecha inicio" / "Fecha fin" porque ahí el
 * contexto explícito ayuda; en grids el header corto evita saturar.
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
  // `block truncate` + `title` resuelve el bug visual donde fechas
  // largas (ej. "21 de may de 2026, 18:00") en columnas estrechas
  // (w-28/w-32) se desbordaban sobre la celda siguiente.
  //
  // Cómo funciona: `truncate` = overflow-hidden + text-overflow:ellipsis
  // + whitespace-nowrap. En `<Table fixed>` cada celda tiene ancho fijo;
  // el span ocupa el ancho útil de la celda y lo que no quepa se corta
  // con "…". `title={text}` da el tooltip nativo del browser con el
  // valor completo al hacer hover sobre la celda — UX estándar para
  // textos truncados sin requerir librería de tooltips.
  if (withIcon) {
    // Variante con ícono: usamos flex + min-w-0 para que el span
    // truncable funcione dentro del contenedor inline. El ícono nunca
    // se trunca (shrink-0).
    return (
      <span
        title={text}
        className={cn("flex items-center gap-1.5 min-w-0 max-w-full", className)}
      >
        <Calendar
          className="h-3.5 w-3.5 text-muted-foreground shrink-0"
          aria-hidden
        />
        <span className="truncate text-sm tabular-nums">{text}</span>
      </span>
    );
  }
  return (
    <span
      title={text}
      className={cn("block truncate text-sm tabular-nums", className)}
    >
      {text}
    </span>
  );
}
