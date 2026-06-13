import { Lock, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";

/**
 * Banner reusable para REABRIR algo cerrado desde su formulario de edición.
 *
 * Patrón unificado en exámenes, talleres, proyectos y encuestas: cuando la
 * entidad está cerrada, el form de edición muestra este banner; al pulsar
 * "Reabrir" el caller cambia el ESTADO a abierto y fija un PLAZO futuro
 * (la entidad se persiste con el Guardar normal del form). El texto va en
 * español hardcodeado a propósito — convive con los selects de estado de
 * estos forms ("Borrador/Publicado/Cerrado"), que también son literales.
 */
export function ReopenClosedBanner({
  message = "Esto está cerrado.",
  hint = "Para reabrirlo, cambia el estado a abierto y fija un nuevo plazo (fecha futura).",
  reopenLabel = "Reabrir",
  onReopen,
  className,
}: {
  message?: string;
  hint?: string;
  reopenLabel?: string;
  onReopen: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-md border border-amber-500/40 bg-amber-500/10 p-3",
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="flex-1 text-xs text-amber-900 dark:text-amber-100">
          <p className="font-medium">{message}</p>
          {hint && (
            <p className="mt-0.5 text-amber-800/80 dark:text-amber-200/80">{hint}</p>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onReopen}
          className="shrink-0 border-amber-500/60 text-amber-800 hover:bg-amber-500/15 dark:text-amber-100"
        >
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          {reopenLabel}
        </Button>
      </div>
    </div>
  );
}
