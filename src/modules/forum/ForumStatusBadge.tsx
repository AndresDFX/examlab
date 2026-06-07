/**
 * ForumStatusBadge — encapsula los tres estados visuales que se pintan
 * sobre un hilo de foro en la vista de detalle:
 *
 *   - "locked"   → hilo cerrado (amber)
 *   - "pinned"   → hilo fijado por el docente (indigo)
 *   - "official" → respuesta marcada como oficial del docente (emerald)
 *
 * Vive acá (no en `StatusBadge` global) porque los estados son
 * específicos al módulo Foro Q&A y los colores son ad-hoc — no calzan
 * en el mapeo `variant + ícono` que usa `StatusBadge` para
 * exam/workshop/project/submission. Mantenerlo local evita el
 * cross-cutting risk de tocar el componente global por 3 variants.
 */
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Lock, Pin } from "lucide-react";

type ForumStatus = "locked" | "pinned" | "official";

interface ForumStatusBadgeProps {
  status: ForumStatus;
  className?: string;
}

export function ForumStatusBadge({ status, className }: ForumStatusBadgeProps) {
  if (status === "locked") {
    return (
      <Badge
        variant="outline"
        className={
          "text-[10px] text-amber-700 dark:text-amber-300 border-amber-500/40 " +
          (className ?? "")
        }
      >
        <Lock className="h-2.5 w-2.5 mr-0.5" />
        Cerrado
      </Badge>
    );
  }
  if (status === "pinned") {
    return (
      <Badge
        variant="outline"
        className={
          "text-[10px] text-indigo-700 dark:text-indigo-300 border-indigo-500/40 " +
          (className ?? "")
        }
      >
        <Pin className="h-2.5 w-2.5 mr-0.5" />
        Fijado
      </Badge>
    );
  }
  // official
  return (
    <Badge
      variant="outline"
      className={
        "text-[10px] text-emerald-700 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10 " +
        (className ?? "")
      }
    >
      <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
      Respuesta oficial del docente
    </Badge>
  );
}
