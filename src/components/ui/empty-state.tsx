import { type ComponentType, type ReactNode } from "react";
import { TableCell, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";
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
      <TableCell colSpan={colSpan} className="text-center py-4 sm:py-8">
        {inner}
      </TableCell>
    </TableRow>
  );
}

interface ErrorStateProps {
  /** Mensaje principal — ya traducido (pasar por `friendlyError` antes). */
  message: string;
  /** Detalle secundario opcional (typo de causa, código de error). */
  hint?: string;
  /** Si se pasa, muestra un botón "Reintentar" que la dispara. */
  onRetry?: () => void;
  className?: string;
}

/**
 * ErrorState — placeholder visible cuando una query principal falla y
 * deja la pantalla sin datos para mostrar. Mismo layout que EmptyState
 * pero con ícono de alerta + tono destructivo + botón "Reintentar".
 *
 * Sustituye el patrón "toast.error en catch + render UI vacía" que
 * dejaba al usuario adivinando si la app estaba cargando, vacía o rota.
 *
 * Uso típico:
 *   const [loadError, setLoadError] = useState<string | null>(null);
 *   ...
 *   if (loading) return <SectionLoader />;
 *   if (loadError) return <ErrorState message={loadError} onRetry={load} />;
 */
export function ErrorState({ message, hint, onRetry, className }: Readonly<ErrorStateProps>) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-2 py-10 px-4 text-center",
        className,
      )}
    >
      <div className="h-10 w-10 rounded-full bg-destructive/10 flex items-center justify-center">
        <AlertTriangle className="h-5 w-5 text-destructive" />
      </div>
      <p className="text-sm font-medium text-foreground">{message}</p>
      {hint ? <p className="text-xs text-muted-foreground max-w-sm">{hint}</p> : null}
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry} className="mt-2">
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Reintentar
        </Button>
      ) : null}
    </div>
  );
}
