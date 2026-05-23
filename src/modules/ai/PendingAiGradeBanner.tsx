/**
 * Banner mínimo para el estudiante cuando su entrega tiene la
 * calificación IA pendiente (modo async / cola). Lo renderizan las
 * vistas de revisión (examen, taller, proyecto) cuando detectan que
 * `ai_grade` no está asignada todavía.
 *
 * Diseño:
 *   - Decisión: solo "Por calificar" + ícono. Antes mostrábamos un
 *     mensaje largo explicando la cola; resultó ruido en cada vista
 *     y a la mayoría de estudiantes no les importaba el cómo —
 *     solo saber que la nota no está.
 *   - Tono `amber` para que llame la atención sin parecer error.
 *   - `compact` (chip inline, usado en cards de listado) vs `default`
 *     (badge con padding propio, usado en página de revisión).
 *   - Reutilizable: NO trae lógica de cuándo mostrarse — el caller
 *     decide con `isAiGradePending(...)` del helper de ai-grading.
 */
import { Clock } from "lucide-react";
import { QUEUED_STUDENT_TITLE } from "@/modules/ai/ai-grading";
import { cn } from "@/shared/lib/utils";

interface Props {
  /** `compact` = chip pequeño inline; `default` = banner con padding. */
  variant?: "compact" | "default";
  className?: string;
}

export function PendingAiGradeBanner({ variant = "default", className }: Props) {
  if (variant === "compact") {
    return (
      <span
        role="status"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-900 dark:text-amber-200",
          className,
        )}
      >
        <Clock className="h-3 w-3 shrink-0" />
        {QUEUED_STUDENT_TITLE}
      </span>
    );
  }
  return (
    <div
      role="status"
      className={cn(
        "inline-flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-sm font-medium text-amber-900 dark:text-amber-200",
        className,
      )}
    >
      <Clock className="h-4 w-4 shrink-0" />
      {QUEUED_STUDENT_TITLE}
    </div>
  );
}
