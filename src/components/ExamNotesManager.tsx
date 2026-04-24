import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { FileText, CheckCircle2, XCircle, Clock, Upload } from "lucide-react";

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
      const { error } = await supabase
        .from("exam_notes" as any)
        .update({ content: txt, status: "pendiente", rejection_reason: null })
        .eq("id", note.id);
      if (error) toast.error(error.message);
      else toast.success("Notas enviadas para revisión");
    } else {
      const { error } = await supabase
        .from("exam_notes" as any)
        .insert({ exam_id: examId, user_id: userId, content: txt, status: "pendiente" });
      if (error) toast.error(error.message);
      else toast.success("Notas enviadas para revisión");
    }
    setBusy(false);
    void load();
  };

  if (loading) return <p className="text-xs text-muted-foreground">Cargando notas…</p>;

  const isApproved = note?.status === "aprobada";
  const isRejected = note?.status === "rechazada";
  const isPending = note?.status === "pendiente";

  return (
    <Card className="border-dashed">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <FileText className="h-3.5 w-3.5 text-primary" />
            Notas de apoyo
          </div>
          {note && (
            <Badge
              variant={isApproved ? "default" : isRejected ? "destructive" : "secondary"}
              className="text-[10px]"
            >
              {isApproved ? (
                <>
                  <CheckCircle2 className="h-3 w-3 mr-0.5" />
                  Aprobada
                </>
              ) : isRejected ? (
                <>
                  <XCircle className="h-3 w-3 mr-0.5" />
                  Rechazada
                </>
              ) : (
                <>
                  <Clock className="h-3 w-3 mr-0.5" />
                  En revisión
                </>
              )}
            </Badge>
          )}
        </div>
        {isRejected && note?.rejection_reason && (
          <div className="text-[11px] rounded border border-destructive/40 bg-destructive/5 p-2 text-destructive">
            <strong>Motivo:</strong> {note.rejection_reason}
          </div>
        )}
        {isApproved ? (
          <pre className="whitespace-pre-wrap text-xs bg-muted/40 rounded p-2 max-h-40 overflow-y-auto">
            {note?.content}
          </pre>
        ) : (
          <>
            <Textarea
              rows={4}
              placeholder="Escribe el texto plano que quieres tener disponible durante el examen…"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="text-xs"
              disabled={isPending}
            />
            {isPending ? (
              <p className="text-[11px] text-muted-foreground">
                Tu docente debe aprobarlas antes de presentar el examen.
              </p>
            ) : (
              <Button size="sm" onClick={submit} disabled={busy} className="w-full">
                <Upload className="h-3.5 w-3.5 mr-1" />
                {note ? "Reenviar a revisión" : "Enviar a revisión"}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
