import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Plus, Trash2, Loader2, Sparkles, Send } from "lucide-react";
import { CodeEditor } from "@/components/CodeEditor";
import { DiagramEditor } from "@/components/DiagramEditor";
import { JavaGuiRunner, JAVA_GUI_STARTER } from "@/components/JavaGuiRunner";
import { useConfirm } from "@/components/ConfirmDialog";
import { MarkdownInline } from "@/components/MarkdownInline";

export type WorkshopQuestion = {
  id: string;
  workshop_id: string;
  type: "abierta" | "cerrada" | "codigo" | "diagrama" | "java_gui";
  content: string;
  options: any;
  position: number;
  points: number;
  expected_rubric: string | null;
  starter_code: string | null;
  language: string | null;
};

/* =========================================================================
   TEACHER: Editor of workshop questions (manual + AI)
   ========================================================================= */
export function TeacherWorkshopQuestionsEditor({
  workshopId,
  courseLanguage = "es",
}: {
  workshopId: string;
  courseLanguage?: "es" | "en";
}) {
  const confirm = useConfirm();
  const [questions, setQuestions] = useState<WorkshopQuestion[]>([]);
  const [loading, setLoading] = useState(true);

  // manual question form
  const [qType, setQType] = useState<WorkshopQuestion["type"]>("abierta");
  const [qContent, setQContent] = useState("");
  const [qRubric, setQRubric] = useState("");
  const [qChoices, setQChoices] = useState(["", "", "", ""]);
  const [qCorrect, setQCorrect] = useState(0);
  const [qPoints, setQPoints] = useState(1);
  const [qLanguage, setQLanguage] = useState("java");

  // AI form
  const [aiTopics, setAiTopics] = useState("");
  const [aiCount, setAiCount] = useState(3);
  const [aiType, setAiType] = useState<WorkshopQuestion["type"]>("abierta");
  const [aiLanguage, setAiLanguage] = useState("java");
  const [aiLoading, setAiLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("workshop_questions")
      .select("*")
      .eq("workshop_id", workshopId)
      .order("position");
    setQuestions((data ?? []) as WorkshopQuestion[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, [workshopId]);

  const addManual = async () => {
    if (!qContent.trim()) {
      toast.error("Escribe el enunciado");
      return;
    }
    const options =
      qType === "cerrada"
        ? { choices: qChoices.filter((c) => c.trim()), correct_index: qCorrect }
        : null;
    const { error } = await supabase.from("workshop_questions").insert({
      workshop_id: workshopId,
      type: qType,
      content: qContent,
      expected_rubric: qRubric || null,
      options,
      points: qPoints,
      position: questions.length,
      language: qType === "codigo" ? qLanguage : qType === "java_gui" ? "java" : null,
      starter_code: qType === "java_gui" ? JAVA_GUI_STARTER : null,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Pregunta agregada");
    setQContent("");
    setQRubric("");
    setQChoices(["", "", "", ""]);
    setQCorrect(0);
    setQPoints(1);
    load();
  };

  const removeQ = async (id: string) => {
    const ok = await confirm({
      title: "Eliminar pregunta",
      description: "Se eliminará la pregunta del taller.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("workshop_questions").delete().eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Pregunta eliminada");
    load();
  };

  const generateWithAI = async () => {
    if (!aiTopics.trim()) {
      toast.error("Indica los temas");
      return;
    }
    setAiLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("ai-generate-questions", {
        body: {
          topics: aiTopics,
          type: aiType,
          count: aiCount,
          examId: workshopId, // legacy field reused by the function as targetId
          language: aiLanguage,
          courseLanguage,
          targetTable: "workshop_questions",
        },
      });
      if (error) {
        toast.error(error.message ?? "Error generando con IA");
      } else if (data?.error) {
        toast.error(data.error);
      } else if (data?.inserted) {
        toast.success(`${data.inserted.length} pregunta(s) generadas con IA`);
      }
      setAiTopics("");
      load();
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
          <TabsTrigger value="list">Preguntas ({questions.length})</TabsTrigger>
          <TabsTrigger value="manual">Agregar manual</TabsTrigger>
          <TabsTrigger value="ai">Generar con IA</TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="space-y-2">
          {loading && (
            <p className="text-sm text-muted-foreground">
              <Loader2 className="inline h-3 w-3 animate-spin mr-1" /> Cargando…
            </p>
          )}
          {!loading && questions.length === 0 && (
            <p className="text-sm text-muted-foreground">Aún no hay preguntas.</p>
          )}
          {questions.map((q, idx) => (
            <Card key={q.id}>
              <CardContent className="p-3 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline" className="text-[10px]">
                      {idx + 1}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px] capitalize">
                      {q.type}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{q.points} pts</span>
                  </div>
                  <div className="text-sm">
                    <MarkdownInline>{q.content}</MarkdownInline>
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => removeQ(q.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="manual" className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Tipo</Label>
              <Select value={qType} onValueChange={(v) => setQType(v as any)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="abierta">Abierta</SelectItem>
                  <SelectItem value="cerrada">Cerrada (opción múltiple)</SelectItem>
                  <SelectItem value="codigo">Código</SelectItem>
                  <SelectItem value="diagrama">Diagrama (Mermaid)</SelectItem>
                  <SelectItem value="java_gui">Java GUI (Swing/AWT)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Puntos</Label>
              <Input
                type="number"
                min={0}
                value={qPoints || ""}
                onChange={(e) => setQPoints(e.target.value === "" ? 0 : Number(e.target.value))}
              />
            </div>
          </div>
          <div>
            <Label>Enunciado</Label>
            <Textarea
              value={qContent}
              onChange={(e) => setQContent(e.target.value)}
              rows={3}
              placeholder="Describe la pregunta…"
            />
          </div>
          {qType === "cerrada" && (
            <div className="space-y-2">
              <Label>Opciones (marca la correcta)</Label>
              {qChoices.map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="correct"
                    checked={qCorrect === i}
                    onChange={() => setQCorrect(i)}
                  />
                  <Input
                    value={c}
                    onChange={(e) =>
                      setQChoices(qChoices.map((cc, j) => (j === i ? e.target.value : cc)))
                    }
                    placeholder={`Opción ${String.fromCharCode(65 + i)}`}
                  />
                </div>
              ))}
            </div>
          )}
          {qType === "codigo" && (
            <div>
              <Label>Lenguaje</Label>
              <Select value={qLanguage} onValueChange={setQLanguage}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="java">Java</SelectItem>
                  <SelectItem value="python">Python</SelectItem>
                  <SelectItem value="javascript">JavaScript</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label>Rúbrica esperada (para IA)</Label>
            <Textarea
              value={qRubric}
              onChange={(e) => setQRubric(e.target.value)}
              rows={2}
              placeholder="¿Qué debe contener una buena respuesta?"
            />
          </div>
          <Button onClick={addManual}>
            <Plus className="h-4 w-4 mr-1" /> Agregar pregunta
          </Button>
        </TabsContent>

        <TabsContent value="ai" className="space-y-3">
          <div>
            <Label>Temas</Label>
            <Textarea
              value={aiTopics}
              onChange={(e) => setAiTopics(e.target.value)}
              rows={3}
              placeholder="Listas enlazadas, recursión, complejidad…"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label>Tipo</Label>
              <Select value={aiType} onValueChange={(v) => setAiType(v as any)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="abierta">Abierta</SelectItem>
                  <SelectItem value="cerrada">Cerrada</SelectItem>
                  <SelectItem value="codigo">Código</SelectItem>
                  <SelectItem value="diagrama">Diagrama</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Cantidad</Label>
              <Input
                type="number"
                min={1}
                max={10}
                value={aiCount}
                onChange={(e) => setAiCount(Number(e.target.value) || 3)}
              />
            </div>
            {aiType === "codigo" && (
              <div>
                <Label>Lenguaje</Label>
                <Select value={aiLanguage} onValueChange={setAiLanguage}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="java">Java</SelectItem>
                    <SelectItem value="python">Python</SelectItem>
                    <SelectItem value="javascript">JavaScript</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <Button onClick={generateWithAI} disabled={aiLoading}>
            {aiLoading ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4 mr-1" />
            )}
            Generar con IA
          </Button>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* =========================================================================
   STUDENT: Take a workshop with question-based answers + immediate AI grading
   ========================================================================= */
export function StudentWorkshopTaker({
  workshopId,
  workshopTitle,
  maxScore,
  courseLanguage = "es",
  onGraded,
}: {
  workshopId: string;
  workshopTitle: string;
  maxScore: number;
  courseLanguage?: "es" | "en";
  onGraded?: (finalGrade: number) => void;
}) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [questions, setQuestions] = useState<WorkshopQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [graded, setGraded] = useState<{ grade: number; breakdown: any[] } | null>(null);
  // Track which workshopId we have already loaded so that auth refresh
  // events (TOKEN_REFRESHED on tab refocus) don't re-fetch and visually
  // "reload" the modal while the student is mid-submission.
  const loadedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!user) return;
    // Gate: solo cargar una vez por (workshopId + userId). Esto evita que
    // un TOKEN_REFRESHED en focus dispare un refetch y "recargue" el modal,
    // pero permite que el primer render con user=null no nos deje colgados:
    // cuando user llega, el effect re-corre y sí carga.
    const key = `${workshopId}::${user.id}`;
    if (loadedForRef.current === key) return;
    loadedForRef.current = key;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data: qs } = await supabase
        .from("workshop_questions")
        .select("*")
        .eq("workshop_id", workshopId)
        .order("position");
      if (cancelled) return;
      setQuestions((qs ?? []) as WorkshopQuestion[]);

      // Load existing submission/answers if any
      const { data: sub } = await supabase
        .from("workshop_submissions")
        .select("id, final_grade, status")
        .eq("workshop_id", workshopId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (sub?.id) {
        const { data: ans } = await supabase
          .from("workshop_submission_answers")
          .select("*")
          .eq("submission_id", sub.id);
        const map: Record<string, any> = {};
        (ans ?? []).forEach((a: any) => {
          map[a.question_id] =
            a.code_content ?? a.diagram_code ?? a.selected_option ?? a.answer_text ?? "";
        });
        if (cancelled) return;
        setAnswers(map);
        if (sub.status === "calificado" && sub.final_grade != null) {
          setGraded({ grade: Number(sub.final_grade), breakdown: [] });
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [workshopId, user?.id]);

  const updateAnswer = (qid: string, value: any) => {
    setAnswers((prev) => ({ ...prev, [qid]: value }));
  };

  const submit = async () => {
    if (!user) return;
    if (!questions.length) {
      toast.error("Este taller no tiene preguntas");
      return;
    }
    setSubmitting(true);
    try {
      // Upsert submission
      let submissionId: string;
      const { data: existing } = await supabase
        .from("workshop_submissions")
        .select("id")
        .eq("workshop_id", workshopId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (existing?.id) {
        submissionId = existing.id;
        await supabase
          .from("workshop_submissions")
          .update({ status: "entregado", submitted_at: new Date().toISOString() })
          .eq("id", submissionId);
      } else {
        const { data: created, error } = await supabase
          .from("workshop_submissions")
          .insert({
            workshop_id: workshopId,
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

      // Save & grade each question one-by-one
      let totalEarned = 0;
      let totalPoints = 0;
      const breakdown: any[] = [];

      for (const q of questions) {
        const raw = answers[q.id] ?? "";
        totalPoints += Number(q.points) || 0;

        const payload: any = {
          submission_id: submissionId,
          question_id: q.id,
        };
        if (q.type === "codigo") payload.code_content = String(raw);
        else if (q.type === "diagrama") payload.diagram_code = String(raw);
        else if (q.type === "cerrada") payload.selected_option = String(raw);
        else payload.answer_text = String(raw);

        let earned = 0;
        let feedback = "Sin retroalimentación";

        if (q.type === "cerrada") {
          // Local grading for cerrada: compare with options.correct_index
          const correctIdx = q.options?.correct_index;
          const got = String(raw) === String(correctIdx) ? Number(q.points) : 0;
          earned = got;
          feedback = got > 0 ? "Respuesta correcta" : "Respuesta incorrecta";
          payload.ai_grade = earned;
          payload.ai_feedback = feedback;
        } else if (!String(raw).trim()) {
          payload.ai_grade = 0;
          payload.ai_feedback = "Sin respuesta";
        } else {
          // Call AI grading per question (open / code / diagram)
          const { data: aiData, error: aiErr } = await supabase.functions.invoke(
            "ai-grade-submission",
            {
              body: {
                workshopQuestionGrading: true,
                questionType: q.type,
                questionContent: q.content,
                expectedRubric: q.expected_rubric,
                maxPoints: q.points,
                studentAnswer: String(raw),
                language: q.language,
                courseLanguage,
              },
            },
          );
          if (aiErr || aiData?.error) {
            payload.ai_grade = 0;
            payload.ai_feedback = `Error IA: ${aiErr?.message ?? aiData?.error ?? "Desconocido"}`;
          } else {
            earned = Number(aiData?.grade) || 0;
            feedback = aiData?.feedback ?? feedback;
            payload.ai_grade = earned;
            payload.ai_feedback = feedback;
          }
        }

        // Upsert answer
        await supabase
          .from("workshop_submission_answers")
          .upsert(payload, { onConflict: "submission_id,question_id" });

        totalEarned += earned;
        breakdown.push({
          qid: q.id,
          type: q.type,
          points: q.points,
          earned,
          feedback: payload.ai_feedback,
        });
      }

      const finalGrade =
        totalPoints > 0
          ? Number(((totalEarned / totalPoints) * Number(maxScore)).toFixed(2))
          : 0;

      await supabase
        .from("workshop_submissions")
        .update({
          ai_grade: finalGrade,
          final_grade: finalGrade,
          ai_feedback: `Calificación automática inmediata sobre ${maxScore} pts.`,
          status: "calificado",
        })
        .eq("id", submissionId);

      setGraded({ grade: finalGrade, breakdown });
      onGraded?.(finalGrade);
      toast.success(`Calificación: ${finalGrade} / ${maxScore}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground">
        <Loader2 className="inline h-3 w-3 animate-spin mr-1" /> Cargando preguntas…
      </p>
    );
  }

  if (!questions.length) {
    return <p className="text-sm text-muted-foreground">Este taller aún no tiene preguntas.</p>;
  }

  if (graded) {
    return (
      <Card className="border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle className="text-base">Resultado del taller</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tabular-nums">
            {graded.grade} / {maxScore}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {t("workshop.aiGradedNotice")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {questions.map((q, idx) => (
        <Card key={q.id}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Badge variant="outline" className="text-[10px]">
                {idx + 1}
              </Badge>
              <Badge variant="secondary" className="text-[10px] capitalize">
                {q.type}
              </Badge>
              <span className="text-xs text-muted-foreground">{q.points} pts</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <MarkdownInline>{q.content}</MarkdownInline>
            {q.type === "abierta" && (
              <Textarea
                rows={4}
                value={answers[q.id] ?? ""}
                onChange={(e) => updateAnswer(q.id, e.target.value)}
                placeholder="Escribe tu respuesta…"
              />
            )}
            {q.type === "cerrada" && q.options?.choices && (
              <div className="space-y-1.5">
                {q.options.choices.map((c: string, i: number) => (
                  <label key={i} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={`q-${q.id}`}
                      checked={String(answers[q.id]) === String(i)}
                      onChange={() => updateAnswer(q.id, i)}
                    />
                    {c}
                  </label>
                ))}
              </div>
            )}
            {q.type === "codigo" && (
              <CodeEditor
                value={answers[q.id] ?? q.starter_code ?? ""}
                onChange={(v) => updateAnswer(q.id, v ?? "")}
                language={(q.language as any) ?? "java"}
                showLanguageSelector={false}
                showRunButton={false}
                height="280px"
              />
            )}
            {q.type === "diagrama" && (
              <DiagramEditor
                value={answers[q.id] ?? ""}
                onChange={(v) => updateAnswer(q.id, v)}
              />
            )}
          </CardContent>
        </Card>
      ))}
      <div className="sticky bottom-2 z-10 bg-background/80 backdrop-blur p-2 rounded-lg border">
        <Button onClick={submit} disabled={submitting} className="w-full">
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              {t("workshop.submitting")}
            </>
          ) : (
            <>
              <Send className="h-4 w-4 mr-1" />
              {t("workshop.submit")}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
