/**
 * Sección colapsable de "Conversación con el estudiante" por pregunta.
 * Default cerrada — la modal de respuestas tiene N preguntas y mantener
 * todos los hilos abiertos es ruido visual + N requests innecesarias.
 *
 * El trigger muestra un badge con el conteo de hilos abiertos para esta
 * pregunta y un badge "Esperando respuesta" si el último mensaje lo
 * escribió el alumno (lo calculamos una sola vez en el load del padre —
 * no requiere fetch por componente). El `<FeedbackThread>` se renderiza
 * solo cuando está abierto: así no dispara su propio useEffect de
 * carga hasta que el docente decide expandir.
 *
 * Reusado entre el monitor de exámenes y la grilla de calificación de
 * talleres — la mecánica es idéntica, solo cambia `parentKind`.
 */
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronRight, MessageSquareText } from "lucide-react";
import { FeedbackThread } from "@/components/FeedbackThread";

export function ConversationSection({
  parentKind,
  questionId,
  submissionId,
  summary,
  conversationLabel,
  pendingLabel,
  onChanged,
}: {
  parentKind: "exam" | "workshop" | "project";
  questionId: string;
  submissionId: string;
  summary?: { count: number; pending: boolean };
  conversationLabel: string;
  pendingLabel: string;
  /** Forwardea al FeedbackThread interior — el caller recibe el aviso
   *  cuando el docente cierra/reabre o postea un comentario para
   *  refrescar sus agregados (badges del monitor). */
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hasPending = summary?.pending === true;
  const count = summary?.count ?? 0;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={`rounded-md border p-2 space-y-2 ${
          hasPending ? "border-destructive/40 bg-destructive/5" : "border-border/60 bg-muted/20"
        }`}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="w-full flex items-center gap-2 text-[11px] font-medium text-muted-foreground hover:text-foreground group"
          >
            <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
            <MessageSquareText className="h-3 w-3" />
            <span>{conversationLabel}</span>
            {count > 0 && (
              <Badge variant="outline" className="ml-auto text-[10px] tabular-nums">
                {count}
              </Badge>
            )}
            {hasPending && (
              <Badge variant="destructive" className={`text-[10px] ${count > 0 ? "" : "ml-auto"}`}>
                {pendingLabel}
              </Badge>
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {open && (
            <FeedbackThread
              parentKind={parentKind}
              questionId={questionId}
              submissionId={submissionId}
              isTeacher
              onChanged={onChanged}
            />
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
