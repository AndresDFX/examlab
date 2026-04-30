/**
 * Teacher — Projects CRUD (refactor: entregas en cajas de texto + IA).
 *
 * Espejo del módulo de talleres pero con "archivos" en vez de preguntas.
 * Cada proyecto tiene N archivos esperados (`project_files` rows). El
 * estudiante NO sube ZIPs: pega el contenido textual de cada archivo en
 * una caja, y al enviar la IA califica cada caja.
 *
 * Reusa `projects.max_files` (entero) como número de archivos esperados.
 * La generación con IA crea N rows en `project_files` con título, descripción
 * y rúbrica para que la calificación sea consistente.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DateTimePicker } from "@/components/DatePicker";
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
import { Plus, Pencil, Trash2, Users, FileText, Loader2 } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { TeacherProjectFilesEditor } from "@/components/ProjectFiles";

// projects, project_* aún no están en los tipos generados.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const Route = createFileRoute("/app/teacher/projects")({ component: TeacherProjects });

type Course = { id: string; name: string; period: string | null; language?: string | null };
type Cut = { id: string; course_id: string; name: string };
type Student = { id: string; full_name: string; institutional_email: string };

type Project = {
  id: string;
  course_id: string;
  cut_id: string | null;
  title: string;
  description: string | null;
  instructions: string | null;
  max_files: number;
  start_date: string | null;
  due_date: string | null;
  max_score: number;
  status: "draft" | "published" | "closed";
  course?: { name: string; period: string | null; language?: string | null };
  // Lista de IDs de cursos vinculados (incluye course_id primario)
  linked_course_ids?: string[];
};

function TeacherProjects() {
  const { user, roles } = useAuth();
  const { t } = useTranslation();
  const confirm = useConfirm();
  const isTeacher = roles.includes("Docente") || roles.includes("Admin");

  const [courses, setCourses] = useState<Course[]>([]);
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [form, setForm] = useState<Partial<Project>>({});

  const [filesOpen, setFilesOpen] = useState(false);
  const [filesProject, setFilesProject] = useState<Project | null>(null);

  const [assignOpen, setAssignOpen] = useState(false);
  const [assignProject, setAssignProject] = useState<Project | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [assigned, setAssigned] = useState<Set<string>>(new Set());

  const load = async () => {
    // Cada query se aísla en su propio try para que un fallo (p.ej. una
    // migración faltante) no esconda los datos que SÍ podemos cargar. Antes
    // un solo `Promise.all` rechazaba el load entero y la tabla quedaba
    // vacía sin mensaje, lo que bloqueaba el diagnóstico.
    try {
      const cs = await db.from("courses").select("id, name, period, language").order("name");
      if (cs.error) throw new Error(`courses: ${cs.error.message}`);
      setCourses((cs.data ?? []) as Course[]);
    } catch (e) {
      console.error("[projects] courses load failed", e);
      toast.error(e instanceof Error ? e.message : "Error cargando cursos");
    }

    try {
      const cs2 = await db.from("grade_cuts").select("id, course_id, name").order("position");
      if (cs2.error) throw new Error(`grade_cuts: ${cs2.error.message}`);
      setCuts((cs2.data ?? []) as Cut[]);
    } catch (e) {
      console.error("[projects] grade_cuts load failed", e);
      // No mostramos toast aquí: cuts es opcional para listar.
    }

    let pcsRows: { project_id: string; course_id: string }[] = [];
    try {
      const pcs = await db.from("project_courses").select("project_id, course_id");
      if (pcs.error) throw new Error(`project_courses: ${pcs.error.message}`);
      pcsRows = (pcs.data ?? []) as { project_id: string; course_id: string }[];
    } catch (e) {
      console.error("[projects] project_courses load failed", e);
      toast.error(e instanceof Error ? e.message : "Error cargando vínculos de cursos");
    }

    try {
      // El JOIN `course:courses(...)` puede fallar si la columna `language`
      // no existe en la BD. Si falla, reintentamos sin el JOIN para mostrar
      // al menos los proyectos en bruto.
      let ps = await db
        .from("projects")
        .select("*, course:courses(name, period, language)")
        .order("created_at", { ascending: false });
      if (ps.error) {
        console.warn("[projects] projects+join failed, retrying without join", ps.error);
        ps = await db.from("projects").select("*").order("created_at", { ascending: false });
      }
      if (ps.error) throw new Error(`projects: ${ps.error.message}`);

      const linkMap = new Map<string, string[]>();
      for (const row of pcsRows) {
        const arr = linkMap.get(row.project_id) ?? [];
        arr.push(row.course_id);
        linkMap.set(row.project_id, arr);
      }
      const enriched = ((ps.data ?? []) as Project[]).map((p) => {
        const linked = linkMap.get(p.id) ?? [];
        const set = new Set<string>(linked);
        if (p.course_id) set.add(p.course_id);
        return { ...p, linked_course_ids: Array.from(set) };
      });
      setProjects(enriched);
      console.info(`[projects] loaded ${enriched.length} project(s)`);
    } catch (e) {
      console.error("[projects] projects load failed", e);
      toast.error(e instanceof Error ? e.message : "Error cargando proyectos");
    }
  };

  useEffect(() => {
    if (!isTeacher) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTeacher]);

  const openNew = () => {
    setEditing(null);
    const first = courses[0]?.id;
    setForm({
      title: "",
      description: "",
      instructions: "",
      course_id: first,
      cut_id: null,
      max_files: 3,
      max_score: 100,
      status: "draft",
      linked_course_ids: first ? [first] : [],
    });
    setOpen(true);
  };

  const openEdit = (p: Project) => {
    setEditing(p);
    setForm({
      ...p,
      linked_course_ids: p.linked_course_ids?.length
        ? p.linked_course_ids
        : p.course_id
          ? [p.course_id]
          : [],
    });
    setOpen(true);
  };

  const toggleFormCourse = (courseId: string) => {
    const current = new Set(form.linked_course_ids ?? []);
    if (current.has(courseId)) {
      current.delete(courseId);
    } else {
      current.add(courseId);
    }
    const next = Array.from(current);
    // El curso primario es el primero seleccionado
    const primary = next.includes(form.course_id ?? "")
      ? form.course_id
      : next[0];
    setForm({
      ...form,
      linked_course_ids: next,
      course_id: primary,
      // Si el corte ya no pertenece al curso primario, resetear
      cut_id: primary && cuts.find((c) => c.id === form.cut_id)?.course_id === primary
        ? form.cut_id
        : null,
    });
  };

  const save = async () => {
    const linked = form.linked_course_ids ?? [];
    if (!form.title || linked.length === 0 || !user) {
      toast.error("Título y al menos un curso son obligatorios");
      return;
    }
    const primaryCourse = form.course_id && linked.includes(form.course_id)
      ? form.course_id
      : linked[0];
    const maxFiles = Math.max(1, Math.min(20, Number(form.max_files) || 3));
    const payload = {
      course_id: primaryCourse,
      cut_id: form.cut_id || null,
      title: form.title,
      description: form.description ?? null,
      instructions: form.instructions ?? null,
      max_files: maxFiles,
      start_date: form.start_date ? new Date(form.start_date).toISOString() : null,
      due_date: form.due_date ? new Date(form.due_date).toISOString() : null,
      max_score: Number(form.max_score) || 100,
      status: form.status ?? "draft",
    };

    let projectId: string | null = null;
    if (editing) {
      const { error } = await db.from("projects").update(payload).eq("id", editing.id);
      if (error) return toast.error(error.message);
      projectId = editing.id;
      toast.success("Proyecto actualizado");
    } else {
      const { data: created, error } = await db
        .from("projects")
        .insert({ ...payload, created_by: user.id })
        .select("id")
        .single();
      if (error || !created) return toast.error(error?.message ?? "Error al crear");
      projectId = created.id;
      toast.success("Proyecto creado");
    }

    if (projectId) {
      // Sincronizar vínculos a cursos
      await db.from("project_courses").delete().eq("project_id", projectId);
      const rows = linked.map((cid) => ({ project_id: projectId, course_id: cid }));
      if (rows.length) await db.from("project_courses").insert(rows);
    }

    setOpen(false);
    await load();
  };

  const remove = async (p: Project) => {
    const ok = await confirm({
      title: `Eliminar ${p.title}`,
      description: "Se eliminará el proyecto y todas sus entregas.",
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("projects").delete().eq("id", p.id);
    if (error) return toast.error(error.message);
    toast.success("Proyecto eliminado");
    await load();
  };

  const openFilesDialog = (p: Project) => {
    setFilesProject(p);
    setFilesOpen(true);
  };

  const openAssignDialog = async (p: Project) => {
    setAssignProject(p);
    const courseIds = p.linked_course_ids?.length ? p.linked_course_ids : [p.course_id];
    const { data: enr } = await db
      .from("course_enrollments")
      .select("user_id, profile:profiles(id, full_name, institutional_email)")
      .in("course_id", courseIds);
    // Deduplicar por user.id (un estudiante puede estar en más de un curso vinculado)
    const seen = new Set<string>();
    const list: Student[] = [];
    for (const row of (enr ?? []) as { profile: Student | null }[]) {
      if (row.profile && !seen.has(row.profile.id)) {
        seen.add(row.profile.id);
        list.push(row.profile);
      }
    }
    setStudents(list);
    const { data: asgn } = await db
      .from("project_assignments")
      .select("user_id")
      .eq("project_id", p.id);
    setAssigned(new Set((asgn ?? []).map((a: { user_id: string }) => a.user_id)));
    setAssignOpen(true);
  };

  const toggleAssign = async (uid: string) => {
    if (!assignProject) return;
    const has = assigned.has(uid);
    if (has) {
      const { error } = await db
        .from("project_assignments")
        .delete()
        .eq("project_id", assignProject.id)
        .eq("user_id", uid);
      if (error) return toast.error(error.message);
      setAssigned((prev) => {
        const next = new Set(prev);
        next.delete(uid);
        return next;
      });
    } else {
      const { error } = await db
        .from("project_assignments")
        .insert({ project_id: assignProject.id, user_id: uid });
      if (error) return toast.error(error.message);
      setAssigned((prev) => new Set(prev).add(uid));
    }
  };

  const assignAll = async () => {
    if (!assignProject) return;
    const toAdd = students.filter((s) => !assigned.has(s.id));
    if (!toAdd.length) return;
    const rows = toAdd.map((s) => ({ project_id: assignProject.id, user_id: s.id }));
    const { error } = await db.from("project_assignments").insert(rows);
    if (error) return toast.error(error.message);
    setAssigned(new Set(students.map((s) => s.id)));
    toast.success(`${toAdd.length} estudiantes asignados`);
  };

  const unassignAll = async () => {
    if (!assignProject) return;
    const { error } = await db
      .from("project_assignments")
      .delete()
      .eq("project_id", assignProject.id);
    if (error) return toast.error(error.message);
    setAssigned(new Set());
    toast.success("Asignaciones eliminadas");
  };

  const courseLanguage = (filesProject?.course?.language === "en" ? "en" : "es") as "es" | "en";

  if (!isTeacher) return <p className="text-muted-foreground">{t("exam.needsTeacherRole")}</p>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Proyectos</h1>
          <p className="text-sm text-muted-foreground">{projects.length} proyectos</p>
        </div>
        <Button onClick={openNew}>
          <Plus className="h-4 w-4 mr-1" /> Nuevo proyecto
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Título</TableHead>
                <TableHead>Curso</TableHead>
                <TableHead>Corte</TableHead>
                <TableHead>Archivos</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Entrega</TableHead>
                <TableHead className="text-right">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.title}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <div className="flex flex-wrap gap-1 items-center">
                      {(p.linked_course_ids ?? [p.course_id]).map((cid) => {
                        const c = courses.find((cc) => cc.id === cid);
                        if (!c) return null;
                        const isPrimary = cid === p.course_id;
                        return (
                          <Badge
                            key={cid}
                            variant={isPrimary ? "default" : "outline"}
                            className="text-[10px]"
                          >
                            {c.name}
                            {c.period ? ` · ${c.period}` : ""}
                          </Badge>
                        );
                      })}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {cuts.find((c) => c.id === p.cut_id)?.name ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      <FileText className="h-3 w-3 mr-1" />
                      {p.max_files}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={p.status === "published" ? "default" : "secondary"}
                      className="text-[10px] capitalize"
                    >
                      {p.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {p.due_date ? new Date(p.due_date).toLocaleString() : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-0.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Archivos esperados"
                        onClick={() => openFilesDialog(p)}
                      >
                        <FileText className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Asignar estudiantes"
                        onClick={() => openAssignDialog(p)}
                      >
                        <Users className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title={t("common.edit")}
                        onClick={() => openEdit(p)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title={t("common.delete")}
                        onClick={() => remove(p)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {projects.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    {t("common.empty")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* New / edit project dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Editar proyecto" : "Nuevo proyecto"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label required>Título</Label>
              <Input
                required
                value={form.title ?? ""}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div>
              <Label>{t("common.description")}</Label>
              <Textarea
                rows={2}
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
            <div className="space-y-2">
              <Label>{t("nav.courses")} (puedes seleccionar varios)</Label>
              <div className="border rounded-md p-2 max-h-44 overflow-y-auto space-y-1">
                {courses.length === 0 && (
                  <p className="text-xs text-muted-foreground">Sin cursos disponibles</p>
                )}
                {courses.map((c) => {
                  const checked = (form.linked_course_ids ?? []).includes(c.id);
                  const isPrimary = form.course_id === c.id;
                  return (
                    <label
                      key={c.id}
                      className="flex items-center gap-2 p-1.5 rounded hover:bg-muted/50 text-sm cursor-pointer"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleFormCourse(c.id)}
                      />
                      <span className="flex-1">
                        {c.name}
                        {c.period ? ` · ${c.period}` : ""}
                      </span>
                      {isPrimary && checked && (
                        <Badge variant="default" className="text-[9px]">
                          Primario
                        </Badge>
                      )}
                      {checked && !isPrimary && (
                        <button
                          type="button"
                          className="text-[10px] text-muted-foreground hover:text-foreground underline"
                          onClick={(e) => {
                            e.preventDefault();
                            setForm({ ...form, course_id: c.id, cut_id: null });
                          }}
                        >
                          Hacer primario
                        </button>
                      )}
                    </label>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">
                El curso primario define el corte y el idioma usado por la IA. Los estudiantes
                matriculados en cualquiera de los cursos seleccionados verán el proyecto.
              </p>
            </div>
            <div>
              <Label>Corte</Label>
              <Select
                value={form.cut_id ?? "__none"}
                onValueChange={(v) => setForm({ ...form, cut_id: v === "__none" ? null : v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">{t("common.none")}</SelectItem>
                  {cuts
                    .filter((c) => c.course_id === form.course_id)
                    .map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Número de archivos</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={form.max_files ?? 3}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      max_files: e.target.value === "" ? 1 : Number(e.target.value),
                    })
                  }
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Cuántas cajas de texto se mostrarán al estudiante (una por archivo). La IA
                  calificará cada caja por separado.
                </p>
              </div>
              <div>
                <Label>Puntaje máximo</Label>
                <Input
                  type="number"
                  min={1}
                  value={form.max_score ?? 100}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      max_score: e.target.value === "" ? 0 : Number(e.target.value),
                    })
                  }
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t("common.startDate")}</Label>
                <DateTimePicker
                  value={form.start_date ? toLocal(form.start_date) : ""}
                  onChange={(v) => setForm({ ...form, start_date: v })}
                />
              </div>
              <div>
                <Label required>{t("common.endDate")}</Label>
                <DateTimePicker
                  required
                  value={form.due_date ? toLocal(form.due_date) : ""}
                  onChange={(v) => setForm({ ...form, due_date: v })}
                />
              </div>
            </div>
            <div>
              <Label>Estado</Label>
              <Select
                value={form.status ?? "draft"}
                onValueChange={(v) => setForm({ ...form, status: v as Project["status"] })}
              >
                <SelectTrigger>
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={save}>{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Files (slots) editor */}
      <Dialog open={filesOpen} onOpenChange={setFilesOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Archivos esperados — {filesProject?.title}</DialogTitle>
          </DialogHeader>
          {filesProject && (
            <TeacherProjectFilesEditor
              projectId={filesProject.id}
              courseLanguage={courseLanguage}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Assignment dialog */}
      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Asignar — {assignProject?.title}</DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs text-muted-foreground">
              {assigned.size} de {students.length} asignados
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={assignAll}>
                {t("common.selectAll")}
              </Button>
              <Button size="sm" variant="outline" onClick={unassignAll}>
                {t("common.deselectAll")}
              </Button>
            </div>
          </div>
          <div className="space-y-1.5 max-h-80 overflow-y-auto">
            {students.length === 0 && (
              <p className="text-sm text-muted-foreground p-4 text-center">
                <Loader2 className="inline h-3 w-3 animate-spin mr-1" /> Sin estudiantes
                matriculados.
              </p>
            )}
            {students.map((s) => (
              <label
                key={s.id}
                className="flex items-center gap-2 p-2 rounded-md hover:bg-muted/50 text-sm cursor-pointer"
              >
                <Checkbox
                  checked={assigned.has(s.id)}
                  onCheckedChange={() => toggleAssign(s.id)}
                />
                <span className="flex-1">{s.full_name}</span>
                <span className="text-xs text-muted-foreground">{s.institutional_email}</span>
              </label>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function toLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
