import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import {
  Plus,
  Pencil,
  Trash2,
  ExternalLink,
  Users,
  CheckCircle2,
  FileIcon,
  Download,
  CheckSquare,
  XSquare,
  Sparkles,
  Loader2,
  ThumbsUp,
  ThumbsDown,
  HelpCircle,
} from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { ImportExportMenu } from "@/components/ImportExportMenu";
import { toCSV } from "@/lib/csv";

const WORKSHOPS_TEMPLATE = `course_name,title,description,instructions,external_link,due_date,max_score,status
Programación I,Taller de listas,Práctica de listas enlazadas,Implementa las funciones del enunciado,https://github.com/repo,2025-09-15T23:59,100,published
Programación I,Taller de árboles,,Resuelve los ejercicios 1-5,,2025-09-30T23:59,100,draft`;

export const Route = createFileRoute("/app/teacher/workshops")({ component: TeacherWorkshops });

type Course = {
  id: string;
  name: string;
  period: string | null;
  grade_scale_min: number;
  grade_scale_max: number;
  passing_grade: number;
};
type Workshop = {
  id: string;
  course_id: string;
  title: string;
  description: string | null;
  instructions: string | null;
  external_link: string | null;
  ai_generated: boolean;
  due_date: string | null;
  rubric: any;
  max_score: number;
  status: string;
  course?: { name: string; period: string | null };
};
type Student = { id: string; full_name: string; institutional_email: string };
type WsSub = {
  id: string;
  workshop_id: string;
  user_id: string;
  content: string | null;
  external_link: string | null;
  file_url: string | null;
  ai_grade: number | null;
  ai_feedback: string | null;
  final_grade: number | null;
  teacher_feedback: string | null;
  status: string;
  submitted_at: string | null;
  profile?: { full_name: string; institutional_email: string };
};

