import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Users,
  Pencil,
  Copy,
  UserCog,
  Search,
  CheckSquare,
  XSquare,
  Loader2,
  Settings,
} from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";

export const Route = createFileRoute("/app/admin/courses")({ component: AdminCourses });

type Course = {
  id: string;
  name: string;
  description: string | null;
  period: string | null;
  start_date: string | null;
  end_date: string | null;
  grade_scale_min: number;
  grade_scale_max: number;
  exam_weight: number;
  workshop_weight: number;
  attendance_weight: number;
  passing_grade: number;
  max_exam_attempts: number;
};

/** Normaliza un valor de fecha (ISO timestamp o YYYY-MM-DD) a YYYY-MM-DD para inputs <date>. */
function toDateInput(value: string | null | undefined): string {
  if (!value) return "";
  // Si viene como ISO con tiempo, recorta. Si viene YYYY-MM-DD, la primera parte ya es eso.
  return value.length >= 10 ? value.slice(0, 10) : value;
}
type Profile = { id: string; full_name: string; institutional_email: string };

function AdminCourses() {
  const { roles } = useAuth();
  const confirm = useConfirm();
  const [courses, setCourses] = useState<Course[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Course> | null>(null);

  // Enrollment
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollCourse, setEnrollCourse] = useState<Course | null>(null);
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  const [enrolledIds, setEnrolledIds] = useState<Set<string>>(new Set());
  const [enrollSearch, setEnrollSearch] = useState("");

  // Teacher assignment
  const [teacherOpen, setTeacherOpen] = useState(false);
  const [teacherCourse, setTeacherCourse] = useState<Course | null>(null);
  const [teachers, setTeachers] = useState<Profile[]>([]);
  const [assignedTeacherIds, setAssignedTeacherIds] = useState<Set<string>>(new Set());

  // Duplicate
  const [dupOpen, setDupOpen] = useState(false);
  const [dupSource, setDupSource] = useState<Course | null>(null);
  const [dupName, setDupName] = useState("");
  const [dupPeriod, setDupPeriod] = useState("");
  const [dupCopyExams, setDupCopyExams] = useState(true);
  const [dupCopyWorkshops, setDupCopyWorkshops] = useState(true);
  const [dupCopyStudents, setDupCopyStudents] = useState(false);
  const [dupLoading, setDupLoading] = useState(false);

  const isAdmin = roles.includes("Admin");

  const load = async () => {
    const { data } = await supabase
      .from("courses")
      .select("*")
      .order("period", { ascending: false, nullsFirst: false })
      .order("name");
    setCourses((data ?? []) as Course[]);
  };
  useEffect(() => {
    load();
  }, []);

  // ── Course CRUD ──────────────────────────────────────────

  const openNew = () => {
    setEditing({
      id: "",
      name: "",
      description: "",
      period: "",
      start_date: "",
      end_date: "",
      grade_scale_min: 0,
      grade_scale_max: 5,
      exam_weight: 40,
      workshop_weight: 40,
      attendance_weight: 10,
      passing_grade: 3,
      max_exam_attempts: 1,
    });
    setOpen(true);
  };

  const save = async () => {
    if (!editing?.name?.trim()) {
      toast.error("Nombre requerido");
      return;
    }
    const startInput = toDateInput(editing.start_date);
    const endInput = toDateInput(editing.end_date);
    if (startInput && endInput && startInput > endInput) {
      toast.error("La fecha de fin debe ser posterior a la fecha de inicio");
      return;
    }
    const payload = {
      name: editing.name,
      description: editing.description || null,
      period: editing.period || null,
      start_date: startInput || null,
      end_date: endInput || null,
      grade_scale_min: Number(editing.grade_scale_min ?? 0),
      grade_scale_max: Number(editing.grade_scale_max ?? 5),
      exam_weight: Number(editing.exam_weight ?? 40),
      workshop_weight: Number(editing.workshop_weight ?? 40),
      attendance_weight: Number(editing.attendance_weight ?? 10),
      passing_grade: Number(editing.passing_grade ?? 3),
      max_exam_attempts: Math.max(1, Number(editing.max_exam_attempts ?? 1)),
    };
    if (editing.id) {
      const { error } = await supabase.from("courses").update(payload).eq("id", editing.id);
      if (error) return toast.error(error.message);
    } else {
      const { error } = await supabase.from("courses").insert(payload);
      if (error) return toast.error(error.message);
    }
    toast.success("Curso guardado correctamente");
    setOpen(false);
    setEditing(null);
    load();
  };

  const remove = async (id: string) => {
    const ok = await confirm({
      title: "Eliminar curso",
      description:
        "Se eliminarán también las matrículas, exámenes y talleres asociados. Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar curso",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("courses").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Curso eliminado correctamente");
    load();
  };

  // ── Student Enrollment ───────────────────────────────────

  const openEnroll = async (c: Course) => {
    setEnrollCourse(c);
    setEnrollSearch("");
    const [{ data: profs }, { data: enr }] = await Promise.all([
      supabase.from("profiles").select("id, full_name, institutional_email").order("full_name"),
      supabase.from("course_enrollments").select("user_id").eq("course_id", c.id),
    ]);
    setAllProfiles(profs ?? []);
    setEnrolledIds(new Set((enr ?? []).map((e: any) => e.user_id)));
    setEnrollOpen(true);
  };

  const filteredProfiles = useMemo(() => {
    if (!enrollSearch.trim()) return allProfiles;
    const q = enrollSearch.toLowerCase();
    return allProfiles.filter(
      (p) =>
        p.full_name.toLowerCase().includes(q) || p.institutional_email.toLowerCase().includes(q),
    );
  }, [allProfiles, enrollSearch]);

  const toggleEnroll = async (uid: string, checked: boolean) => {
    if (!enrollCourse) return;
    if (checked) {
      const { error } = await supabase
        .from("course_enrollments")
        .upsert({ course_id: enrollCourse.id, user_id: uid }, { onConflict: "course_id,user_id", ignoreDuplicates: true });
      if (error) return toast.error(error.message);
      setEnrolledIds((prev) => new Set([...prev, uid]));
      toast.success("Estudiante matriculado correctamente");
    } else {
      const { error } = await supabase
        .from("course_enrollments")
        .delete()
        .eq("course_id", enrollCourse.id)
        .eq("user_id", uid);
      if (error) return toast.error(error.message);
      setEnrolledIds((prev) => {
        const s = new Set(prev);
        s.delete(uid);
        return s;
      });
      toast.success("Estudiante desmatriculado correctamente");
    }
  };

  const enrollAll = async () => {
    if (!enrollCourse) return;
    const toAdd = filteredProfiles.filter((p) => !enrolledIds.has(p.id));
    if (!toAdd.length) return;
    const { error } = await supabase
      .from("course_enrollments")
      .insert(toAdd.map((p) => ({ course_id: enrollCourse.id, user_id: p.id })));
    if (error) return toast.error(error.message);
    setEnrolledIds((prev) => new Set([...prev, ...toAdd.map((p) => p.id)]));
    toast.success(`${toAdd.length} estudiante(s) matriculados correctamente`);
  };

  const unenrollAll = async () => {
    if (!enrollCourse) return;
    const toRemove = filteredProfiles.filter((p) => enrolledIds.has(p.id));
    if (!toRemove.length) return;
    for (const p of toRemove) {
      await supabase
        .from("course_enrollments")
        .delete()
        .eq("course_id", enrollCourse.id)
        .eq("user_id", p.id);
    }
    setEnrolledIds((prev) => {
      const s = new Set(prev);
      toRemove.forEach((p) => s.delete(p.id));
      return s;
    });
    toast.success(`${toRemove.length} estudiante(s) desmatriculados correctamente`);
  };

  // ── Teacher Assignment ───────────────────────────────────

  const openTeachers = async (c: Course) => {
    setTeacherCourse(c);
    // Get all users with Docente role
    const { data: roleRows } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("role", "Docente");
    const teacherIds = (roleRows ?? []).map((r: any) => r.user_id);
    if (teacherIds.length) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, full_name, institutional_email")
        .in("id", teacherIds)
        .order("full_name");
      setTeachers((profs ?? []) as Profile[]);
    } else {
      setTeachers([]);
    }
    const { data: assigned } = await supabase
      .from("course_teachers")
      .select("user_id")
      .eq("course_id", c.id);
    setAssignedTeacherIds(new Set((assigned ?? []).map((a: any) => a.user_id)));
    setTeacherOpen(true);
  };

  const toggleTeacher = async (uid: string, checked: boolean) => {
    if (!teacherCourse) return;
    if (checked) {
      const { error } = await supabase
        .from("course_teachers")
        .insert({ course_id: teacherCourse.id, user_id: uid });
      if (error) return toast.error(error.message);
      setAssignedTeacherIds((prev) => new Set([...prev, uid]));
      toast.success("Docente asignado correctamente");
    } else {
      const { error } = await supabase
        .from("course_teachers")
        .delete()
        .eq("course_id", teacherCourse.id)
        .eq("user_id", uid);
      if (error) return toast.error(error.message);
      setAssignedTeacherIds((prev) => {
        const s = new Set(prev);
        s.delete(uid);
        return s;
      });
      toast.success("Docente desasignado correctamente");
    }
  };

  // ── Duplicate Course ─────────────────────────────────────

  const openDuplicate = (c: Course) => {
    setDupSource(c);
    setDupName(`${c.name} (copia)`);
    setDupPeriod(c.period ?? "");
    setDupCopyExams(true);
    setDupCopyWorkshops(true);
    setDupCopyStudents(true);
    setDupOpen(true);
  };

  const doDuplicate = async () => {
    if (!dupSource || !dupName.trim()) {
      toast.error("Nombre requerido");
      return;
    }
    setDupLoading(true);
    let copiedStudents = 0;
    try {
      // 1. Create new course
      const { data: newCourse, error: cErr } = await supabase
        .from("courses")
        .insert({
          name: dupName,
          description: dupSource.description,
          period: dupPeriod || null,
          start_date: toDateInput(dupSource.start_date) || null,
          end_date: toDateInput(dupSource.end_date) || null,
          grade_scale_min: dupSource.grade_scale_min,
          grade_scale_max: dupSource.grade_scale_max,
          passing_grade: dupSource.passing_grade,
          exam_weight: dupSource.exam_weight,
          workshop_weight: dupSource.workshop_weight,
          attendance_weight: dupSource.attendance_weight,
          max_exam_attempts: dupSource.max_exam_attempts ?? 1,
        })
        .select()
        .single();
      if (cErr || !newCourse) throw new Error(cErr?.message ?? "Error creando curso");

      // 2. Copy students (CRÍTICO: replicar todas las matrículas)
      if (dupCopyStudents) {
        const { data: enr, error: enrErr } = await supabase
          .from("course_enrollments")
          .select("user_id")
          .eq("course_id", dupSource.id);
        if (enrErr) console.error("read enrollments:", enrErr);
        if (enr?.length) {
          const rows = enr.map((e: any) => ({ course_id: newCourse.id, user_id: e.user_id }));
          const { error: insErr, count } = await supabase
            .from("course_enrollments")
            .insert(rows, { count: "exact" });
          if (insErr) {
            console.error("copy enrollments:", insErr);
            toast.error(`No se pudieron copiar las matrículas: ${insErr.message}`);
          } else {
            copiedStudents = count ?? rows.length;
          }
        }
      }

      // 3. Copy teachers
      const { data: ct } = await supabase
        .from("course_teachers")
        .select("user_id")
        .eq("course_id", dupSource.id);
      if (ct?.length) {
        await supabase
          .from("course_teachers")
          .insert(ct.map((t: any) => ({ course_id: newCourse.id, user_id: t.user_id })));
      }

      // 4. Copy exams (without submissions/assignments)
      if (dupCopyExams) {
        const { data: exams } = await supabase
          .from("exams")
          .select("*")
          .eq("course_id", dupSource.id);
        for (const exam of exams ?? []) {
          const { data: newExam } = await supabase
            .from("exams")
            .insert({
              course_id: newCourse.id,
              created_by: exam.created_by,
              title: exam.title,
              description: exam.description,
              start_time: exam.start_time,
              end_time: exam.end_time,
              time_limit_minutes: exam.time_limit_minutes,
              navigation_type: exam.navigation_type,
              shuffle_enabled: exam.shuffle_enabled,
              max_attempts: (exam as any).max_attempts ?? null,
            })
            .select()
            .single();
          if (newExam) {
            // Copy questions
            const { data: qs } = await supabase
              .from("questions")
              .select("*")
              .eq("exam_id", exam.id);
            if (qs?.length) {
              await supabase.from("questions").insert(
                qs.map((q: any) => ({
                  exam_id: newExam.id,
                  type: q.type,
                  content: q.content,
                  expected_rubric: q.expected_rubric,
                  options: q.options,
                  points: q.points,
                  position: q.position,
                  language: q.language,
                  starter_code: q.starter_code,
                  test_cases: q.test_cases,
                })),
              );
            }
          }
        }
      }

      // 5. Copy workshops (without submissions/assignments)
      if (dupCopyWorkshops) {
        const { data: ws } = await supabase
          .from("workshops")
          .select("*")
          .eq("course_id", dupSource.id);
        if (ws?.length) {
          await supabase.from("workshops").insert(
            ws.map((w: any) => ({
              course_id: newCourse.id,
              created_by: w.created_by,
              title: w.title,
              description: w.description,
              instructions: w.instructions,
              external_link: w.external_link,
              due_date: w.due_date,
              rubric: w.rubric,
              max_score: w.max_score,
              status: "draft",
            })),
          );
        }
      }

      const studentsMsg = dupCopyStudents
        ? ` (${copiedStudents} estudiante${copiedStudents === 1 ? "" : "s"} copiado${copiedStudents === 1 ? "" : "s"})`
        : "";
      toast.success(`Curso duplicado correctamente${studentsMsg}`);
      setDupOpen(false);
      load();
    } catch (e: any) {
      toast.error(e.message ?? "Error al duplicar");
    } finally {
      setDupLoading(false);
    }
  };

  // ── Grading Weights ──────────────────────────────────────

  const [weightsOpen, setWeightsOpen] = useState(false);
  const [weightsCourse, setWeightsCourse] = useState<Course | null>(null);
  const [weights, setWeights] = useState<{ component: string; weight: number }[]>([]);
  const [newComponent, setNewComponent] = useState("");

  const openWeights = async (c: Course) => {
    setWeightsCourse(c);
    const { data } = await supabase
      .from("course_grading_weights")
      .select("component, weight")
      .eq("course_id", c.id)
      .order("component");
    const items = (data ?? []) as { component: string; weight: number }[];
    // Ensure default components exist
    const defaults = ["asistencia", "talleres", "parciales"];
    defaults.forEach((d) => {
      if (!items.find((i) => i.component === d)) items.push({ component: d, weight: 0 });
    });
    setWeights(items);
    setWeightsOpen(true);
  };

  const updateWeight = (component: string, value: number) => {
    setWeights((prev) =>
      prev.map((w) => (w.component === component ? { ...w, weight: value } : w)),
    );
  };

  const addComponent = () => {
    if (!newComponent.trim()) return;
    const name = newComponent.trim().toLowerCase();
    if (weights.find((w) => w.component === name)) {
      toast.error("Ya existe ese componente");
      return;
    }
    setWeights((prev) => [...prev, { component: name, weight: 0 }]);
    setNewComponent("");
  };

  const removeComponent = (component: string) => {
    setWeights((prev) => prev.filter((w) => w.component !== component));
  };

  const saveWeights = async () => {
    if (!weightsCourse) return;
    const total = weights.reduce((sum, w) => sum + w.weight, 0);
    if (total !== 100 && total !== 0) {
      toast.error(`Los pesos suman ${total}%. Deben sumar 100%.`);
      return;
    }
    // Delete existing and re-insert
    await supabase.from("course_grading_weights").delete().eq("course_id", weightsCourse.id);
    if (weights.filter((w) => w.weight > 0).length) {
      const { error } = await supabase.from("course_grading_weights").insert(
        weights
          .filter((w) => w.weight > 0)
          .map((w) => ({
            course_id: weightsCourse.id,
            component: w.component,
            weight: w.weight,
          })),
      );
      if (error) {
        toast.error(error.message);
        return;
      }
    }
    toast.success("Pesos de calificación guardados correctamente");
    setWeightsOpen(false);
  };

  if (!isAdmin) return <p className="text-muted-foreground">Necesitas rol Admin.</p>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cursos</h1>
          <p className="text-sm text-muted-foreground">{courses.length} cursos registrados</p>
        </div>
        <Button size="sm" onClick={openNew}>
          <Plus className="h-4 w-4 mr-1" /> Nuevo curso
        </Button>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead className="hidden sm:table-cell">Periodo</TableHead>
                <TableHead className="hidden sm:table-cell">Escala</TableHead>
                <TableHead className="hidden md:table-cell">Fechas</TableHead>
                <TableHead className="hidden lg:table-cell">Descripción</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {courses.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No hay cursos creados.
                  </TableCell>
                </TableRow>
              )}
              {courses.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">
                    <div className="flex flex-col gap-1">
                      <span>{c.name}</span>
                      {c.period && (
                        <Badge variant="outline" className="text-[10px] w-fit sm:hidden">
                          {c.period}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {c.period ? (
                      <Badge variant="outline" className="text-xs">
                        {c.period}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <div className="text-xs tabular-nums">
                      <span className="font-medium">
                        {c.grade_scale_min}–{c.grade_scale_max}
                      </span>
                      <span className="text-muted-foreground ml-1">(≥{c.passing_grade})</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                    {c.start_date && c.end_date
                      ? `${new Date(c.start_date + "T00:00").toLocaleDateString()} → ${new Date(c.end_date + "T00:00").toLocaleDateString()}`
                      : c.start_date
                        ? `Desde ${new Date(c.start_date + "T00:00").toLocaleDateString()}`
                        : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden lg:table-cell max-w-48 truncate">
                    {c.description ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-0.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openWeights(c)}
                        title="Pesos de calificación"
                      >
                        <Settings className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEnroll(c)}
                        title="Estudiantes"
                      >
                        <Users className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openTeachers(c)}
                        title="Docentes"
                      >
                        <UserCog className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openDuplicate(c)}
                        title="Duplicar"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditing(c);
                          setOpen(true);
                        }}
                        title="Editar"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => remove(c.id)}
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

      {/* ── Create/Edit Dialog ── */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Editar" : "Nuevo"} curso</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div>
                <Label>Nombre</Label>
                <Input
                  value={editing.name ?? ""}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="Ej: Programación II"
                />
              </div>
              <div>
                <Label>Periodo</Label>
                <Input
                  value={editing.period ?? ""}
                  onChange={(e) => setEditing({ ...editing, period: e.target.value })}
                  placeholder="Ej: 2026-1"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Fecha inicio</Label>
                  <Input
                    type="date"
                    value={editing.start_date ?? ""}
                    onChange={(e) => setEditing({ ...editing, start_date: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Fecha fin</Label>
                  <Input
                    type="date"
                    value={editing.end_date ?? ""}
                    onChange={(e) => setEditing({ ...editing, end_date: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <Label>Descripción</Label>
                <Textarea
                  value={editing.description ?? ""}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                />
              </div>

              <div className="rounded-md border p-3 space-y-3">
                <p className="text-sm font-medium">Escala de calificación</p>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs">Nota mínima</Label>
                    <Input
                      type="number"
                      step="0.1"
                      value={editing.grade_scale_min ?? 0}
                      onChange={(e) =>
                        setEditing({ ...editing, grade_scale_min: Number(e.target.value) })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Nota máxima</Label>
                    <Input
                      type="number"
                      step="0.1"
                      value={editing.grade_scale_max ?? 5}
                      onChange={(e) =>
                        setEditing({ ...editing, grade_scale_max: Number(e.target.value) })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Aprobar ≥</Label>
                    <Input
                      type="number"
                      step="0.1"
                      value={editing.passing_grade ?? 3}
                      onChange={(e) =>
                        setEditing({ ...editing, passing_grade: Number(e.target.value) })
                      }
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs">Peso exámenes (%)</Label>
                    <Input
                      type="number"
                      step="1"
                      value={editing.exam_weight || ""}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          exam_weight: e.target.value === "" ? 0 : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Peso talleres (%)</Label>
                    <Input
                      type="number"
                      step="1"
                      value={editing.workshop_weight || ""}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          workshop_weight: e.target.value === "" ? 0 : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Peso asistencia (%)</Label>
                    <Input
                      type="number"
                      step="1"
                      value={editing.attendance_weight || ""}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          attendance_weight: e.target.value === "" ? 0 : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                </div>
                {(() => {
                  const total =
                    (editing.exam_weight ?? 0) +
                    (editing.workshop_weight ?? 0) +
                    (editing.attendance_weight ?? 0);
                  return (
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        Total de pesos: debe sumar 100%
                      </p>
                      <Badge
                        variant={total === 100 ? "default" : "destructive"}
                        className="text-xs"
                      >
                        {total}%
                      </Badge>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={save}>Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Student Enrollment Dialog ── */}
      <Dialog open={enrollOpen} onOpenChange={setEnrollOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Estudiantes — {enrollCourse?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por nombre o email..."
                value={enrollSearch}
                onChange={(e) => setEnrollSearch(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
            {/* Bulk actions */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {enrolledIds.size} matriculados de {allProfiles.length}
                {enrollSearch && ` · ${filteredProfiles.length} filtrados`}
              </span>
              <div className="flex gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1"
                  onClick={enrollAll}
                >
                  <CheckSquare className="h-3 w-3" /> Seleccionar{" "}
                  {enrollSearch ? "filtrados" : "todos"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1"
                  onClick={unenrollAll}
                >
                  <XSquare className="h-3 w-3" /> Deseleccionar{" "}
                  {enrollSearch ? "filtrados" : "todos"}
                </Button>
              </div>
            </div>
            {/* List */}
            <div className="max-h-72 overflow-y-auto space-y-0.5 rounded-md border p-1">
              {filteredProfiles.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">Sin resultados</p>
              )}
              {filteredProfiles.map((s) => (
                <label
                  key={s.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 text-sm cursor-pointer"
                >
                  <Checkbox
                    checked={enrolledIds.has(s.id)}
                    onCheckedChange={(v) => toggleEnroll(s.id, !!v)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{s.full_name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {s.institutional_email}
                    </div>
                  </div>
                  {enrolledIds.has(s.id) && (
                    <Badge variant="secondary" className="text-[9px] shrink-0">
                      Matriculado
                    </Badge>
                  )}
                </label>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Teacher Assignment Dialog ── */}
      <Dialog open={teacherOpen} onOpenChange={setTeacherOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Docentes — {teacherCourse?.name}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Asigna uno o más docentes a este curso.</p>
          <div className="max-h-72 overflow-y-auto space-y-0.5 rounded-md border p-1">
            {teachers.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                No hay usuarios con rol Docente.
              </p>
            )}
            {teachers.map((t) => (
              <label
                key={t.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 text-sm cursor-pointer"
              >
                <Checkbox
                  checked={assignedTeacherIds.has(t.id)}
                  onCheckedChange={(v) => toggleTeacher(t.id, !!v)}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{t.full_name}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {t.institutional_email}
                  </div>
                </div>
                {assignedTeacherIds.has(t.id) && (
                  <Badge variant="secondary" className="text-[9px] shrink-0">
                    Asignado
                  </Badge>
                )}
              </label>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Duplicate Course Dialog ── */}
      <Dialog open={dupOpen} onOpenChange={setDupOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Duplicar curso</DialogTitle>
          </DialogHeader>
          {dupSource && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Creará una copia de <strong>{dupSource.name}</strong> con la configuración
                seleccionada.
              </p>
              <div>
                <Label>Nombre del nuevo curso</Label>
                <Input value={dupName} onChange={(e) => setDupName(e.target.value)} />
              </div>
              <div>
                <Label>Periodo</Label>
                <Input
                  value={dupPeriod}
                  onChange={(e) => setDupPeriod(e.target.value)}
                  placeholder="Ej: 2026-2"
                />
              </div>
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">¿Qué copiar?</p>
                <label className="flex items-center justify-between">
                  <div>
                    <div className="text-sm">Exámenes y preguntas</div>
                    <div className="text-xs text-muted-foreground">
                      Se copian como borrador sin asignaciones
                    </div>
                  </div>
                  <Switch checked={dupCopyExams} onCheckedChange={setDupCopyExams} />
                </label>
                <label className="flex items-center justify-between">
                  <div>
                    <div className="text-sm">Talleres</div>
                    <div className="text-xs text-muted-foreground">
                      Se copian como borrador sin entregas
                    </div>
                  </div>
                  <Switch checked={dupCopyWorkshops} onCheckedChange={setDupCopyWorkshops} />
                </label>
                <label className="flex items-center justify-between">
                  <div>
                    <div className="text-sm">Estudiantes matriculados</div>
                    <div className="text-xs text-muted-foreground">
                      Copia las matrículas al nuevo curso
                    </div>
                  </div>
                  <Switch checked={dupCopyStudents} onCheckedChange={setDupCopyStudents} />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                Los docentes asignados siempre se copian.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDupOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={doDuplicate} disabled={dupLoading}>
              {dupLoading ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Copy className="h-4 w-4 mr-1" />
              )}
              Duplicar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Grading Weights Dialog ── */}
      <Dialog open={weightsOpen} onOpenChange={setWeightsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Pesos de calificación — {weightsCourse?.name}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Define qué porcentaje del 100% corresponde a cada componente.
          </p>
          <div className="space-y-2">
            {weights.map((w) => (
              <div key={w.component} className="flex items-center gap-2">
                <span className="text-sm font-medium capitalize flex-1 min-w-0 truncate">
                  {w.component}
                </span>
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={w.weight || ""}
                    onChange={(e) =>
                      updateWeight(w.component, e.target.value === "" ? 0 : Number(e.target.value))
                    }
                    className="w-16 h-8 text-sm text-center"
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>
                {!["asistencia", "talleres", "parciales"].includes(w.component) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => removeComponent(w.component)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                )}
              </div>
            ))}
          </div>
          {/* Add custom component */}
          <div className="flex items-center gap-2 pt-2 border-t">
            <Input
              value={newComponent}
              onChange={(e) => setNewComponent(e.target.value)}
              placeholder="Ej: participación, proyecto"
              className="h-8 text-sm flex-1"
              onKeyDown={(e) => e.key === "Enter" && addComponent()}
            />
            <Button variant="outline" size="sm" className="h-8" onClick={addComponent}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Agregar
            </Button>
          </div>
          {/* Total indicator */}
          <div className="flex items-center justify-between pt-2 border-t">
            <span className="text-sm font-medium">Total</span>
            <Badge
              variant={
                weights.reduce((s, w) => s + w.weight, 0) === 100 ? "default" : "destructive"
              }
              className="text-xs"
            >
              {weights.reduce((s, w) => s + w.weight, 0)}%
            </Badge>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWeightsOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={saveWeights}>Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
