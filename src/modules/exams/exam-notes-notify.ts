/**
 * Inserción de notificación cuando una "nota de apoyo" (exam_note) es
 * aprobada o rechazada. Centraliza el wording + el `kind` para que las
 * dos UIs que hacen revisión (PendingExamNotesModal y TeacherExamNotes)
 * disparen la MISMA notificación, y por ende el MISMO correo.
 *
 * Usa `kind='exam'` para entrar en `CRITICAL_KINDS` y disparar email
 * vía el pipeline existente (`_notification_kind_emails` SQL +
 * `shouldSendEmail` TS). El link lleva al estudiante al listado de
 * sus exámenes — desde allí ve el toggle "Nota de apoyo" del examen.
 *
 * Si `examTitle` no llega, se resuelve por id como fallback (un
 * round-trip extra pero acepable; aprobar/rechazar no es hot path).
 */
import { supabase } from "@/integrations/supabase/client";

interface NotifyExamNoteReviewedParams {
  /** ID del estudiante destinatario. */
  studentId: string;
  examId: string;
  /** Título legible del examen. Si no se conoce, se busca por id. */
  examTitle?: string | null;
  /** true = aprobada; false = rechazada. */
  approved: boolean;
  /** Motivo del rechazo. Solo se usa si `approved=false`. Si no se
   *  envía, no se concatena al body. */
  rejectionReason?: string | null;
}

/**
 * Builder PURO del title + body de la notificación. Sale como helper
 * exportable para poder testearlo sin mockear supabase. La función
 * `notifyExamNoteReviewed` lo usa internamente y se encarga del lado
 * I/O (consulta de título + insert).
 *
 * Reglas:
 *   - approved=true → "Nota de apoyo aprobada — <título>"
 *   - approved=false sin motivo → "rechazada — <título>" + body sin motivo
 *   - approved=false con motivo → body incluye "Motivo: <texto>"
 *   - examTitle null/empty/whitespace → fallback "tu examen"
 *   - rejectionReason solo whitespace → tratado como ausente
 */
export function buildExamNoteReviewedMessage(params: {
  examTitle?: string | null;
  approved: boolean;
  rejectionReason?: string | null;
}): { title: string; body: string } {
  const trimmedTitle = params.examTitle?.trim();
  const safeTitle = trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : "tu examen";

  const title = params.approved
    ? `Nota de apoyo aprobada — ${safeTitle}`
    : `Nota de apoyo rechazada — ${safeTitle}`;

  const reason = params.rejectionReason?.trim();
  const body = params.approved
    ? `Tu nota de apoyo para "${safeTitle}" fue aprobada. Estará disponible durante el examen.`
    : `Tu nota de apoyo para "${safeTitle}" fue rechazada${
        reason ? `. Motivo: ${reason}` : ""
      }. Puedes editarla y enviarla de nuevo desde tu vista de exámenes.`;

  return { title, body };
}

export async function notifyExamNoteReviewed(params: NotifyExamNoteReviewedParams): Promise<void> {
  let title = params.examTitle ?? null;
  if (!title) {
    const { data } = await supabase
      .from("exams")
      .select("title")
      .eq("id", params.examId)
      .maybeSingle();
    title = (data as { title: string } | null)?.title ?? null;
  }

  const { title: notifTitle, body: notifBody } = buildExamNoteReviewedMessage({
    examTitle: title,
    approved: params.approved,
    rejectionReason: params.rejectionReason,
  });

  // kind='exam' → critical kind → dispara correo. El link al listado de
  // exámenes es la mejor entrada para el estudiante: desde ahí ve cuál
  // tiene la nota habilitada y puede editar/reenviar si fue rechazada.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any).from("notifications").insert({
    user_id: params.studentId,
    title: notifTitle,
    body: notifBody,
    kind: "exam",
    link: "/app/student/exams",
  });
}
