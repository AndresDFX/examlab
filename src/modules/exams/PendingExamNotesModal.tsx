/**
 * Modal "Notas de examen pendientes" del dashboard del docente.
 *
 * Lista las `exam_notes` (chuletas de apoyo subidas por el estudiante)
 * que están en estado `pendiente`, esperando revisión del docente. RLS
 * filtra por curso vía la política Docente/Admin del módulo.
 *
 * Mismo patrón visual que `OpenFeedbackModal`: filas compactas con
 * estudiante + curso + examen + preview del contenido, y tres acciones
 * por fila:
 *   - "Aprobar" (1 click) → status='aprobada', reviewed_by, reviewed_at.
 *   - "Rechazar" → abre input inline para escribir motivo y guarda
 *     status='rechazada' con la razón.
 *   - "Ir" → abre el editor del examen donde vive el panel completo
 *     (TeacherExamNotes) por si el docente quiere contexto.
 *
 * Queries planas + joins en JS (mismo motivo que el modal de
 * conversaciones: embeds anidados de PostgREST son frágiles ante
 * schema cache stale).
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ArrowRight, CheckCircle2, FileText, ThumbsDown, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { formatDateTime } from "@/shared/lib/format";
import { notifyExamNoteReviewed } from "@/modules/exams/exam-notes-notify";
import { friendlyError } from "@/shared/lib/db-errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type ExamNoteRow = {
  id: string;
  exam_id: string;
  user_id: string;
  content: string;
  created_at: string;
  // resueltos en JS
  examTitle?: string;
  courseName?: string;
  studentName?: string;
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Callback opcional para refrescar el contador en el dashboard. */
  onChange?: () => void;
}

