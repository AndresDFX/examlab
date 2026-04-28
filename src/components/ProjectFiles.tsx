/**
 * Project module — espejo de Talleres pero con "archivos" en vez de preguntas.
 *
 * - El docente define un proyecto con N archivos esperados. Cada archivo tiene
 *   un título descriptivo (p. ej. "Documento de diseño", "Código fuente",
 *   "Evidencias de pruebas") y una rúbrica esperada que la IA usa para
 *   calificar.
 * - El estudiante NO sube archivos binarios: pega el contenido textual de
 *   cada archivo en una caja de texto. Al enviar, la IA califica cada caja
 *   por separado usando la rúbrica del archivo, devuelve puntaje + feedback
 *   + probabilidad de que la respuesta haya sido generada por IA.
 * - La nota final del proyecto se consolida sobre `max_score` con la suma
 *   ponderada de los puntos de cada archivo.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Plus, Trash2, Loader2, Sparkles, Send, FileText } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";

// `projects` y `project_*` aún no se reflejan en los types generados de
// Supabase; cast lazo para no obligar a regenerar tipos en cada cambio.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type ProjectFile = {
  id: string;
  project_id: string;
  position: number;
  title: string;
  description: string | null;
  expected_rubric: string | null;
  language: string | null;
  points: number;
};

/* =========================================================================
   TEACHER: Editor de archivos esperados del proyecto (manual + IA)
   ========================================================================= */
