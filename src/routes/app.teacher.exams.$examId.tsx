import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ArrowLeft, Plus, Sparkles, Loader2, Trash2, CheckSquare, XSquare } from "lucide-react";

export const Route = createFileRoute("/app/teacher/exams/$examId")({ component: ExamEditor });

type Exam = any;
type Question = {
  id: string; exam_id: string; type: string; content: string;
  expected_rubric: string | null; options: any; points: number; position: number;
};
type Student = { id: string; full_name: string; institutional_email: string };

function ExamEditor() {
  const { examId } = Route.useParams();
  const { user } = useAuth();
  const [exam, setExam] = useState<Exam | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [assigned, setAssigned] = useState<Set<string>>(new Set());

  // New question manual
  const [qType, setQType] = useState("abierta");
  const [qContent, setQContent] = useState("");
  const [qRubric, setQRubric] = useState("");
  const [qChoices, setQChoices] = useState(["", "", "", ""]);
  const [qCorrect, setQCorrect] = useState(0);
  const [qPoints, setQPoints] = useState(1);

  // AI
  const [aiTopics, setAiTopics] = useState("");
  const [aiCount, setAiCount] = useState(3);
  const [aiType, setAiType] = useState("abierta");
  const [aiLoading, setAiLoading] = useState(false);

  const load = async () => {
    const { data: e } = await supabase.from("exams").select("*").eq("id", examId).single();
    setExam(e);
    const { data: qs } = await supabase.from("questions").select("*").eq("exam_id", examId).order("position");
    setQuestions(qs ?? []);
    if (e?.course_id) {
      const { data: enr } = await supabase.from("course_enrollments")
        .select("user_id")
        .eq("course_id", e.course_id);
      const userIds = (enr ?? []).map((r: any) => r.user_id);
      let studs: Student[] = [];
      if (userIds.length) {
        const { data: profs } = await supabase.from("profiles").select("id, full_name, institutional_email").in("id", userIds);
        studs = (profs ?? []) as Student[];
      }
      setStudents(studs);
      const { data: asg } = await supabase.from("exam_assignments").select("user_id").eq("exam_id", examId);
      setAssigned(new Set((asg ?? []).map((a: any) => a.user_id)));
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [examId]);

  const saveExam = async () => {
    const { error } = await supabase.from("exams").update({
      title: exam.title, description: exam.description,
      start_time: new Date(exam.start_time).toISOString(),
      end_time: new Date(exam.end_time).toISOString(),
      time_limit_minutes: Number(exam.time_limit_minutes),
      navigation_type: exam.navigation_type, shuffle_enabled: !!exam.shuffle_enabled,
    }).eq("id", examId);
    if (error) return toast.error(error.message);
    toast.success("Examen actualizado correctamente");
  };

  const addQuestion = async () => {
    if (!qContent.trim()) return toast.error("Contenido requerido");
    if ((qType === "abierta" || qType === "codigo" || qType === "diagrama") && !qRubric.trim())
      return toast.error("Rúbrica requerida para preguntas abiertas/código/diagrama");
    const options = qType === "cerrada" ? { choices: qChoices, correct_index: qCorrect } : null;
    const pos = (questions[questions.length - 1]?.position ?? -1) + 1;
    const { error } = await supabase.from("questions").insert({
      exam_id: examId, type: qType, content: qContent, expected_rubric: qRubric || null,
      options, points: qPoints, position: pos,
    });
    if (error) return toast.error(error.message);
    toast.success("Pregunta agregada correctamente");
    setQContent(""); setQRubric(""); setQChoices(["", "", "", ""]); setQCorrect(0);
    load();
  };

  const removeQuestion = async (id: string) => {
    if (!confirm("¿Eliminar pregunta?")) return;
    const { error } = await supabase.from("questions").delete().eq("id", id);
    if (error) return toast.error(error.message);
    load();
  };

  const generateAI = async () => {
    if (!aiTopics.trim()) return toast.error("Ingresa los temas");
    setAiLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("ai-generate-questions", {
        body: { examId, topics: aiTopics, type: aiType, count: aiCount },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success(`${data.inserted?.length ?? 0} preguntas generadas`);
      setAiTopics("");
      load();
    } catch (e: any) {
      toast.error(e.message ?? "Error generando preguntas");
    } finally { setAiLoading(false); }
  };

  const toggleAssign = async (uid: string, checked: boolean) => {
    if (checked) {
      const { error } = await supabase.from("exam_assignments").insert({ exam_id: examId, user_id: uid });
      if (error) return toast.error(error.message);
      await supabase.from("notifications").insert({
        user_id: uid,
        title: "Examen asignado",
        body: `Se te ha asignado el examen "${exam.title}"`,
        kind: "exam",
        link: "/app/student/exams",
      });
      setAssigned(new Set([...assigned, uid]));
      toast.success("Estudiante asignado correctamente");
    } else {
      const { error } = await supabase.from("exam_assignments").delete().eq("exam_id", examId).eq("user_id", uid);
      if (error) return toast.error(error.message);
      const ns = new Set(assigned); ns.delete(uid); setAssigned(ns);
      toast.success("Asignación removida correctamente");
    }
  };

  const assignAll = async () => {
    const toAdd = students.filter(s => !assigned.has(s.id));
    if (!toAdd.length) return;
    const { error } = await supabase.from("exam_assignments").insert(toAdd.map(s => ({ exam_id: examId, user_id: s.id })));
    if (error) return toast.error(error.message);
    for (const s of toAdd) {
      await supabase.from("notifications").insert({
        user_id: s.id,
        title: "Examen asignado",
        body: `Se te ha asignado el examen "${exam.title}"`,
        kind: "exam",
        link: "/app/student/exams",
      });
    }
    setAssigned(new Set(students.map(s => s.id)));
    toast.success(`${toAdd.length} estudiante(s) asignados correctamente`);
  };

  const unassignAll = async () => {
    const toRemove = students.filter(s => assigned.has(s.id));
    if (!toRemove.length) return;
    for (const s of toRemove) {
      await supabase.from("exam_assignments").delete().eq("exam_id", examId).eq("user_id", s.id);
    }
    setAssigned(new Set());
    toast.success(`${toRemove.length} asignación(es) removidas correctamente`);
  };

  if (!exam) return <p className="text-muted-foreground">Cargando…</p>;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Link to="/app/teacher/exams"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" />Volver</Button></Link>
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight">{exam.title}</h1>
      </div>

      <Tabs defaultValue="config">
        <TabsList>
          <TabsTrigger value="config">Configuración</TabsTrigger>
          <TabsTrigger value="questions">Preguntas ({questions.length})</TabsTrigger>
          <TabsTrigger value="assignments">Asignaciones ({assigned.size}/{students.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="config">
          <Card><CardContent className="p-5 space-y-3">
            <div><Label>Título</Label><Input value={exam.title} onChange={e => setExam({ ...exam, title: e.target.value })} /></div>
            <div><Label>Descripción</Label><Textarea value={exam.description ?? ""} onChange={e => setExam({ ...exam, description: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Inicio</Label><Input type="datetime-local" value={toLocal(exam.start_time)} onChange={e => {
                const start = e.target.value;
                const diffMin = exam.end_time ? Math.max(1, Math.round((new Date(exam.end_time).getTime() - new Date(start).getTime()) / 60000)) : exam.time_limit_minutes;
                setExam({ ...exam, start_time: start, time_limit_minutes: diffMin });
              }} /></div>
              <div><Label>Fin</Label><Input type="datetime-local" value={toLocal(exam.end_time)} onChange={e => {
                const end = e.target.value;
                const diffMin = exam.start_time ? Math.max(1, Math.round((new Date(end).getTime() - new Date(exam.start_time).getTime()) / 60000)) : exam.time_limit_minutes;
                setExam({ ...exam, end_time: end, time_limit_minutes: diffMin });
              }} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Duración (min)</Label><Input type="number" value={exam.time_limit_minutes || ""} onChange={e => setExam({ ...exam, time_limit_minutes: e.target.value === "" ? 0 : Number(e.target.value) })} disabled className="bg-muted/50" /></div>
              <div>
                <Label>Navegación</Label>
                <Select value={exam.navigation_type} onValueChange={(v) => setExam({ ...exam, navigation_type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="libre">Libre</SelectItem>
                    <SelectItem value="secuencial">Secuencial</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button onClick={saveExam}>Guardar cambios</Button>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="questions" className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" />Generar con IA</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div><Label>Temas</Label><Textarea placeholder="Ej: arrays, recursividad, complejidad..." value={aiTopics} onChange={e => setAiTopics(e.target.value)} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Cantidad</Label><Input type="number" min={1} max={10} value={aiCount || ""} onChange={e => setAiCount(e.target.value === "" ? 0 : Number(e.target.value))} /></div>
                <div>
                  <Label>Tipo</Label>
                  <Select value={aiType} onValueChange={setAiType}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="abierta">Abierta</SelectItem>
                      <SelectItem value="cerrada">Opción múltiple</SelectItem>
                      <SelectItem value="codigo">Código</SelectItem>
                      <SelectItem value="diagrama">Diagrama</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button onClick={generateAI} disabled={aiLoading}>
                {aiLoading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1" />}
                Generar preguntas
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Agregar manualmente</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Tipo</Label>
                  <Select value={qType} onValueChange={setQType}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="abierta">Abierta</SelectItem>
                      <SelectItem value="cerrada">Opción múltiple</SelectItem>
                      <SelectItem value="codigo">Código</SelectItem>
                      <SelectItem value="diagrama">Diagrama</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div><Label>Puntos</Label><Input type="number" value={qPoints || ""} onChange={e => setQPoints(e.target.value === "" ? 0 : Number(e.target.value))} /></div>
              </div>
              <div><Label>Enunciado</Label><Textarea value={qContent} onChange={e => setQContent(e.target.value)} /></div>
              {qType !== "cerrada" && (
                <div><Label>Rúbrica esperada *</Label><Textarea placeholder="Criterios para una respuesta correcta…" value={qRubric} onChange={e => setQRubric(e.target.value)} /></div>
              )}
              {qType === "cerrada" && (
                <div className="space-y-2">
                  <Label>Opciones (marca la correcta)</Label>
                  {qChoices.map((c, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input type="radio" checked={qCorrect === i} onChange={() => setQCorrect(i)} />
                      <Input value={c} placeholder={`Opción ${String.fromCharCode(65 + i)}`} onChange={e => {
                        const nc = [...qChoices]; nc[i] = e.target.value; setQChoices(nc);
                      }} />
                    </div>
                  ))}
                </div>
              )}
              <Button onClick={addQuestion}><Plus className="h-4 w-4 mr-1" />Agregar pregunta</Button>
            </CardContent>
          </Card>

          <div className="space-y-2">
            {questions.map((q, i) => (
              <Card key={q.id}>
                <CardContent className="p-4 flex justify-between items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="outline" className="text-[10px]">#{i + 1}</Badge>
                      <Badge variant="secondary" className="text-[10px]">{q.type}</Badge>
                      <span className="text-xs text-muted-foreground">{q.points} pt</span>
                    </div>
                    <p className="text-sm">{q.content}</p>
                    {q.expected_rubric && <p className="text-xs text-muted-foreground mt-1 italic">Rúbrica: {q.expected_rubric}</p>}
                    {q.options?.choices && (
                      <ul className="text-xs text-muted-foreground mt-2 space-y-0.5">
                        {q.options.choices.map((c: string, idx: number) => (
                          <li key={idx} className={idx === q.options.correct_index ? "text-success font-medium" : ""}>
                            {String.fromCharCode(65 + idx)}. {c} {idx === q.options.correct_index && "✓"}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => removeQuestion(q.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="assignments">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">Estudiantes matriculados</CardTitle>
                  <p className="text-xs text-muted-foreground mt-1">{assigned.size} de {students.length} asignados</p>
                </div>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="outline" className="gap-1" onClick={assignAll}>
                    <CheckSquare className="h-3.5 w-3.5" /> Seleccionar todos
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1" onClick={unassignAll}>
                    <XSquare className="h-3.5 w-3.5" /> Deseleccionar todos
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-0.5">
              {students.length === 0 && <p className="text-sm text-muted-foreground">No hay estudiantes matriculados en este curso.</p>}
              {students.map(s => (
                <label key={s.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 text-sm cursor-pointer">
                  <Checkbox checked={assigned.has(s.id)} onCheckedChange={(v) => toggleAssign(s.id, !!v)} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{s.full_name}</div>
                    <div className="text-xs text-muted-foreground truncate">{s.institutional_email}</div>
                  </div>
                  {assigned.has(s.id) && <Badge variant="secondary" className="text-[9px] shrink-0">Asignado</Badge>}
                </label>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function toLocal(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
