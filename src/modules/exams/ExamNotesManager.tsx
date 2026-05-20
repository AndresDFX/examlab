import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { notifyExamNoteReviewed } from "@/modules/exams/exam-notes-notify";
import { friendlyError } from "@/shared/lib/db-errors";
import {
  FileText,
  CheckCircle2,
  XCircle,
  Clock,
  Upload,
  ThumbsUp,
  ThumbsDown,
  User,
} from "lucide-react";

export type ExamNote = {
  id: string;
  exam_id: string;
  user_id: string;
  content: string;
  status: "pendiente" | "aprobada" | "rechazada";
  rejection_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
};

/**
 * Student-facing exam notes manager.
 * Allows uploading a plain-text "cheat sheet" associated to an exam.
 * Workflow: pendiente → aprobada (visible during take) | rechazada (motivo + re-subir).
 */
export function StudentExamNotes({ examId, userId }: { examId: string; userId: string }) {
  const [note, setNote] = useState<ExamNote | null>(null);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  /** Abre el dialog Y recarga el estado de la nota. Esto evita el caso
   *  donde el docente rechazó después del último load() y el estudiante
   *  abriría el dialog viendo info stale (sin razón de rechazo). El
   *  reload es async — el dialog ya está abierto cuando llega la
   *  respuesta, y la UI se actualiza in-place. */
  const openDialog = async () => {
    setOpen(true);
    await load();
  };

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("exam_notes" as any)
      .select("*")
      .eq("exam_id", examId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const n = (data ?? null) as unknown as ExamNote | null;
    setNote(n);
    setContent(n?.content ?? "");
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId, userId]);

  const submit = async () => {
    const txt = content.trim();
    if (!txt) {
      toast.error("Escribe el contenido de tus notas");
      return;
    }
    setBusy(true);
    if (note && note.status !== "aprobada") {
      // Reenvío tras rechazo: limpia la razón y vuelve a pendiente.
      // .select() expone deny silencioso de RLS (0 rows updated).
      const { data: updated, error } = await supabase
        .from("exam_notes" as any)
        .update({ content: txt, status: "pendiente", rejection_reason: null })
        .eq("id", note.id)
        .select("id");
      if (error) toast.error(friendlyError(error));
      else if (!updated || (updated as unknown as { id: string }[]).length === 0)
        toast.error("No se pudo enviar la nota. Recarga e intenta de nuevo.");
      else toast.success("Notas enviadas para revisión");
    } else {
      const { error } = await supabase
        .from("exam_notes" as any)
        .insert({ exam_id: examId, user_id: userId, content: txt, status: "pendiente" });
      if (error) toast.error(friendlyError(error));
      else toast.success("Notas enviadas para revisión");
    }
    setBusy(false);
    void load();
  };

  if (loading) return null;

  const isApproved = note?.status === "aprobada";
  const isRejected = note?.status === "rechazada";
  const isPending = note?.status === "pendiente";

  const statusBadge = note ? (
    <Badge
      variant={isApproved ? "default" : isRejected ? "destructive" : "secondary"}
      className="text-[10px]"
    >
      {isApproved ? (
        <>
          <CheckCircle2 className="h-3 w-3 mr-0.5" /> Aprobada
        </>
      ) : isRejected ? (
        <>
          <XCircle className="h-3 w-3 mr-0.5" /> Rechazada
        </>
      ) : (
        <>
          <Clock className="h-3 w-3 mr-0.5" /> En revisión
        </>
      )}
    </Badge>
  ) : null;

  return (
    <>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2 text-xs">
          <button
            type="button"
            onClick={() => void openDialog()}
            className="inline-flex items-center gap-1.5 text-primary hover:underline font-medium"
          >
            <FileText className="h-3.5 w-3.5" />
            {note ? "Ver / editar mis notas de apoyo" : "Subir notas de apoyo"}
          </button>
          {statusBadge}
        </div>
        {/* Preview de la razón de rechazo en el card — visible sin
            tener que abrir el dialog. Ayuda al alumno a entender de
            inmediato qué corregir antes de re-enviar. Una línea con
            truncate; el texto completo siempre vive en el dialog. */}
        {isRejected && note?.rejection_reason && (
          <div className="flex items-start gap-1.5 text-[11px] text-destructive border-l-2 border-destructive/40 pl-2">
            <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
            <span className="line-clamp-2" title={note.rejection_reason}>
              <strong>Motivo:</strong> {note.rejection_reason}
            </span>
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Notas de apoyo</DialogTitle>
            <DialogDescription>
              Sube un texto plano (resumen / chuleta) que tu docente debe aprobar antes del examen.
            </DialogDescription>
          </DialogHeader>
          {isRejected && note?.rejection_reason && (
            <div className="rounded border border-destructive/40 bg-destructive/5 p-3 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                <XCircle className="h-3.5 w-3.5" />
                Motivo del último rechazo
              </div>
              <p className="text-[12px] text-destructive whitespace-pre-wrap break-words">
                {note.rejection_reason}
              </p>
              <p className="text-[10px] text-muted-foreground pt-1">
                Corrige el contenido abajo y reenvía a revisión.
              </p>
            </div>
          )}
          {isApproved ? (
            <pre className="whitespace-pre-wrap text-xs bg-muted/40 rounded p-3 max-h-72 overflow-y-auto">
              {note?.content}
            </pre>
          ) : (
            <Textarea
              rows={8}
              placeholder="Escribe el texto plano que quieres tener disponible durante el examen…"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="text-sm"
              disabled={isPending}
            />
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cerrar
            </Button>
            {!isApproved && !isPending && (
              <Button onClick={submit} disabled={busy}>
                <Upload className="h-3.5 w-3.5 mr-1" />
                {note ? "Reenviar a revisión" : "Enviar a revisión"}
              </Button>
            )}
            {isPending && (
              <span className="text-[11px] text-muted-foreground self-center">
                Tu docente debe aprobarlas.
              </span>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type TeacherExamNoteRow = ExamNote & {
  profile?: { full_name: string; institutional_email: string } | null;
};

/**
 * Teacher-facing exam notes review panel.
 * Lists every student's submitted note for an exam and lets the teacher
 * approve or reject (with mandatory reason) each one.
 */
export function TeacherExamNotes({ examId }: { examId: string }) {
  const [notes, setNotes] = useState<TeacherExamNoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [rejectDialog, setRejectDialog] = useState<{ open: boolean; noteId: string | null }>({
    open: false,
    noteId: null,
  });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("exam_notes" as any)
      .select("*")
      .eq("exam_id", examId)
      .order("created_at", { ascending: false });
    const rows = (data ?? []) as unknown as ExamNote[];
    // Fetch profiles separately (no FK relation defined for join in types)
    const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
    let profMap = new Map<string, { full_name: string; institutional_email: string }>();
    if (userIds.length) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, full_name, institutional_email")
        .in("id", userIds);
      profMap = new Map((profs ?? []).map((p: any) => [p.id, p]));
    }
    setNotes(rows.map((r) => ({ ...r, profile: profMap.get(r.user_id) ?? null })));
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId]);

  const approve = async (noteId: string) => {
    setBusy(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    // .select() detecta deny silencioso de RLS (0 rows affected sin
    // error). Sin esto, el toast decía "Aprobadas" aunque la BD seguía
    // sin cambios y el badge "Pendiente" reaparecía al recargar.
    const { data: updated, error } = await supabase
      .from("exam_notes" as any)
      .update({
        status: "aprobada",
        rejection_reason: null,
        reviewed_by: user?.id ?? null,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", noteId)
      .select("id");
    setBusy(false);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    if (!updated || (updated as unknown as { id: string }[]).length === 0) {
      toast.error(
        "No se pudo aprobar la nota (sin permisos o la nota ya no existe). Recarga e intenta de nuevo.",
      );
      return;
    }
    toast.success("Notas aprobadas");
    // Notif al estudiante → dispara correo. El examId lo tenemos en el
    // scope; el user_id lo sacamos del row local (cargado por `load`).
    // El helper resuelve el título del examen vía query si hace falta.
    const noteRow = notes.find((n) => n.id === noteId);
    if (noteRow) {
      void notifyExamNoteReviewed({
        studentId: noteRow.user_id,
        examId,
        approved: true,
      });
    }
    void load();
  };

  const openReject = (noteId: string) => {
    setReason("");
    setRejectDialog({ open: true, noteId });
  };

  const confirmReject = async () => {
    if (!reason.trim()) {
      toast.error("Debes ingresar un motivo de rechazo");
      return;
    }
    if (!rejectDialog.noteId) return;
    setBusy(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data: updated, error } = await supabase
      .from("exam_notes" as any)
      .update({
        status: "rechazada",
        rejection_reason: reason.trim(),
        reviewed_by: user?.id ?? null,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", rejectDialog.noteId)
      .select("id");
    setBusy(false);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    if (!updated || (updated as unknown as { id: string }[]).length === 0) {
      toast.error(
        "No se pudo rechazar la nota (sin permisos o la nota ya no existe). Recarga e intenta de nuevo.",
      );
      return;
    }
    toast.success("Notas rechazadas — el estudiante podrá reenviar");
    const rejectedNoteId = rejectDialog.noteId;
    const rejectedReason = reason.trim();
    setRejectDialog({ open: false, noteId: null });
    const noteRow = notes.find((n) => n.id === rejectedNoteId);
    if (noteRow) {
      void notifyExamNoteReviewed({
        studentId: noteRow.user_id,
        examId,
        approved: false,
        rejectionReason: rejectedReason,
      });
    }
    void load();
  };

  if (loading) return <p className="text-sm text-muted-foreground">Cargando notas…</p>;

  if (notes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Aún no hay estudiantes que hayan subido notas para este examen.
      </p>
    );
  }

  const pending = notes.filter((n) => n.status === "pendiente");
  const approved = notes.filter((n) => n.status === "aprobada");
  const rejected = notes.filter((n) => n.status === "rechazada");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="secondary">{pending.length} pendientes</Badge>
        <Badge variant="default">{approved.length} aprobadas</Badge>
        <Badge variant="destructive">{rejected.length} rechazadas</Badge>
      </div>

      {notes.map((n) => {
        const statusBadge =
          n.status === "aprobada" ? (
            <Badge variant="default" className="text-[10px]">
              <CheckCircle2 className="h-3 w-3 mr-0.5" />
              Aprobada
            </Badge>
          ) : n.status === "rechazada" ? (
            <Badge variant="destructive" className="text-[10px]">
              <XCircle className="h-3 w-3 mr-0.5" />
              Rechazada
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-[10px]">
              <Clock className="h-3 w-3 mr-0.5" />
              Pendiente
            </Badge>
          );
        return (
          <Card key={n.id}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <User className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">
                      {n.profile?.full_name ?? "Estudiante"}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {n.profile?.institutional_email ?? n.user_id}
                    </div>
                  </div>
                </div>
                {statusBadge}
              </div>
              {n.status === "rechazada" && n.rejection_reason && (
                <div className="text-[11px] rounded border border-destructive/40 bg-destructive/5 p-2 text-destructive">
                  <strong>Motivo previo:</strong> {n.rejection_reason}
                </div>
              )}
              <pre className="whitespace-pre-wrap text-xs bg-muted/40 rounded p-2 max-h-48 overflow-y-auto">
                {n.content}
              </pre>
              {n.status === "pendiente" && (
                <div className="flex gap-2 justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openReject(n.id)}
                    disabled={busy}
                  >
                    <ThumbsDown className="h-3.5 w-3.5 mr-1" />
                    Rechazar
                  </Button>
                  <Button size="sm" onClick={() => approve(n.id)} disabled={busy}>
                    <ThumbsUp className="h-3.5 w-3.5 mr-1" />
                    Aprobar
                  </Button>
                </div>
              )}
              {n.status === "rechazada" && (
                <div className="flex justify-between items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    El estudiante puede subir una nueva versión.
                  </span>
                  <Button size="sm" onClick={() => approve(n.id)} disabled={busy}>
                    <ThumbsUp className="h-3.5 w-3.5 mr-1" />
                    Aprobar de todos modos
                  </Button>
                </div>
              )}
              {n.status === "aprobada" && (
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => openReject(n.id)}
                    disabled={busy}
                  >
                    <ThumbsDown className="h-3.5 w-3.5 mr-1" />
                    Revocar / rechazar
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      <Dialog
        open={rejectDialog.open}
        onOpenChange={(o) => !o && setRejectDialog({ open: false, noteId: null })}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rechazar notas de apoyo</DialogTitle>
            <DialogDescription>
              Indica el motivo del rechazo. El estudiante podrá ver tu razón y subir una nueva
              versión.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={4}
            placeholder="Ej: contiene fragmentos completos de respuestas, no es un resumen…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRejectDialog({ open: false, noteId: null })}
            >
              Cancelar
            </Button>
            <Button onClick={confirmReject} disabled={busy || !reason.trim()}>
              Rechazar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Hook for the student exam taker — fetches the approved note (if any) for
 * the current exam+user so it can be displayed alongside questions.
 */
export function useApprovedExamNote(examId: string, userId: string | undefined) {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    if (!examId || !userId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("exam_notes" as any)
        .select("content, status")
        .eq("exam_id", examId)
        .eq("user_id", userId)
        .eq("status", "aprobada")
        .order("reviewed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      const row = data as unknown as { content: string; status: string } | null;
      setContent(row?.content ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [examId, userId]);
  return content;
}