export function TeacherProjectFilesEditor({
  projectId,
  courseLanguage = "es",
}: {
  projectId: string;
  courseLanguage?: "es" | "en";
}) {
  const confirm = useConfirm();
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [loading, setLoading] = useState(true);

  // manual form
  const [fTitle, setFTitle] = useState("");
  const [fDescription, setFDescription] = useState("");
  const [fRubric, setFRubric] = useState("");
  const [fPoints, setFPoints] = useState(1);

  // AI form
  const [aiTopic, setAiTopic] = useState("");
  const [aiCount, setAiCount] = useState(3);
  const [aiLoading, setAiLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data } = await db
      .from("project_files")
      .select("*")
      .eq("project_id", projectId)
      .order("position");
    setFiles((data ?? []) as ProjectFile[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const addManual = async () => {
    if (!fTitle.trim()) {
      toast.error("Escribe el título del archivo");
      return;
    }
    const { error } = await db.from("project_files").insert({
      project_id: projectId,
      title: fTitle,
      description: fDescription || null,
      expected_rubric: fRubric || null,
      points: fPoints,
      position: files.length,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Archivo añadido");
    setFTitle("");
    setFDescription("");
    setFRubric("");
    setFPoints(1);
    void load();
  };

  const removeFile = async (id: string) => {
    const ok = await confirm({
      title: "Eliminar archivo",
      description: "Se eliminará este slot del proyecto.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("project_files").delete().eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Archivo eliminado");
    void load();
  };

  const generateWithAI = async () => {
    if (!aiTopic.trim()) {
      toast.error("Indica el tema del proyecto");
      return;
    }
    if (aiCount < 1 || aiCount > 20) {
      toast.error("El número de archivos debe estar entre 1 y 20");
      return;
    }
    setAiLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("ai-generate-questions", {
        body: {
          projectFilesGeneration: true,
          projectId,
          topic: aiTopic,
          count: aiCount,
          courseLanguage,
        },
      });
      if (error || data?.error) {
        toast.error(error?.message ?? data?.error ?? "Error generando con IA");
        return;
      }
      toast.success(`${data?.inserted?.length ?? aiCount} archivo(s) generados con IA`);
      setAiTopic("");
      void load();
    } catch (e: any) {
      toast.error(e.message ?? "Error IA");
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Tabs defaultValue="list" className="w-full">
        <TabsList>
          <TabsTrigger value="list">Archivos ({files.length})</TabsTrigger>
          <TabsTrigger value="manual">Agregar manual</TabsTrigger>
          <TabsTrigger value="ai">Generar con IA</TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="space-y-2">
          {loading && (
            <p className="text-sm text-muted-foreground">
              <Loader2 className="inline h-3 w-3 animate-spin mr-1" /> Cargando…
            </p>
          )}
          {!loading && files.length === 0 && (
            <p className="text-sm text-muted-foreground">Aún no hay archivos definidos.</p>
          )}
          {files.map((f, idx) => (
            <Card key={f.id}>
              <CardContent className="p-3 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      {idx + 1}
                    </Badge>
                    <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-medium text-sm">{f.title}</span>
                    <span className="text-xs text-muted-foreground">{f.points} pts</span>
                  </div>
                  {f.description && (
                    <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                      {f.description}
                    </p>
                  )}
                  {f.expected_rubric && (
                    <p className="text-[11px] italic text-muted-foreground/80 whitespace-pre-wrap">
                      Rúbrica: {f.expected_rubric}
                    </p>
                  )}
                </div>
                <Button variant="ghost" size="icon" onClick={() => removeFile(f.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="manual" className="space-y-3">
          <div>
            <Label>Título del archivo</Label>
            <Input
              value={fTitle}
              onChange={(e) => setFTitle(e.target.value)}
              placeholder="Ej.: Documento de diseño"
            />
          </div>
          <div>
            <Label>Descripción para el estudiante</Label>
            <Textarea
              value={fDescription}
              onChange={(e) => setFDescription(e.target.value)}
              rows={3}
              placeholder="Qué debe contener este archivo…"
            />
          </div>
          <div>
            <Label>Rúbrica esperada (para IA)</Label>
            <Textarea
              value={fRubric}
              onChange={(e) => setFRubric(e.target.value)}
              rows={2}
              placeholder="Criterios objetivos para una buena entrega"
            />
          </div>
          <div>
            <Label>Puntos</Label>
            <Input
              type="number"
              min={0}
              value={fPoints || ""}
              onChange={(e) => setFPoints(e.target.value === "" ? 0 : Number(e.target.value))}
            />
          </div>
          <Button onClick={addManual}>
            <Plus className="h-4 w-4 mr-1" /> Agregar archivo
          </Button>
        </TabsContent>

        <TabsContent value="ai" className="space-y-3">
          <div>
            <Label>Tema del proyecto</Label>
            <Textarea
              value={aiTopic}
              onChange={(e) => setAiTopic(e.target.value)}
              rows={3}
              placeholder="Sistema de gestión bibliotecaria con autenticación…"
            />
          </div>
          <div>
            <Label>Número de archivos</Label>
            <Input
              type="number"
              min={1}
              max={20}
              value={aiCount}
              onChange={(e) => setAiCount(Number(e.target.value) || 3)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              La IA creará una caja de texto por cada archivo solicitado, con título y rúbrica.
              El estudiante pegará el contenido de cada archivo en su caja.
            </p>
          </div>
          <Button onClick={generateWithAI} disabled={aiLoading}>
            {aiLoading ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4 mr-1" />
            )}
            Generar archivos con IA
          </Button>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* =========================================================================
   STUDENT: Entrega del proyecto archivo por archivo + calificación IA
   ========================================================================= */
export function StudentProjectTaker({
  projectId,
  projectTitle,
  maxScore,
  courseLanguage = "es",
  onGraded,
}: {
  projectId: string;
  projectTitle: string;
  maxScore: number;
  courseLanguage?: "es" | "en";
  onGraded?: (finalGrade: number) => void;
}) {
  const { user } = useAuth();
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [graded, setGraded] = useState<{ grade: number } | null>(null);

  useEffect(() => {
    if (!user) return;
    (async () => {
      setLoading(true);
      const { data: fs } = await db
        .from("project_files")
        .select("*")
        .eq("project_id", projectId)
        .order("position");
      setFiles((fs ?? []) as ProjectFile[]);

      const { data: sub } = await db
        .from("project_submissions")
        .select("id, final_grade, status")
        .eq("project_id", projectId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (sub?.id) {
        const { data: ans } = await db
          .from("project_submission_files")
          .select("file_id, content")
          .eq("submission_id", sub.id);
        const map: Record<string, string> = {};
        for (const a of (ans ?? []) as { file_id: string; content: string | null }[]) {
          map[a.file_id] = a.content ?? "";
        }
        setContents(map);
        if (sub.status === "calificado" && sub.final_grade != null) {
          setGraded({ grade: Number(sub.final_grade) });
        }
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, user]);

  const updateContent = (fileId: string, value: string) => {
    setContents((prev) => ({ ...prev, [fileId]: value }));
  };

  const submit = async () => {
    if (!user) return;
    if (!files.length) {
      toast.error("Este proyecto no tiene archivos definidos");
      return;
    }
    const empty = files.find((f) => !(contents[f.id] ?? "").trim());
    if (empty) {
      toast.error(`Falta contenido en: ${empty.title}`);
      return;
    }
    setSubmitting(true);
    try {
      // Upsert project submission
      let submissionId: string;
      const { data: existing } = await db
        .from("project_submissions")
        .select("id")
        .eq("project_id", projectId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (existing?.id) {
        submissionId = existing.id;
        await db
          .from("project_submissions")
          .update({ status: "entregado", submitted_at: new Date().toISOString() })
          .eq("id", submissionId);
      } else {
        const { data: created, error } = await db
          .from("project_submissions")
          .insert({
            project_id: projectId,
            user_id: user.id,
            status: "entregado",
            submitted_at: new Date().toISOString(),
          })
          .select("id")
          .single();
        if (error || !created) {
          toast.error(error?.message ?? "No se pudo crear la entrega");
          setSubmitting(false);
          return;
        }
        submissionId = created.id;
      }

      // Grade each file slot one-by-one
      let totalEarned = 0;
      let totalPoints = 0;

      for (const f of files) {
        const content = contents[f.id] ?? "";
        totalPoints += Number(f.points) || 0;

        const payload: any = {
          submission_id: submissionId,
          file_id: f.id,
          content,
        };

        if (!content.trim()) {
          payload.ai_grade = 0;
          payload.ai_feedback = "Sin contenido";
        } else {
          const { data: aiData, error: aiErr } = await supabase.functions.invoke(
            "ai-grade-submission",
            {
              body: {
                projectFileGrading: true,
                fileTitle: f.title,
                fileDescription: f.description,
                expectedRubric: f.expected_rubric,
                maxPoints: f.points,
                studentContent: content,
                courseLanguage,
              },
            },
          );
          if (aiErr || aiData?.error) {
            payload.ai_grade = 0;
            payload.ai_feedback = `Error IA: ${aiErr?.message ?? aiData?.error ?? "Desconocido"}`;
          } else {
            payload.ai_grade = Number(aiData?.grade) || 0;
            payload.ai_feedback = aiData?.feedback ?? null;
            payload.ai_likelihood =
              typeof aiData?.ai_likelihood === "number" ? aiData.ai_likelihood : null;
            payload.ai_reasons = aiData?.ai_reasons ?? null;
          }
        }

        await db
          .from("project_submission_files")
          .upsert(payload, { onConflict: "submission_id,file_id" });

        totalEarned += Number(payload.ai_grade) || 0;
      }

      const finalGrade =
        totalPoints > 0 ? Number(((totalEarned / totalPoints) * Number(maxScore)).toFixed(2)) : 0;

      await db
        .from("project_submissions")
        .update({
          ai_grade: finalGrade,
          final_grade: finalGrade,
          ai_feedback: `Calificación automática inmediata sobre ${maxScore} pts.`,
          status: "calificado",
        })
        .eq("id", submissionId);

      setGraded({ grade: finalGrade });
      onGraded?.(finalGrade);
      toast.success(`Calificación: ${finalGrade} / ${maxScore}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground">
        <Loader2 className="inline h-3 w-3 animate-spin mr-1" /> Cargando archivos…
      </p>
    );
  }

  if (!files.length) {
    return <p className="text-sm text-muted-foreground">Este proyecto aún no tiene archivos.</p>;
  }

  if (graded) {
    return (
      <Card className="border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle className="text-base">Resultado del proyecto</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tabular-nums">
            {graded.grade} / {maxScore}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            La calificación fue generada automáticamente por IA al enviar el proyecto.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="font-semibold">{projectTitle}</h3>
      <p className="text-xs text-muted-foreground">
        Pega el contenido de cada archivo en la caja correspondiente. Cuando envíes, la IA
        calificará cada archivo según la rúbrica.
      </p>
      {files.map((f, idx) => (
        <Card key={f.id}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-[10px]">
                {idx + 1}
              </Badge>
              <FileText className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{f.title}</span>
              <span className="text-xs text-muted-foreground ml-auto">{f.points} pts</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {f.description && (
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{f.description}</p>
            )}
            <Textarea
              rows={10}
              value={contents[f.id] ?? ""}
              onChange={(e) => updateContent(f.id, e.target.value)}
              placeholder={`Pega aquí el contenido del archivo: ${f.title}`}
              className="font-mono text-xs"
            />
          </CardContent>
        </Card>
      ))}
      <div className="sticky bottom-2 z-10 bg-background/80 backdrop-blur p-2 rounded-lg border">
        <Button onClick={submit} disabled={submitting} className="w-full">
          {submitting ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Send className="h-4 w-4 mr-1" />
          )}
          Enviar proyecto y calificar con IA
        </Button>
      </div>
    </div>
  );
}