export function PendingExamNotesModal({ open, onOpenChange, onChange }: Props) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ExamNoteRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Si está set, la fila está en modo "rechazar": muestra textarea + confirmar. */
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await db
        .from("exam_notes")
        .select("id, exam_id, user_id, content, created_at")
        .eq("status", "pendiente")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) {
        console.warn("[PendingExamNotesModal]", error);
        setRows([]);
        return;
      }
      const notes = (data ?? []) as ExamNoteRow[];
      if (notes.length === 0) {
        setRows([]);
        return;
      }

      const examIds = Array.from(new Set(notes.map((n) => n.exam_id)));
      const userIds = Array.from(new Set(notes.map((n) => n.user_id)));

      const [examsRes, usersRes] = await Promise.all([
        db.from("exams").select("id, title, course_id").in("id", examIds),
        db.from("profiles").select("id, full_name").in("id", userIds),
      ]);

      const examInfoById = new Map<string, { title: string; course_id: string | null }>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((examsRes.data ?? []) as any[]).forEach((x) =>
        examInfoById.set(x.id, { title: x.title, course_id: x.course_id ?? null }),
      );
      const courseIds = Array.from(
        new Set(
          Array.from(examInfoById.values())
            .map((v) => v.course_id)
            .filter(Boolean) as string[],
        ),
      );
      const courseNameById = new Map<string, string>();
      if (courseIds.length) {
        const { data: courses } = await db.from("courses").select("id, name").in("id", courseIds);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((courses ?? []) as any[]).forEach((c) => courseNameById.set(c.id, c.name));
      }

      const nameById = new Map<string, string>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((usersRes.data ?? []) as any[]).forEach((p) => nameById.set(p.id, p.full_name));

      setRows(
        notes.map((n) => {
          const exam = examInfoById.get(n.exam_id);
          return {
            ...n,
            examTitle: exam?.title,
            courseName: exam?.course_id ? courseNameById.get(exam.course_id) : undefined,
            studentName: nameById.get(n.user_id),
          };
        }),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const approve = async (note: ExamNoteRow) => {
    setBusyId(note.id);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    // .select() permite saber cuántas filas afectó realmente el UPDATE.
    // Sin esto, RLS puede denegar silenciosamente (0 rows affected, sin
    // error) y el usuario veía la fila desaparecer del modal aunque la
    // BD seguía con status='pendiente'.
    const { data: updated, error } = await db
      .from("exam_notes")
      .update({
        status: "aprobada",
        rejection_reason: null,
        reviewed_by: user?.id ?? null,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", note.id)
      .select("id, status");
    setBusyId(null);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    if (!updated || (updated as { id: string }[]).length === 0) {
      toast.error(
        "No se pudo aprobar la nota (sin permisos o la nota ya no existe). Recarga e intenta de nuevo.",
      );
      return;
    }
    toast.success(`Notas de ${note.studentName ?? "estudiante"} aprobadas`);
    setRows((prev) => prev.filter((r) => r.id !== note.id));
    // Fire-and-forget: el correo se manda por la cadena trigger + edge.
    // Si la inserción de notif falla por algún motivo, el flujo de
    // aprobación ya completó — no rollback.
    void notifyExamNoteReviewed({
      studentId: note.user_id,
      examId: note.exam_id,
      examTitle: note.examTitle,
      approved: true,
    });
    onChange?.();
  };

  const startReject = (note: ExamNoteRow) => {
    setRejectingId(note.id);
    setRejectReason("");
  };

  const cancelReject = () => {
    setRejectingId(null);
    setRejectReason("");
  };

  const confirmReject = async (note: ExamNoteRow) => {
    const reason = rejectReason.trim();
    if (!reason) {
      toast.error("Escribe un motivo para rechazar");
      return;
    }
    setBusyId(note.id);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    // .select() expone si RLS bloqueó silenciosamente: devuelve [] sin
    // error. Antes el modal eliminaba la fila localmente aunque la BD
    // seguía con status='pendiente', por eso el badge del dashboard no
    // se actualizaba al recargar.
    const { data: updated, error } = await db
      .from("exam_notes")
      .update({
        status: "rechazada",
        rejection_reason: reason,
        reviewed_by: user?.id ?? null,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", note.id)
      .select("id, status");
    setBusyId(null);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    if (!updated || (updated as { id: string }[]).length === 0) {
      toast.error(
        "No se pudo rechazar la nota (sin permisos o la nota ya no existe). Recarga e intenta de nuevo.",
      );
      return;
    }
    toast.success("Rechazadas — el estudiante puede reenviar");
    setRows((prev) => prev.filter((r) => r.id !== note.id));
    setRejectingId(null);
    setRejectReason("");
    void notifyExamNoteReviewed({
      studentId: note.user_id,
      examId: note.exam_id,
      examTitle: note.examTitle,
      approved: false,
      rejectionReason: reason,
    });
    onChange?.();
  };

  const goTo = (note: ExamNoteRow) => {
    onOpenChange(false);
    navigate({
      to: "/app/teacher/exams/$examId",
      params: { examId: note.exam_id },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-xl max-h-[85vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Notas de examen pendientes
            {!loading && (
              <Badge variant="secondary" className="text-[10px]">
                {rows.length}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
            <Spinner size="md" /> Cargando…
          </div>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No hay notas de apoyo pendientes 🎉
          </p>
        ) : (
          <div className="space-y-1.5 min-w-0">
            {rows.map((note) => (
              <PendingNoteRow
                key={note.id}
                note={note}
                busy={busyId === note.id}
                rejecting={rejectingId === note.id}
                rejectReason={rejectReason}
                setRejectReason={setRejectReason}
                onApprove={() => approve(note)}
                onStartReject={() => startReject(note)}
                onCancelReject={cancelReject}
                onConfirmReject={() => confirmReject(note)}
                onGo={() => goTo(note)}
              />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PendingNoteRow({
  note,
  busy,
  rejecting,
  rejectReason,
  setRejectReason,
  onApprove,
  onStartReject,
  onCancelReject,
  onConfirmReject,
  onGo,
}: {
  note: ExamNoteRow;
  busy: boolean;
  rejecting: boolean;
  rejectReason: string;
  setRejectReason: (v: string) => void;
  onApprove: () => void;
  onStartReject: () => void;
  onCancelReject: () => void;
  onConfirmReject: () => void;
  onGo: () => void;
}) {
  return (
    <div className="rounded-md border p-2.5 space-y-2 min-w-0">
      <div className="flex w-full min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1 space-y-0.5 overflow-hidden">
          <div className="text-sm font-medium truncate">{note.studentName ?? "Estudiante"}</div>
          <div className="text-xs text-muted-foreground truncate">
            {note.courseName ? `${note.courseName} · ` : ""}
            {note.examTitle ?? "(examen eliminado)"}
          </div>
          <div className="text-[10px] text-muted-foreground/70 tabular-nums truncate">
            Subidas {formatDateTime(note.created_at)}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={onGo} title="Abrir el examen">
            Ir <ArrowRight className="h-3 w-3 ml-1" />
          </Button>
        </div>
      </div>

      {/* Preview del contenido — pequeño, scroll si es largo. */}
      <pre className="whitespace-pre-wrap text-[11px] leading-relaxed bg-muted/40 rounded p-2 max-h-24 overflow-y-auto">
        {note.content}
      </pre>

      {rejecting ? (
        <div className="space-y-1.5">
          <Textarea
            rows={2}
            placeholder="Motivo del rechazo…"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            className="text-xs"
          />
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={onCancelReject} disabled={busy}>
              <X className="h-3 w-3 mr-1" />
              Cancelar
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={onConfirmReject}
              disabled={busy || !rejectReason.trim()}
            >
              {busy ? (
                <Spinner size="xs" />
              ) : (
                <>
                  <ThumbsDown className="h-3 w-3 mr-1" />
                  Confirmar rechazo
                </>
              )}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="outline" onClick={onStartReject} disabled={busy}>
            <ThumbsDown className="h-3 w-3 mr-1" />
            Rechazar
          </Button>
          <Button size="sm" onClick={onApprove} disabled={busy}>
            {busy ? (
              <Spinner size="xs" />
            ) : (
              <>
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Aprobar
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
