import { type ComponentType, type ReactNode } from "react";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/shared/lib/utils";

/**
 * EmptyState — caja centrada para "sin datos" en cards / contenedores
 * grandes. TableEmpty — variante para usar como fila de una `<Table>`,
 * o como bloque suelto dentro de un `<CardContent>` cuando no se pasa
 * `colSpan` (entonces se renderiza sin `<tr>/<td>`).
 *
 * Aceptamos tanto `text/hint` (API original) como `title/description`
 * (alias usado por varias pantallas) para no fragmentar el design system.
 */

interface EmptyStateProps {
  /** Texto principal. Manténlo corto: una frase. */
  text?: string;
  /** Alias de `text`. */
  title?: string;
  /** Línea secundaria opcional, para sugerir la siguiente acción. */
  hint?: string;
  /** Alias de `hint`. */
  description?: string;
  /** Ícono opcional para reforzar el tipo de vacío. */
  icon?: ComponentType<{ className?: string }>;
  /** CTA opcional (botón, link, etc.). */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  text,
  title,
  hint,
  description,
  icon: Icon,
  action,
  className,
}: Readonly<EmptyStateProps>) {
  const primary = text ?? title ?? "";
  const secondary = hint ?? description;
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
      <p className="text-sm font-medium text-foreground">{primary}</p>
      {secondary ? (
        <p className="text-xs text-muted-foreground max-w-sm">{secondary}</p>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

interface TableEmptyProps {
  /** Cuando se pasa, se renderiza como fila `<tr><td colSpan>`.
   *  Cuando se omite, se renderiza como bloque centrado (útil dentro
   *  de un `<CardContent>` sin `<table>`). */
  colSpan?: number;
  text?: string;
  title?: string;
  hint?: string;
  description?: string;
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
  title,
  hint,
  description,
  icon: Icon,
  action,
}: Readonly<TableEmptyProps>) {
  const primary = text ?? title ?? "";
  const secondary = hint ?? description;
  const inner = (
    <div className="flex flex-col items-center gap-1.5">
      {Icon ? <Icon className="h-5 w-5 text-muted-foreground" /> : null}
      <p className="text-sm text-muted-foreground">{primary}</p>
      {secondary ? (
        <p className="text-xs text-muted-foreground/80">{secondary}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
  if (colSpan === undefined) {
    return <div className="py-8 text-center">{inner}</div>;
  }
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="text-center py-8">
        {inner}
      </TableCell>
    </TableRow>
  );
}
