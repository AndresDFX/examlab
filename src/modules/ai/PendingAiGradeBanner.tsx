/**
 * Banner explicativo para el estudiante cuando su entrega tiene la
 * calificación IA pendiente (modo async / cola). Lo renderizan las
 * vistas de revisión (examen, taller, proyecto) cuando detectan que
 * `ai_grade` no está asignada todavía.
 *
 * Diseño:
 *   - Tono `amber` para que llame la atención sin parecer error.
 *   - Ícono `Clock` para asociar visualmente con "esperando".
 *   - Texto breve (1 línea en variant=compact, 2 en default) que el
 *     estudiante entiende sin contexto adicional.
 *   - Reutilizable: NO trae lógica de cuándo mostrarse — el caller
 *     decide con `isAiGradePending(...)` del helper de ai-grading.
 */
import { Clock } from "lucide-react";
import { QUEUED_STUDENT_TITLE, QUEUED_STUDENT_BODY } from "@/modules/ai/ai-grading";
import { cn } from "@/shared/lib/utils";

interface Props {
  /** `compact` = una sola línea, sin título; `default` = título + body. */
  variant?: "compact" | "default";
  className?: string;
}

export function PendingAiGradeBanner({ variant = "default", className }: Props) {
  if (variant === "compact") {
    return (
      <div
        role="status"
        className={cn(
          "flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-900 dark:text-amber-200",
          className,
        )}
      >
        <Clock className="h-3.5 w-3.5 shrink-0" />
        <span>{QUEUED_STUDENT_BODY}</span>
      </div>
    );
  }
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3",
        className,
      )}
    >
      <Clock className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
      <div className="space-y-0.5 min-w-0">
        <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
          {QUEUED_STUDENT_TITLE}
        </p>
        <p className="text-xs text-amber-800/80 dark:text-amber-200/80">{QUEUED_STUDENT_BODY}</p>
      </div>
    </div>
  );
}
