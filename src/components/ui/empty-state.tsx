import { type ComponentType, type ReactNode } from "react";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * EmptyState — caja centrada para "sin datos" en cards / contenedores
 * grandes. TableEmpty — variante para usar como fila de una `<Table>`.
 *
 * Antes cada pantalla escribía su propio "sin datos" con clases
 * distintas (algunas con `text-muted-foreground py-8`, otras con
 * `text-center text-sm py-10`, otras con un `<p>` desnudo). Estos
 * helpers fijan el espaciado y el tono.
 */

interface EmptyStateProps {
  /** Texto principal. Manténlo corto: una frase. */
  text: string;
  /** Línea secundaria opcional, para sugerir la siguiente acción. */
  hint?: string;
  /** Ícono opcional para reforzar el tipo de vacío. */
  icon?: ComponentType<{ className?: string }>;
  /** CTA opcional (botón, link, etc.). */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  text,
  hint,
  icon: Icon,
  action,
  className,
}: Readonly<EmptyStateProps>) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 py-10 px-4 text-center",
        className,
      )}
    >
      {Icon ? (
        <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
      ) : null}
      <p className="text-sm font-medium text-foreground">{text}</p>
      {hint ? <p className="text-xs text-muted-foreground max-w-sm">{hint}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

interface TableEmptyProps {
  colSpan: number;
  text: string;
  hint?: string;
  icon?: ComponentType<{ className?: string }>;
  /** CTA opcional (botón / link). Solo cuando hay una acción primaria
   *  obvia para llenar la lista — "Crear primer examen", etc. */
  action?: ReactNode;
}

/**
 * Variante para usar como fila dentro de un <TableBody>. Mantiene la
 * misma jerarquía visual que EmptyState pero comprimida — una tabla
 * vacía no debe ocupar tanto espacio como una página vacía.
 */
export function TableEmpty({
  colSpan,
  text,
  hint,
  icon: Icon,
  action,
}: Readonly<TableEmptyProps>) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="text-center py-8">
        <div className="flex flex-col items-center gap-1.5">
          {Icon ? <Icon className="h-5 w-5 text-muted-foreground" /> : null}
          <p className="text-sm text-muted-foreground">{text}</p>
          {hint ? <p className="text-xs text-muted-foreground/80">{hint}</p> : null}
          {action ? <div className="mt-2">{action}</div> : null}
        </div>
      </TableCell>
    </TableRow>
  );
}
