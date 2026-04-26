/**
 * Teacher Projects — list, create/edit, AI statement generation, grade with AI.
 *
 * A project is a deliverable that students upload as a single ZIP. The
 * teacher can trigger AI grading which downloads, unzips, evaluates and
 * stores the score (see edge function `ai-grade-submission` mode `projectGrading`).
 */
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Plus,
  Pencil,
  Trash2,
  Sparkles,
  Download,
  Bot,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useConfirm } from "@/components/ConfirmDialog";

// projects/project_submissions tables aren't in the auto-generated types yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const Route = createFileRoute("/app/teacher/projects")({ component: TeacherProjects });

type Course = { id: string; name: string };
type Cut = { id: string; name: string; course_id: string };
type Project = {
  id: string;
  course_id: string;
  cut_id: string | null;
  title: string;
  description: string | null;
  instructions: string | null;
  project_type: "escrito" | "codigo" | "diagrama";
  max_files: number;
  max_score: number;
  start_date: string | null;
  due_date: string | null;
  status: string;
  ai_generated: boolean;
};
type ProjectSubmission = {
  id: string;
  project_id: string;
  user_id: string;
  zip_url: string | null;
  status: string;
  ai_grade: number | null;
  ai_feedback: string | null;
  ai_detected: boolean;
  ai_detected_score: number | null;
  ai_detected_reasons: string | null;
  final_grade: number | null;
  teacher_feedback: string | null;
  submitted_at: string | null;
};
type Profile = { id: string; full_name: string };

