import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Clock, ExternalLink, Send, Loader2, CheckCircle2,
  AlertTriangle, MessageSquare, Hammer,
} from "lucide-react";

export const Route = createFileRoute("/app/student/workshops")({ component: StudentWorkshops });

type WorkshopRow = {
  workshop: {
    id: string; title: string; description: string | null; instructions: string | null;
    external_link: string | null; due_date: string | null; max_score: number; status: string;
    course: { name: string };
  };
  submission?: {
    id: string; content: string | null; external_link: string | null;
    ai_grade: number | null; ai_feedback: string | null;
    final_grade: number | null; teacher_feedback: string | null;
    status: string; submitted_at: string | null;
  };
};

function StudentWorkshops() {
  const { user } = useAuth();
  const [rows, setRows] = useState<WorkshopRow[]>([]);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [activeWs, setActiveWs] = useState<WorkshopRow | null>(null);
  const [content, setContent] = useState("");
  const [link, setLink] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: asg } = await supabase
        .from("workshop_assignments")
        .select("workshop:workshops(id, title, description, instructions, external_link, due_date, max_score, status, course:courses(name))")
        .eq("user_id", user.id);

      const workshops = (asg ?? []).map((a: any) => a.workshop).filter(Boolean);
      const ids = workshops.map((w: any) => w.id);

      const { data: subs } = ids.length
        ? await supabase.from("workshop_submissions")
            .select("id, workshop_id, content, external_link, ai_grade, ai_feedback, final_grade, teacher_feedback, status, submitted_at")
            .in("workshop_id", ids)
            .eq("user_id", user.id)
        : { data: [] as any[] };

      setRows(workshops.map((w: any) => ({
        workshop: w,
        submission: subs?.find((s: any) => s.workshop_id === w.id),
      })));
    })();
  }, [user]);

  const openSubmit = (row: WorkshopRow) => {
    setActiveWs(row);
    setContent(row.submission?.content ?? "");
    setLink(row.submission?.external_link ?? "");
    setSubmitOpen(true);
  };

  const handleSubmit = async () => {
    if (!user || !activeWs) return;
    if (!content.trim() && !link.trim()) {
      toast.error("Escribe algo o proporciona un link");
      return;
    }
    setSubmitting(true);

    const payload = {
      workshop_id: activeWs.workshop.id,
      user_id: user.id,
      content: content || null,
      external_link: link || null,
      status: "entregado" as const,
      submitted_at: new Date().toISOString(),
    };

    if (activeWs.submission) {
      const { error } = await supabase.from("workshop_submissions")
        .update(payload)
        .eq("id", activeWs.submission.id);
      if (error) { toast.error(error.message); setSubmitting(false); return; }
    } else {
      const { error } = await supabase.from("workshop_submissions").insert(payload);
      if (error) { toast.error(error.message); setSubmitting(false); return; }
    }

    toast.success("Taller entregado");
    setSubmitOpen(false);
    setSubmitting(false);

    // Refresh
    const { data: sub } = await supabase.from("workshop_submissions")
      .select("*")
      .eq("workshop_id", activeWs.workshop.id)
      .eq("user_id", user.id)
      .maybeSingle();

    setRows(prev => prev.map(r =>
      r.workshop.id === activeWs.workshop.id ? { ...r, submission: sub ?? undefined } : r
    ));
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Mis Talleres</h1>
        <p className="text-sm text-muted-foreground">{rows.length} talleres asignados</p>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        {rows.length === 0 && <p className="text-muted-foreground text-sm">No tienes talleres asignados.</p>}
        {rows.map(({ workshop, submission }) => {
          const isOverdue = workshop.due_date && new Date(workshop.due_date).getTime() < Date.now();
          const grade = submission?.final_grade ?? submission?.ai_grade;
          return (
            <Card key={workshop.id}>
              <CardContent className="p-5 space-y-3">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">{workshop.course?.name}</div>
                    <h3 className="font-semibold truncate">{workshop.title}</h3>
                  </div>
                  {submission?.status === "calificado" ? (
                    <Badge className="shrink-0">
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      Nota: {grade}
                    </Badge>
                  ) : submission?.status === "entregado" ? (
                    <Badge variant="secondary" className="shrink-0">Entregado</Badge>
                  ) : isOverdue ? (
                    <Badge variant="destructive" className="shrink-0">
                      <AlertTriangle className="h-3 w-3 mr-1" />Vencido
                    </Badge>
                  ) : workshop.status === "published" ? (
                    <Badge className="bg-success text-success-foreground shrink-0">Abierto</Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0">{workshop.status === "draft" ? "Próximo" : "Cerrado"}</Badge>
                  )}
                </div>

                {workshop.description && <p className="text-sm text-muted-foreground line-clamp-2">{workshop.description}</p>}

                <div className="text-xs text-muted-foreground space-y-0.5">
                  {workshop.due_date && (
                    <div className="flex items-center gap-1.5">
                      <Clock className="h-3 w-3" />Fecha límite: {new Date(workshop.due_date).toLocaleString()}
                    </div>
                  )}
                  <div>Puntaje máximo: {workshop.max_score}</div>
                </div>

                {workshop.external_link && (
                  <a href={workshop.external_link} target="_blank" rel="noopener noreferrer"
                    className="text-sm text-primary flex items-center gap-1 hover:underline">
                    <ExternalLink className="h-3 w-3" /> Material del taller
                  </a>
                )}

                {submission?.teacher_feedback && (
                  <div className="bg-muted/50 p-2 rounded text-sm">
                    <div className="text-xs font-medium flex items-center gap-1 mb-1">
                      <MessageSquare className="h-3 w-3" /> Retroalimentación del docente
                    </div>
                    {submission.teacher_feedback}
                  </div>
                )}

                {workshop.status === "published" && submission?.status !== "calificado" && (
                  <Button size="sm" className="w-full" onClick={() => openSubmit({ workshop, submission })}>
                    <Send className="h-4 w-4 mr-1" />
                    {submission ? "Actualizar entrega" : "Entregar taller"}
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Submit Dialog */}
      <Dialog open={submitOpen} onOpenChange={setSubmitOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Entregar — {activeWs?.workshop.title}</DialogTitle>
          </DialogHeader>
          {activeWs?.workshop.instructions && (
            <div className="bg-muted/50 p-3 rounded text-sm">
              <div className="text-xs font-medium mb-1">Instrucciones:</div>
              {activeWs.workshop.instructions}
            </div>
          )}
          <div className="space-y-3">
            <div>
              <Label>Tu respuesta / contenido</Label>
              <Textarea rows={5} value={content} onChange={e => setContent(e.target.value)} placeholder="Escribe tu respuesta aquí..." />
            </div>
            <div>
              <Label>Link externo (opcional)</Label>
              <Input placeholder="https://github.com/..." value={link} onChange={e => setLink(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSubmitOpen(false)}>Cancelar</Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
              Entregar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
