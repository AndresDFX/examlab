/**
 * Sección colapsable de "Conversación con el estudiante" por pregunta.
 * Default cerrada — la modal de respuestas tiene N preguntas y mantener
 * todos los hilos abiertos es ruido visual + N requests innecesarias.
 *
 * Tres estados, con color (ver `estado-conversacion.ts`):
 *  - «Falta responder» (rojo): el último mensaje es del estudiante.
 *  - «Falta cerrar» (ámbar): ya respondiste y el hilo sigue abierto. Antes se
 *    veía igual que una pregunta sin nada pendiente, y el reclamo quedaba abierto.
 *  - nada pendiente: neutro.
 * Con algo pendiente la sección se ABRE sola: es la acción que hay que hacer.
 *
 * El resumen lo calcula el padre una sola vez (no requiere fetch por componente).
 * El `<FeedbackThread>` se renderiza solo cuando está abierto: así no dispara su
 * propio useEffect de carga hasta que hace falta.
 *
 * Reusado entre el monitor de exámenes y la grilla de calificación de
 * talleres — la mecánica es idéntica, solo cambia `parentKind`.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronRight, MessageSquareText } from "lucide-react";
import { FeedbackThread } from "@/modules/grading/FeedbackThread";
import {
  estadoDeConversacion,
  type ResumenConversacion,
} from "@/modules/grading/estado-conversacion";

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
  summary?: ResumenConversacion;
  conversationLabel: string;
  pendingLabel: string;
  /** Forwardea al FeedbackThread interior — el caller recibe el aviso
   *  cuando el docente cierra/reabre o postea un comentario para
   *  refrescar sus agregados (badges del monitor). */
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const estado = estadoDeConversacion(summary);
  const count = summary?.count ?? 0;

  // El resumen llega DESPUÉS del montaje (lo carga el padre): se abre cuando
  // aparece algo pendiente, y no se vuelve a cerrar solo al resolverlo —
  // cerrarle la sección a quien acaba de actuar sobre ella sería un salto.
  useEffect(() => {
    if (estado) setOpen(true);
  }, [estado]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={`rounded-md border p-2 space-y-2 ${
          estado === "responder"
            ? "border-destructive/50 bg-destructive/5"
            : estado === "cerrar"
              ? "border-warning/60 bg-warning/10"
              : "border-border/60 bg-muted/20"
        }`}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="w-full flex items-center gap-2 text-2xs font-medium text-muted-foreground hover:text-foreground group"
          >
            <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
            <MessageSquareText className="h-3 w-3" />
            <span>{conversationLabel}</span>
            {count > 0 && (
              <Badge variant="outline" className="ml-auto text-3xs tabular-nums">
                {count}
              </Badge>
            )}
            {estado === "responder" && (
              <Badge variant="destructive" className={`text-3xs ${count > 0 ? "" : "ml-auto"}`}>
                {pendingLabel}
              </Badge>
            )}
            {estado === "cerrar" && (
              <Badge
                variant="outline"
                className="text-3xs border-warning/60 bg-warning/15 text-warning-on-subtle"
              >
                {t("integrity.conversationAwaitingClose")}
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