function toLocalInput(value: string | null | undefined) {
  if (!value) return "";
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function TeacherProjects() {
  const confirm = useConfirm();
  const [courses, setCourses] = useState<Course[]>([]);
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Project> | null>(null);

  // AI statement dialog
  const [aiOpen, setAiOpen] = useState(false);
  const [aiTopic, setAiTopic] = useState("");
  const [aiType, setAiType] = useState<"escrito" | "codigo" | "diagrama">("escrito");
  const [aiMaxFiles, setAiMaxFiles] = useState(5);
  const [aiBusy, setAiBusy] = useState(false);

  // Submissions panel
  const [subsProject, setSubsProject] = useState<Project | null>(null);
  const [subs, setSubs] = useState<ProjectSubmission[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [gradingId, setGradingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: cs } = await supabase.from("courses").select("id, name").order("name");
    setCourses((cs ?? []) as Course[]);
    if (!selectedCourse && cs?.length) setSelectedCourse(cs[0].id);
  }, [selectedCourse]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selectedCourse) return;
    void (async () => {
      const [{ data: ps }, { data: gs }] = await Promise.all([
        db.from("projects").select("*").eq("course_id", selectedCourse).order("created_at", { ascending: false }),
        db.from("grade_cuts").select("id, name, course_id").eq("course_id", selectedCourse).order("position"),
      ]);
      setProjects((ps ?? []) as Project[]);
      setCuts((gs ?? []) as Cut[]);
    })();
  }, [selectedCourse]);

  const cutsForCourse = useMemo(
    () => cuts.filter((c) => c.course_id === selectedCourse),
    [cuts, selectedCourse],
  );

  const openNew = () => {
    setEditing({
      course_id: selectedCourse,
      title: "",
      description: "",
      instructions: "",
      project_type: "escrito",
      max_files: 5,
      max_score: 100,
      cut_id: null,
      status: "draft",
    });
    setOpen(true);
  };

  const save = async () => {
    if (!editing?.title?.trim()) return toast.error("Título requerido");
    const { data: u } = await supabase.auth.getUser();
    const payload = {
      ...editing,
      course_id: selectedCourse,
      created_by: u.user?.id,
      start_date: editing.start_date || null,
      due_date: editing.due_date || null,
      cut_id: editing.cut_id || null,
    };
    const { error } = editing.id
      ? await db.from("projects").update(payload).eq("id", editing.id)
      : await db.from("projects").insert(payload);
    if (error) return toast.error(error.message);
    toast.success("Proyecto guardado");
    setOpen(false);
    setEditing(null);
    const { data: ps } = await db.from("projects").select("*").eq("course_id", selectedCourse).order("created_at", { ascending: false });
    setProjects((ps ?? []) as Project[]);
  };

  const remove = async (p: Project) => {
    const ok = await confirm({
      title: "Eliminar proyecto",
      description: "Se eliminarán también todas sus entregas.",
      tone: "destructive",
    });
    if (!ok) return;
    await db.from("project_submissions").delete().eq("project_id", p.id);
    const { error } = await db.from("projects").delete().eq("id", p.id);
    if (error) return toast.error(error.message);
    setProjects((prev) => prev.filter((x) => x.id !== p.id));
  };

  const togglePublish = async (p: Project) => {
    const next = p.status === "published" ? "draft" : "published";
    const { error } = await db.from("projects").update({ status: next }).eq("id", p.id);
    if (error) return toast.error(error.message);
    setProjects((prev) => prev.map((x) => (x.id === p.id ? { ...x, status: next } : x)));
  };

  const generateStatement = async () => {
    if (!aiTopic.trim()) return toast.error("Tema requerido");
    setAiBusy(true);
    const { data, error } = await supabase.functions.invoke("ai-generate-questions", {
      body: {
        projectStatement: true,
        topic: aiTopic,
        projectType: aiType,
        maxFiles: aiMaxFiles,
      },
    });
    setAiBusy(false);
    if (error) return toast.error(error.message);
    if (data?.error) return toast.error(data.error);
    setEditing({
      course_id: selectedCourse,
      title: data.title,
      description: data.description,
      instructions: data.instructions,
      project_type: aiType,
      max_files: aiMaxFiles,
      max_score: 100,
      cut_id: null,
      status: "draft",
      ai_generated: true,
    });
    setAiOpen(false);
    setOpen(true);
    setAiTopic("");
  };

  const openSubs = async (p: Project) => {
    setSubsProject(p);
    const { data: ss } = await db.from("project_submissions").select("*").eq("project_id", p.id);
    const subsList = (ss ?? []) as ProjectSubmission[];
    setSubs(subsList);
    if (subsList.length) {
      const ids = Array.from(new Set(subsList.map((s) => s.user_id)));
      const { data: profs } = await supabase.from("profiles").select("id, full_name").in("id", ids);
      const map: Record<string, Profile> = {};
      (profs ?? []).forEach((p: Profile) => (map[p.id] = p));
      setProfiles(map);
    }
  };

  const downloadZip = async (s: ProjectSubmission) => {
    if (!s.zip_url) return;
    const { data, error } = await supabase.storage.from("workshop-files").createSignedUrl(s.zip_url, 60);
    if (error || !data) return toast.error("No se pudo generar enlace");
    window.open(data.signedUrl, "_blank");
  };

  const gradeWithAI = async (s: ProjectSubmission) => {
    setGradingId(s.id);
    const { data, error } = await supabase.functions.invoke("ai-grade-submission", {
      body: { projectGrading: true, submissionId: s.id },
    });
    setGradingId(null);
    if (error) return toast.error(error.message);
    if (data?.error) return toast.error(data.error);
    toast.success(`Nota IA: ${data.grade}`);
    if (subsProject) await openSubs(subsProject);
  };

  const updateFinal = async (s: ProjectSubmission, grade: number, feedback: string) => {
    const { error } = await db
      .from("project_submissions")
      .update({ final_grade: grade, teacher_feedback: feedback, status: "calificado" })
      .eq("id", s.id);
    if (error) return toast.error(error.message);
    toast.success("Nota guardada");
    if (subsProject) await openSubs(subsProject);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Proyectos</h1>
          <p className="text-sm text-muted-foreground">Crea proyectos por curso, con corte opcional.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={selectedCourse} onValueChange={setSelectedCourse}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Curso" />
            </SelectTrigger>
            <SelectContent>
              {courses.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => setAiOpen(true)} disabled={!selectedCourse}>
            <Sparkles className="mr-1 h-4 w-4" />
            Generar con IA
          </Button>
          <Button onClick={openNew} disabled={!selectedCourse}>
            <Plus className="mr-1 h-4 w-4" />
            Nuevo proyecto
          </Button>
        </div>
      </div>

      <div className="grid gap-3">
        {projects.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Sin proyectos en este curso.
            </CardContent>
          </Card>
        )}
        {projects.map((p) => (
          <Card key={p.id}>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
              <div className="space-y-1">
                <CardTitle className="text-base">{p.title}</CardTitle>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="outline" className="capitalize">{p.project_type}</Badge>
                  <Badge variant={p.status === "published" ? "default" : "secondary"}>
                    {p.status}
                  </Badge>
                  {p.ai_generated && (
                    <Badge variant="outline">
                      <Sparkles className="mr-1 h-3 w-3" />IA
                    </Badge>
                  )}
                  {p.cut_id && (
                    <Badge variant="outline">
                      Corte: {cuts.find((c) => c.id === p.cut_id)?.name ?? "—"}
                    </Badge>
                  )}
                  {p.due_date && (
                    <span className="text-muted-foreground">
                      Entrega: {new Date(p.due_date).toLocaleString()}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => openSubs(p)}>
                  Entregas
                </Button>
                <Button size="sm" variant="ghost" onClick={() => togglePublish(p)}>
                  {p.status === "published" ? "Despublicar" : "Publicar"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setEditing(p); setOpen(true); }}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => remove(p)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </CardHeader>
            {p.description && (
              <CardContent className="text-sm text-muted-foreground">{p.description}</CardContent>
            )}
          </Card>
        ))}
      </div>

      {/* Edit dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Editar proyecto" : "Nuevo proyecto"}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div>
                <Label>Título</Label>
                <Input value={editing.title ?? ""} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
              </div>
              <div>
                <Label>Descripción</Label>
                <Textarea value={editing.description ?? ""} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
              </div>
              <div>
                <Label>Instrucciones / enunciado</Label>
                <Textarea
                  rows={8}
                  value={editing.instructions ?? ""}
                  onChange={(e) => setEditing({ ...editing, instructions: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <div>
                  <Label>Tipo</Label>
                  <Select
                    value={editing.project_type ?? "escrito"}
                    onValueChange={(v) => setEditing({ ...editing, project_type: v as Project["project_type"] })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="escrito">Escrito</SelectItem>
                      <SelectItem value="codigo">Código</SelectItem>
                      <SelectItem value="diagrama">Diagrama</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Máx. archivos</Label>
                  <Input type="number" min={1} value={editing.max_files ?? 5} onChange={(e) => setEditing({ ...editing, max_files: Number(e.target.value) })} />
                </div>
                <div>
                  <Label>Puntaje máx.</Label>
                  <Input type="number" min={1} value={editing.max_score ?? 100} onChange={(e) => setEditing({ ...editing, max_score: Number(e.target.value) })} />
                </div>
                <div>
                  <Label>Corte</Label>
                  <Select
                    value={editing.cut_id ?? "__none__"}
                    onValueChange={(v) => setEditing({ ...editing, cut_id: v === "__none__" ? null : v })}
                  >
                    <SelectTrigger><SelectValue placeholder="Ninguno" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Sin corte</SelectItem>
                      {cutsForCourse.map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Inicio</Label>
                  <Input
                    type="datetime-local"
                    value={toLocalInput(editing.start_date)}
                    onChange={(e) => setEditing({ ...editing, start_date: e.target.value ? new Date(e.target.value).toISOString() : null })}
                  />
                </div>
                <div>
                  <Label>Fecha de entrega</Label>
                  <Input
                    type="datetime-local"
                    value={toLocalInput(editing.due_date)}
                    onChange={(e) => setEditing({ ...editing, due_date: e.target.value ? new Date(e.target.value).toISOString() : null })}
                  />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button onClick={save}>Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AI generate statement */}
      <Dialog open={aiOpen} onOpenChange={setAiOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generar enunciado con IA</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Tema</Label>
              <Input value={aiTopic} onChange={(e) => setAiTopic(e.target.value)} placeholder="Ej: API REST de inventario" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Tipo</Label>
                <Select value={aiType} onValueChange={(v) => setAiType(v as typeof aiType)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="escrito">Escrito</SelectItem>
                    <SelectItem value="codigo">Código</SelectItem>
                    <SelectItem value="diagrama">Diagrama</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Máx. archivos</Label>
                <Input type="number" min={1} value={aiMaxFiles} onChange={(e) => setAiMaxFiles(Number(e.target.value))} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAiOpen(false)}>Cancelar</Button>
            <Button onClick={generateStatement} disabled={aiBusy}>
              {aiBusy ? "Generando..." : "Generar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Submissions dialog */}
      <Dialog open={!!subsProject} onOpenChange={(o) => !o && setSubsProject(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Entregas — {subsProject?.title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            {subs.length === 0 && (
              <p className="text-sm text-muted-foreground">Aún no hay entregas.</p>
            )}
            {subs.map((s) => (
              <div key={s.id} className="rounded border p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="space-y-1">
                    <p className="font-medium">{profiles[s.user_id]?.full_name ?? s.user_id.slice(0, 8)}</p>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <Badge variant="outline">{s.status}</Badge>
                      {s.ai_grade != null && <Badge variant="secondary">IA: {s.ai_grade}</Badge>}
                      {s.final_grade != null && (
                        <Badge>
                          <CheckCircle2 className="mr-1 h-3 w-3" />Final: {s.final_grade}
                        </Badge>
                      )}
                      {s.ai_detected && (
                        <Badge variant="destructive">
                          <Bot className="mr-1 h-3 w-3" />
                          Posible IA ({Math.round((s.ai_detected_score ?? 0) * 100)}%)
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {s.zip_url && (
                      <Button size="sm" variant="ghost" onClick={() => downloadZip(s)}>
                        <Download className="mr-1 h-3 w-3" />ZIP
                      </Button>
                    )}
                    <Button
                      size="sm"
                      onClick={() => gradeWithAI(s)}
                      disabled={!s.zip_url || gradingId === s.id}
                    >
                      <Sparkles className="mr-1 h-3 w-3" />
                      {gradingId === s.id ? "Calificando..." : "Calificar con IA"}
                    </Button>
                  </div>
                </div>
                {s.ai_feedback && (
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap">{s.ai_feedback}</p>
                )}
                {s.ai_detected && s.ai_detected_reasons && (
                  <div className="rounded bg-destructive/10 p-2 text-xs">
                    <p className="font-medium flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" />Razones de detección IA
                    </p>
                    <p>{s.ai_detected_reasons}</p>
                  </div>
                )}
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <Textarea
                    placeholder="Retroalimentación final del docente"
                    defaultValue={s.teacher_feedback ?? ""}
                    onBlur={(e) => {
                      const grade = s.final_grade ?? s.ai_grade ?? 0;
                      void updateFinal(s, Number(grade), e.target.value);
                    }}
                  />
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Nota final</Label>
                    <Input
                      type="number"
                      defaultValue={s.final_grade ?? s.ai_grade ?? ""}
                      onBlur={(e) => updateFinal(s, Number(e.target.value), s.teacher_feedback ?? "")}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