function TeacherWorkshops() {
  const { user, roles } = useAuth();
  const confirm = useConfirm();
  const [courses, setCourses] = useState<Course[]>([]);
  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Partial<Workshop>>({});

  // Grading view
  const [gradingWs, setGradingWs] = useState<Workshop | null>(null);
  const [wsSubs, setWsSubs] = useState<WsSub[]>([]);
  const [gradingOpen, setGradingOpen] = useState(false);

  // Assignment
  const [assignWs, setAssignWs] = useState<Workshop | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [students, setStudents] = useState<Student[]>([]);
  const [assignedIds, setAssignedIds] = useState<Set<string>>(new Set());
  const [selectedCourseIds, setSelectedCourseIds] = useState<Set<string>>(new Set());

  const isTeacher = roles.includes("Docente") || roles.includes("Admin");

  /** Auto-assign a workshop to all students enrolled in the course */
  const autoAssignWorkshop = async (workshopId: string, courseId: string) => {
    const { data: enr } = await supabase
      .from("course_enrollments")
      .select("user_id")
      .eq("course_id", courseId);
    if (!enr?.length) return;
    // Get existing assignments to avoid duplicates
    const { data: existing } = await supabase
      .from("workshop_assignments")
      .select("user_id")
      .eq("workshop_id", workshopId);
    const existingSet = new Set((existing ?? []).map((e: any) => e.user_id));
    const toAdd = enr.filter((e: any) => !existingSet.has(e.user_id));
    if (toAdd.length) {
      await supabase
        .from("workshop_assignments")
        .insert(toAdd.map((e: any) => ({ workshop_id: workshopId, user_id: e.user_id })));
    }
  };

  const load = async () => {
    const [{ data: cs }, { data: ws }] = await Promise.all([
      supabase
        .from("courses")
        .select("id, name, period, grade_scale_min, grade_scale_max, passing_grade")
        .order("name"),
      supabase
        .from("workshops")
        .select("*, course:courses(name, period)")
        .order("created_at", { ascending: false }),
    ]);
    setCourses((cs ?? []) as Course[]);
    setWorkshops((ws ?? []) as any);
  };
  useEffect(() => {
    load();
  }, []);

  const openNew = () => {
    const due = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    setForm({
      title: "",
      course_id: courses[0]?.id,
      description: "",
      instructions: "",
      external_link: "",
      due_date: toLocal(due),
      max_score: 100,
      status: "draft",
      rubric: null,
    });
    setSelectedCourseIds(new Set(courses[0] ? [courses[0].id] : []));
    setOpen(true);
  };

  const toggleCourse = (id: string) => {
    setSelectedCourseIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      const first = [...next][0];
      if (first) setForm((f) => ({ ...f, course_id: first }));
      return next;
    });
  };

  const save = async () => {
    if (!form.title || !user) {
      toast.error("Completa los campos");
      return;
    }
    // If editing, use single course
    const courseIds = form.id ? [form.course_id!] : [...selectedCourseIds];
    if (courseIds.length === 0) {
      toast.error("Selecciona al menos un curso");
      return;
    }

    const basePayload = {
      title: form.title,
      description: form.description ?? null,
      instructions: form.instructions ?? null,
      external_link: form.external_link || null,
      start_date: (form as any).start_date
        ? new Date((form as any).start_date).toISOString()
        : null,
      due_date: form.due_date ? new Date(form.due_date).toISOString() : null,
      max_score: Number(form.max_score) || 100,
      status: form.status ?? "draft",
      rubric: form.rubric ?? null,
      created_by: user.id,
    };

    if (form.id) {
      const { error } = await supabase
        .from("workshops")
        .update({ ...basePayload, course_id: form.course_id! })
        .eq("id", form.id);
      if (error) return toast.error(error.message);
      // Auto-assign all enrolled students when published
      if (form.status === "published") {
        await autoAssignWorkshop(form.id, form.course_id!);
        await supabase.rpc("notify_course_students", {
          _course_id: form.course_id!,
          _title: "Nuevo taller disponible",
          _body: `Se ha publicado el taller "${form.title}"`,
          _kind: "workshop",
          _link: "/app/student/workshops",
        });
      }
      toast.success("Taller actualizado correctamente");
    } else {
      for (const cid of courseIds) {
        const { data: newWs, error } = await supabase
          .from("workshops")
          .insert({ ...basePayload, course_id: cid })
          .select()
          .single();
        if (error) {
          toast.error(error.message);
          return;
        }
        // Auto-assign all enrolled students when published
        if (form.status === "published" && newWs) {
          await autoAssignWorkshop(newWs.id, cid);
          await supabase.rpc("notify_course_students", {
            _course_id: cid,
            _title: "Nuevo taller disponible",
            _body: `Se ha publicado el taller "${form.title}"`,
            _kind: "workshop",
            _link: "/app/student/workshops",
          });
        }
      }
      toast.success(
        courseIds.length > 1
          ? `Taller creado en ${courseIds.length} cursos correctamente`
          : "Taller creado correctamente",
      );
    }
    setOpen(false);
    load();
  };

  const remove = async (id: string) => {
    const ok = await confirm({
      title: "Eliminar taller",
      description: "Se eliminarán las asignaciones y entregas asociadas al taller.",
      confirmLabel: "Eliminar taller",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("workshops").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Taller eliminado correctamente");
    load();
  };

  const openAssign = async (ws: Workshop) => {
    setAssignWs(ws);
    const [{ data: enr }, { data: asg }] = await Promise.all([
      supabase.from("course_enrollments").select("user_id").eq("course_id", ws.course_id),
      supabase.from("workshop_assignments").select("user_id").eq("workshop_id", ws.id),
    ]);
    const userIds = (enr ?? []).map((r: any) => r.user_id);
    if (userIds.length) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, full_name, institutional_email")
        .in("id", userIds);
      setStudents((profs ?? []) as Student[]);
    } else {
      setStudents([]);
    }
    setAssignedIds(new Set((asg ?? []).map((a: any) => a.user_id)));
    setAssignOpen(true);
  };

  const toggleAssign = async (uid: string, checked: boolean) => {
    if (!assignWs) return;
    if (checked) {
      const { error } = await supabase
        .from("workshop_assignments")
        .insert({ workshop_id: assignWs.id, user_id: uid });
      if (error) return toast.error(error.message);
      setAssignedIds(new Set([...assignedIds, uid]));
      toast.success("Estudiante asignado correctamente");
    } else {
      const { error } = await supabase
        .from("workshop_assignments")
        .delete()
        .eq("workshop_id", assignWs.id)
        .eq("user_id", uid);
      if (error) return toast.error(error.message);
      const ns = new Set(assignedIds);
      ns.delete(uid);
      setAssignedIds(ns);
      toast.success("Asignación removida correctamente");
    }
  };

  const assignAll = async () => {
    if (!assignWs) return;
    const toAdd = students.filter((s) => !assignedIds.has(s.id));
    if (!toAdd.length) return;
    const { error } = await supabase
      .from("workshop_assignments")
      .insert(toAdd.map((s) => ({ workshop_id: assignWs.id, user_id: s.id })));
    if (error) return toast.error(error.message);
    setAssignedIds(new Set(students.map((s) => s.id)));
    toast.success(`${toAdd.length} estudiante(s) asignados correctamente`);
  };

  const unassignAll = async () => {
    if (!assignWs) return;
    const toRemove = students.filter((s) => assignedIds.has(s.id));
    if (!toRemove.length) return;
    for (const s of toRemove) {
      await supabase
        .from("workshop_assignments")
        .delete()
        .eq("workshop_id", assignWs.id)
        .eq("user_id", s.id);
    }
    setAssignedIds(new Set());
    toast.success(`${toRemove.length} asignación(es) removidas correctamente`);
  };

  const openGrading = async (ws: Workshop) => {
    setGradingWs(ws);
    const { data: subs } = await supabase
      .from("workshop_submissions")
      .select("*")
      .eq("workshop_id", ws.id);

    if (subs?.length) {
      const userIds = subs.map((s: any) => s.user_id);
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, full_name, institutional_email")
        .in("id", userIds);
      const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
      setWsSubs(subs.map((s: any) => ({ ...s, profile: profileMap.get(s.user_id) })));
    } else {
      setWsSubs([]);
    }
    setGradingOpen(true);
  };

  const [aiGradingId, setAiGradingId] = useState<string | null>(null);
  const [aiGradingAll, setAiGradingAll] = useState(false);

  const gradeOneWithAI = async (sub: WsSub): Promise<boolean> => {
    if (!gradingWs) return false;
    setAiGradingId(sub.id);
    try {
      // Build the prompt for AI grading
      const rubricText = gradingWs.rubric
        ? JSON.stringify(gradingWs.rubric)
        : "Evalúa la calidad, completitud y corrección de la respuesta.";

      const studentAnswer =
        [
          sub.content ? `Contenido: ${sub.content}` : "",
          sub.external_link ? `Link: ${sub.external_link}` : "",
        ]
          .filter(Boolean)
          .join("\n") || "Sin respuesta";

      // Call AI via edge function with a generic approach
      const { data: aiData, error: aiErr } = await supabase.functions.invoke(
        "ai-grade-submission",
        {
          body: {
            workshopGrading: true,
            workshopTitle: gradingWs.title,
            workshopInstructions: gradingWs.instructions ?? "",
            rubric: rubricText,
            maxScore: gradingWs.max_score,
            studentAnswer,
          },
        },
      );

      let aiGrade: number | null = null;
      let aiFeedback = "Sin retroalimentación de IA";

      if (aiErr || aiData?.error) {
        // Fallback: if edge function doesn't support workshop mode, do a simple scoring
        toast.error(
          "La calificación IA requiere actualizar la edge function. Usa calificación manual.",
        );
        return false;
      } else {
        aiGrade = aiData?.grade ?? null;
        aiFeedback = aiData?.feedback ?? "Sin retroalimentación de IA";
      }

      // Save to DB
      const { error: updateErr } = await supabase
        .from("workshop_submissions")
        .update({
          ai_grade: aiGrade,
          ai_feedback: aiFeedback,
          status: "ai_revisado",
        })
        .eq("id", sub.id);

      if (updateErr) {
        toast.error(`Error guardando: ${updateErr.message}`);
        return false;
      }

      setWsSubs((prev) =>
        prev.map((s) =>
          s.id === sub.id
            ? { ...s, ai_grade: aiGrade, ai_feedback: aiFeedback, status: "ai_revisado" }
            : s,
        ),
      );
      return true;
    } catch (e: any) {
      toast.error(`Error IA: ${e.message ?? "Error desconocido"}`);
      return false;
    } finally {
      setAiGradingId(null);
    }
  };

  const gradeAllWithAI = async () => {
    if (!gradingWs) return;
    const pending = wsSubs.filter(
      (s) => s.status === "entregado" || s.status === "calificado" || s.status === "ai_revisado",
    );
    if (!pending.length) {
      toast.info("No hay entregas para calificar");
      return;
    }
    setAiGradingAll(true);
    let graded = 0;
    for (const sub of pending) {
      const ok = await gradeOneWithAI(sub);
      if (ok) graded++;
    }
    setAiGradingAll(false);
    if (graded > 0) toast.success(`${graded} entrega(s) calificadas con IA correctamente`);
  };

  const approveAIGrade = async (subId: string) => {
    const sub = wsSubs.find((s) => s.id === subId);
    if (!sub) return;
    const { error } = await supabase
      .from("workshop_submissions")
      .update({
        final_grade: sub.ai_grade,
        teacher_feedback: sub.ai_feedback,
        status: "calificado",
      })
      .eq("id", subId);
    if (error) return toast.error(error.message);
    setWsSubs((prev) =>
      prev.map((s) =>
        s.id === subId
          ? {
              ...s,
              final_grade: sub.ai_grade,
              teacher_feedback: sub.ai_feedback,
              status: "calificado",
            }
          : s,
      ),
    );
    toast.success("Calificación IA aprobada");
  };

  const rejectAIGrade = async (subId: string) => {
    await supabase
      .from("workshop_submissions")
      .update({
        ai_grade: null,
        ai_feedback: null,
        status: "entregado",
      })
      .eq("id", subId);
    setWsSubs((prev) =>
      prev.map((s) =>
        s.id === subId ? { ...s, ai_grade: null, ai_feedback: null, status: "entregado" } : s,
      ),
    );
    toast.success("Calificación IA rechazada — puede calificar manualmente");
  };

  const saveGrade = async (subId: string, grade: number, feedback: string) => {
    const { data, error } = await supabase
      .from("workshop_submissions")
      .update({
        final_grade: grade,
        teacher_feedback: feedback,
        status: "calificado",
      })
      .eq("id", subId)
      .select()
      .maybeSingle();

    if (error) {
      toast.error(`Error: ${error.message}`);
      return;
    }
    if (!data) {
      toast.error("No se pudo actualizar. Verifica los permisos.");
      return;
    }
    toast.success("Calificación guardada correctamente");
    setWsSubs((prev) =>
      prev.map((s) =>
        s.id === subId
          ? { ...s, final_grade: grade, teacher_feedback: feedback, status: "calificado" }
          : s,
      ),
    );
  };

  const deleteSubmission = async (subId: string, studentName: string) => {
    const ok = await confirm({
      title: `Eliminar entrega de ${studentName}`,
      description: "Se eliminará la entrega del estudiante de forma permanente.",
      confirmLabel: "Eliminar entrega",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("workshop_submissions").delete().eq("id", subId);
    if (error) return toast.error(error.message);
    setWsSubs((prev) => prev.filter((s) => s.id !== subId));
    toast.success("Entrega eliminada correctamente");
  };

  if (!isTeacher) return <p className="text-muted-foreground">Necesitas rol Docente.</p>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Talleres</h1>
          <p className="text-sm text-muted-foreground">{workshops.length} talleres creados</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ImportExportMenu
            label="Talleres"
            resourceName="talleres"
            templateCsv={WORKSHOPS_TEMPLATE}
            onExport={() => {
              if (!workshops.length) return "";
              return toCSV(
                workshops.map((w) => ({
                  course_name: w.course?.name ?? "",
                  title: w.title,
                  description: w.description ?? "",
                  instructions: w.instructions ?? "",
                  external_link: w.external_link ?? "",
                  due_date: w.due_date ?? "",
                  max_score: w.max_score,
                  status: w.status,
                })),
              );
            }}
            onImport={async (rows) => {
              if (!user) throw new Error("Sesión no válida");
              const courseByName = new Map(courses.map((c) => [c.name.toLowerCase().trim(), c.id]));
              let created = 0,
                skipped = 0;
              for (const r of rows) {
                const cid = courseByName.get((r.course_name || "").toLowerCase().trim());
                if (!cid || !r.title) {
                  skipped++;
                  continue;
                }
                const { error } = await supabase.from("workshops").insert({
                  course_id: cid,
                  title: r.title,
                  description: r.description || null,
                  instructions: r.instructions || null,
                  external_link: r.external_link || null,
                  due_date: r.due_date ? new Date(r.due_date).toISOString() : null,
                  max_score: Number(r.max_score) || 100,
                  status: r.status || "draft",
                  created_by: user.id,
                });
                if (error) skipped++;
                else created++;
              }
              await load();
              return `${created} talleres creados · ${skipped} omitidos`;
            }}
          />
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4 mr-1" />
            Nuevo taller
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Título</TableHead>
                <TableHead>Curso</TableHead>
                <TableHead>Fecha límite</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workshops.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    No hay talleres creados aún.
                  </TableCell>
                </TableRow>
              )}
              {workshops.map((ws) => (
                <TableRow key={ws.id}>
                  <TableCell className="font-medium">
                    {ws.title}
                    {ws.external_link && (
                      <ExternalLink className="inline h-3 w-3 ml-1 text-muted-foreground" />
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{ws.course?.name}</TableCell>
                  <TableCell className="text-sm">
                    {ws.due_date ? new Date(ws.due_date).toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        ws.status === "published"
                          ? "default"
                          : ws.status === "closed"
                            ? "secondary"
                            : "outline"
                      }
                      className="text-[10px]"
                    >
                      {ws.status === "published"
                        ? "Publicado"
                        : ws.status === "closed"
                          ? "Cerrado"
                          : "Borrador"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-0.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openAssign(ws)}
                        title="Asignación / excluir estudiantes"
                      >
                        <Users className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openGrading(ws)}
                        title="Calificar"
                      >
                        <CheckCircle2 className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setForm({
                            ...ws,
                            due_date: ws.due_date ? toLocalDatetime(ws.due_date) : "",
                            start_date: (ws as any).start_date
                              ? toLocalDatetime((ws as any).start_date)
                              : "",
                          } as any);
                          setOpen(true);
                        }}
                        title="Editar"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => remove(ws.id)}
                        title="Eliminar"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{form.id ? "Editar" : "Nuevo"} taller</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Título</Label>
              <Input
                value={form.title ?? ""}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div>
              <Label>
                Cursos{" "}
                <span className="text-xs text-muted-foreground font-normal">
                  {form.id ? "" : "(selecciona uno o más)"}
                </span>
              </Label>
              {form.id ? (
                <Select
                  value={form.course_id}
                  onValueChange={(v) => setForm({ ...form, course_id: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Curso" />
                  </SelectTrigger>
                  <SelectContent>
                    {courses.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                        {c.period ? ` (${c.period})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="mt-1.5 max-h-36 overflow-y-auto rounded-md border p-2 space-y-1">
                  {courses.map((c) => (
                    <label
                      key={c.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 text-sm cursor-pointer"
                    >
                      <Checkbox
                        checked={selectedCourseIds.has(c.id)}
                        onCheckedChange={() => toggleCourse(c.id)}
                      />
                      <span className="flex-1">{c.name}</span>
                      {c.period && (
                        <Badge variant="outline" className="text-[9px]">
                          {c.period}
                        </Badge>
                      )}
                    </label>
                  ))}
                </div>
              )}
              {!form.id && selectedCourseIds.size > 1 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Se creará una copia del taller en cada curso seleccionado.
                </p>
              )}
            </div>
            <div>
              <Label>Descripción</Label>
              <Textarea
                value={form.description ?? ""}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div>
              <Label>Instrucciones</Label>
              <Textarea
                rows={4}
                value={form.instructions ?? ""}
                onChange={(e) => setForm({ ...form, instructions: e.target.value })}
              />
            </div>
            <div>
              <Label>Link externo (opcional)</Label>
              <Input
                placeholder="https://..."
                value={form.external_link ?? ""}
                onChange={(e) => setForm({ ...form, external_link: e.target.value })}
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Fechas</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Visible desde</Label>
                  <Input
                    type="datetime-local"
                    value={(form as any).start_date ?? ""}
                    onChange={(e) => setForm({ ...form, start_date: e.target.value } as any)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">Fecha límite</Label>
                  <Input
                    type="datetime-local"
                    value={(form.due_date as any) ?? ""}
                    onChange={(e) => setForm({ ...form, due_date: e.target.value })}
                    className="mt-1"
                  />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>Puntaje máximo</Label>
                <Input
                  type="number"
                  value={form.max_score || ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      max_score: e.target.value === "" ? 0 : Number(e.target.value),
                    })
                  }
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Estado</Label>
                <Select
                  value={form.status ?? "draft"}
                  onValueChange={(v) => setForm({ ...form, status: v })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Borrador</SelectItem>
                    <SelectItem value="published">Publicado</SelectItem>
                    <SelectItem value="closed">Cerrado</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <Label>Rúbrica de calificación IA</Label>
                <span className="text-xs text-muted-foreground">(JSON, opcional)</span>
                <Dialog>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                    asChild
                  >
                    <span>
                      <HelpCircle className="h-3.5 w-3.5" />
                    </span>
                  </Button>
                </Dialog>
              </div>
              <div className="rounded-md border bg-muted/30 p-3 mb-2 text-xs text-muted-foreground space-y-1.5">
                <p className="font-medium text-foreground text-xs">¿Cómo funciona?</p>
                <p>
                  Define los criterios que la IA usará para calificar las entregas. Escribe un array
                  JSON donde cada objeto tenga:
                </p>
                <ul className="list-disc list-inside space-y-0.5 ml-1">
                  <li>
                    <code className="bg-muted px-1 rounded">criterio</code>: nombre del criterio
                    (ej: "Claridad")
                  </li>
                  <li>
                    <code className="bg-muted px-1 rounded">peso</code>: porcentaje del puntaje
                    total (deben sumar 100)
                  </li>
                </ul>
                <p className="font-medium mt-1">Ejemplo:</p>
                <pre className="bg-muted p-2 rounded text-[11px] overflow-x-auto">{`[
  { "criterio": "Claridad y redacción", "peso": 25 },
  { "criterio": "Completitud del contenido", "peso": 40 },
  { "criterio": "Uso correcto de conceptos", "peso": 35 }
]`}</pre>
              </div>
              <Textarea
                rows={3}
                placeholder='[{"criterio": "Claridad", "peso": 30}, {"criterio": "Completitud", "peso": 70}]'
                value={form.rubric ? JSON.stringify(form.rubric, null, 2) : ""}
                onChange={(e) => {
                  try {
                    setForm({ ...form, rubric: JSON.parse(e.target.value) });
                  } catch {
                    /* allow typing */
                  }
                }}
                className="font-mono text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={save}>{form.id ? "Guardar" : "Crear"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assignment / Exclusion Dialog (course-level workshop) */}
      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Asignación del taller — {assignWs?.title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {/* Course selector (read-only — workshops belong to one course) */}
            <div>
              <Label className="text-xs">Curso al que se asigna</Label>
              <Select value={assignWs?.course_id ?? undefined} disabled>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Curso" />
                </SelectTrigger>
                <SelectContent>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                      {c.period ? ` (${c.period})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">
                Los talleres se asignan a nivel de curso. Para moverlo a otro curso, edita el
                taller.
              </p>
            </div>

            <div className="rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground">
              Por defecto el taller se asigna a <strong>todos</strong> los estudiantes matriculados.
              Desmarca abajo para <strong>excluir</strong> a quienes no deban recibirlo.
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {assignedIds.size} asignados · {students.length - assignedIds.size} excluidos
              </span>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1"
                  onClick={assignAll}
                >
                  <CheckSquare className="h-3 w-3" /> Incluir a todos
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1"
                  onClick={unassignAll}
                >
                  <XSquare className="h-3 w-3" /> Excluir a todos
                </Button>
              </div>
            </div>
            <div className="max-h-72 overflow-y-auto space-y-0.5 rounded-md border p-1">
              {students.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No hay estudiantes matriculados en este curso.
                </p>
              )}
              {students.map((s) => {
                const included = assignedIds.has(s.id);
                return (
                  <label
                    key={s.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 text-sm cursor-pointer"
                  >
                    <Checkbox
                      checked={included}
                      onCheckedChange={(v) => toggleAssign(s.id, !!v)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{s.full_name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {s.institutional_email}
                      </div>
                    </div>
                    {included ? (
                      <Badge variant="secondary" className="text-[9px] shrink-0">
                        Incluido
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="text-[9px] shrink-0 border-destructive/40 text-destructive"
                      >
                        Excluido
                      </Badge>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Grading Dialog */}
      <Dialog open={gradingOpen} onOpenChange={setGradingOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Calificaciones — {gradingWs?.title}</DialogTitle>
          </DialogHeader>
          {/* Course scale info */}
          {(() => {
            const course = courses.find((c) => c.id === gradingWs?.course_id);
            return course ? (
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground rounded-md border p-2 bg-muted/30">
                <span>
                  Escala del curso:{" "}
                  <span className="font-medium text-foreground tabular-nums">
                    {course.grade_scale_min}–{course.grade_scale_max}
                  </span>
                </span>
                <span>
                  Aprobar ≥{" "}
                  <span className="font-medium text-foreground tabular-nums">
                    {course.passing_grade}
                  </span>
                </span>
                <span>
                  Puntaje taller:{" "}
                  <span className="font-medium text-foreground tabular-nums">
                    0–{gradingWs?.max_score ?? 100}
                  </span>
                </span>
              </div>
            ) : null;
          })()}
          {/* Bulk AI action */}
          {wsSubs.length > 0 && (
            <div className="flex items-center justify-between p-3 rounded-md border bg-muted/30">
              <div>
                <p className="text-sm font-medium">Calificar con IA</p>
                <p className="text-xs text-muted-foreground">
                  Califica (o recalifica) todas las entregas con IA. Quedarán en revisión para tu
                  aprobación.
                </p>
              </div>
              <Button size="sm" onClick={gradeAllWithAI} disabled={aiGradingAll}>
                {aiGradingAll ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4 mr-1" />
                )}
                Calificar todo con IA
              </Button>
            </div>
          )}
          <div className="space-y-3">
            {wsSubs.length === 0 && (
              <p className="text-sm text-muted-foreground">No hay entregas aún.</p>
            )}
            {wsSubs.map((sub) => (
              <Card
                key={sub.id}
                className={
                  sub.status === "ai_revisado" ? "border-amber-400/50 dark:border-amber-500/30" : ""
                }
              >
                <CardContent className="p-4 space-y-3">
                  {/* Header */}
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-sm">{sub.profile?.full_name}</div>
                      <div className="text-xs text-muted-foreground">
                        {sub.profile?.institutional_email}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge
                        variant={
                          sub.status === "calificado"
                            ? "default"
                            : sub.status === "ai_revisado"
                              ? "outline"
                              : sub.status === "entregado"
                                ? "secondary"
                                : "outline"
                        }
                        className={`text-[10px] ${sub.status === "ai_revisado" ? "border-amber-400 text-amber-600 dark:text-amber-400" : ""}`}
                      >
                        {sub.status === "calificado"
                          ? "Calificado"
                          : sub.status === "ai_revisado"
                            ? "Revisión IA"
                            : sub.status === "entregado"
                              ? "Entregado"
                              : "Pendiente"}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                        onClick={() =>
                          deleteSubmission(sub.id, sub.profile?.full_name ?? "este estudiante")
                        }
                        title="Eliminar entrega"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {/* Student content */}
                  {sub.content && (
                    <p className="text-sm bg-muted/50 p-2.5 rounded whitespace-pre-wrap">
                      {sub.content}
                    </p>
                  )}
                  {sub.file_url && (
                    <button
                      onClick={async () => {
                        const { data } = await supabase.storage
                          .from("workshop-files")
                          .createSignedUrl(sub.file_url!, 3600);
                        if (data?.signedUrl) window.open(data.signedUrl, "_blank");
                        else toast.error("No se pudo generar el enlace de descarga");
                      }}
                      className="flex items-center gap-1.5 text-sm text-primary hover:underline"
                    >
                      <FileIcon className="h-3.5 w-3.5" />
                      <span className="truncate max-w-[200px]">
                        {sub.file_url.split("/").pop()}
                      </span>
                      <Download className="h-3 w-3 shrink-0" />
                    </button>
                  )}
                  {sub.external_link && (
                    <a
                      href={sub.external_link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-primary flex items-center gap-1"
                    >
                      <ExternalLink className="h-3 w-3" /> {sub.external_link}
                    </a>
                  )}

                  {/* AI Review pending approval */}
                  {sub.status === "ai_revisado" && sub.ai_grade != null && (
                    <div className="rounded-md border border-amber-400/50 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-amber-500" />
                        <span className="text-sm font-medium">
                          Calificación IA: {sub.ai_grade}/{gradingWs?.max_score ?? 100}
                        </span>
                      </div>
                      {sub.ai_feedback && (
                        <p className="text-sm text-muted-foreground">{sub.ai_feedback}</p>
                      )}
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1 border-emerald-500/50 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
                          onClick={() => approveAIGrade(sub.id)}
                        >
                          <ThumbsUp className="h-3.5 w-3.5" /> Aprobar
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1 border-destructive/50 text-destructive hover:bg-destructive/5"
                          onClick={() => rejectAIGrade(sub.id)}
                        >
                          <ThumbsDown className="h-3.5 w-3.5" /> Rechazar
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Manual grading / override */}
                  <div className="space-y-2">
                    <div>
                      <Label className="text-xs">Nota final</Label>
                      <Input
                        type="number"
                        min={0}
                        max={gradingWs?.max_score ?? 100}
                        value={sub.final_grade ?? ""}
                        onChange={(e) => {
                          setWsSubs((prev) =>
                            prev.map((s) =>
                              s.id === sub.id
                                ? {
                                    ...s,
                                    final_grade:
                                      e.target.value === "" ? null : Number(e.target.value),
                                  }
                                : s,
                            ),
                          );
                        }}
                        className="h-8 text-sm mt-1"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Retroalimentación</Label>
                      <Textarea
                        rows={3}
                        value={sub.teacher_feedback ?? ""}
                        onChange={(e) => {
                          setWsSubs((prev) =>
                            prev.map((s) =>
                              s.id === sub.id ? { ...s, teacher_feedback: e.target.value } : s,
                            ),
                          );
                        }}
                        className="text-sm mt-1"
                        placeholder="Escribe tu retroalimentación detallada..."
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          saveGrade(sub.id, sub.final_grade ?? 0, sub.teacher_feedback ?? "")
                        }
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Guardar nota
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => gradeOneWithAI(sub)}
                        disabled={aiGradingId === sub.id}
                      >
                        {aiGradingId === sub.id ? (
                          <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                        ) : (
                          <Sparkles className="h-3.5 w-3.5 mr-1" />
                        )}
                        {sub.status === "calificado" || sub.status === "ai_revisado"
                          ? "Recalificar con IA"
                          : "Calificar con IA"}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function toLocal(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Convert an ISO date string to datetime-local input format */
function toLocalDatetime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "";
  }
}
