import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DateTimePicker } from "@/components/ui/date-picker";
import { useDirtyDialog } from "@/hooks/use-dirty-dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
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
import { toast } from "sonner";
import { Plus, Pencil, GitBranch, Monitor, Copy, Trash2, FileText } from "lucide-react";
import { RowAction } from "@/components/ui/row-action";
import { TableEmpty } from "@/components/ui/empty-state";
import { formatDateTime, formatDuration } from "@/lib/format";
import { ImportExportMenu } from "@/components/ImportExportMenu";
import { toCSV } from "@/lib/csv";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  useMultiSelect,
  MultiSelectHeaderCheckbox,
  MultiSelectCheckbox,
  MultiSelectToolbar,
  BulkDeleteDialog,
} from "@/components/ui/multi-select";
import { ListFilters } from "@/components/ui/list-filters";

const EXAMS_TEMPLATE = `course_name,title,description,start_time,end_time,time_limit_minutes,navigation_type,shuffle_enabled
Programación I,Parcial 1,Examen del primer corte,2025-09-15T08:00,2025-09-15T10:00,90,libre,false
Programación I,Quiz 1,Quiz corto sobre listas,2025-09-22T08:00,2025-09-22T08:30,30,secuencial,true`;

export const Route = createFileRoute("/app/teacher/exams/")({ component: TeacherExams });

type Course = { id: string; name: string; period: string | null };
type Cut = { id: string; course_id: string; name: string };
type Exam = {
  id: string;
  course_id: string;
  cut_id: string | null;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
  time_limit_minutes: number;
  navigation_type: string;
  shuffle_enabled: boolean;
  parent_exam_id: string | null;
  schedule_type?: string | null;
  course?: { name: string; period: string | null };
};

function TeacherExams() {
  const { user, roles } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [courses, setCourses] = useState<Course[]>([]);
  const [exams, setExams] = useState<Exam[]>([]);
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Partial<Exam>>({});
  const examDirty = useDirtyDialog(open, form);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [courseFilter, setCourseFilter] = useState<string | null>(null);
  // Filtra exámenes por título y curso. Se aplica también al
  // multi-select para que el "seleccionar todo" abarque solo lo visible.
  const filteredExams = useMemo(() => {
    const q = search.trim().toLowerCase();
    return exams.filter((e) => {
      if (courseFilter && e.course_id !== courseFilter) return false;
      if (q && !e.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [exams, search, courseFilter]);
  const sel = useMultiSelect(filteredExams);

  const handleBulkDelete = async (ids: string[]) => {
    const { error } = await supabase.from("exams").delete().in("id", ids);
    if (error) throw new Error(error.message);
    toast.success(`${ids.length} examen(es) eliminado(s) correctamente`);
    sel.clear();
    load();
  };

  const selectedExamItems = useMemo(
    () =>
      filteredExams
        .filter((e) => sel.isSelected(e.id))
        .map((e) => ({
          id: e.id,
          label: `${e.title}${e.course?.name ? ` — ${e.course.name}` : ""}`,
        })),
    [filteredExams, sel],
  );
  const [selectedCourseIds, setSelectedCourseIds] = useState<Set<string>>(new Set());
  const isTeacher = roles.includes("Docente") || roles.includes("Admin");
  const confirm = useConfirm();

  const remove = async (exam: Exam) => {
    const ok = await confirm({
      title: t("exam.deleteTitle", { defaultValue: "Eliminar examen" }),
      description: t("exam.deleteDesc", {
        defaultValue:
          'Se eliminarán las preguntas, asignaciones y entregas asociadas al examen "{{title}}". Esta acción no se puede deshacer.',
        title: exam.title,
      }),
      confirmLabel: t("common.delete", { defaultValue: "Eliminar" }),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("exams").delete().eq("id", exam.id);
    if (error) return toast.error(error.message);
    toast.success(t("exam.deleted", { defaultValue: "Examen eliminado" }));
    load();
  };

  /** Asigna un examen a todos los estudiantes matriculados en el curso. */
  const autoAssignExam = async (examId: string, courseId: string) => {
    const { data: enr } = await supabase
      .from("course_enrollments")
      .select("user_id")
      .eq("course_id", courseId);
    if (!enr?.length) return;
    const { data: existing } = await supabase
      .from("exam_assignments")
      .select("user_id")
      .eq("exam_id", examId);
    const existingSet = new Set((existing ?? []).map((e: any) => e.user_id));
    const toAdd = (enr as any[]).filter((e) => !existingSet.has(e.user_id));
    if (toAdd.length) {
      await supabase
        .from("exam_assignments")
        .insert(toAdd.map((e: any) => ({ exam_id: examId, user_id: e.user_id })));
    }
  };

  const duplicate = async (exam: Exam) => {
    if (!user) return;
    const { course, id: _id, ...rest } = exam as any;
    const newTitle = `Copia de ${exam.title}`;
    const { data: newExam, error } = await supabase
      .from("exams")
      .insert({
        ...rest,
        title: newTitle,
        created_by: user.id,
        parent_exam_id: null,
      })
      .select()
      .single();
    if (error) return toast.error(error.message);
    // Copiar preguntas
    const { data: qs } = await supabase
      .from("questions")
      .select("*")
      .eq("exam_id", exam.id)
      .order("position");
    if (qs?.length) {
      const rows = (qs as any[]).map(({ id, exam_id, created_at, ...q }) => ({
        ...q,
        exam_id: newExam.id,
      }));
      await supabase.from("questions").insert(rows);
    }
    toast.success("Examen duplicado correctamente");
    load();
  };

  const load = async () => {
    const [{ data: cs }, { data: es }, { data: cs2 }] = await Promise.all([
      supabase.from("courses").select("id, name, period").order("name"),
      supabase
        .from("exams")
        .select("*, course:courses(name, period)")
        .order("start_time", { ascending: false }),
      (supabase as any).from("grade_cuts").select("id, course_id, name").order("position"),
    ]);
    setCourses((cs ?? []) as Course[]);
    setExams((es ?? []) as any);
    setCuts((cs2 ?? []) as Cut[]);
  };
  useEffect(() => {
    load();
  }, []);

  const openNew = () => {
    const now = new Date();
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    setForm({
      title: "",
      course_id: courses[0]?.id,
      cut_id: null,
      start_time: toLocal(now),
      end_time: toLocal(end),
      time_limit_minutes: 60,
      navigation_type: "libre",
      shuffle_enabled: false,
      parent_exam_id: null,
      schedule_type: "normal",
      retry_mode: "last",
      max_warnings: 3,
    } as any);
    setSelectedCourseIds(new Set(courses[0] ? [courses[0].id] : []));
    setOpen(true);
  };

  const toggleCourse = (id: string) => {
    setSelectedCourseIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // Keep form.course_id in sync with first selected
      const first = [...next][0];
      if (first) setForm((f) => ({ ...f, course_id: first }));
      return next;
    });
  };

  const save = async () => {
    if (!form.title || selectedCourseIds.size === 0 || !user) {
      toast.error(t("exam.completeFields"));
      return;
    }
    const isExternal = !!(form as any).is_external;
    if (isExternal && !form.start_time) {
      toast.error("Indica la fecha de la actividad");
      return;
    }
    const courseIds = [...selectedCourseIds];
    // Para externos: start/end son la fecha de la actividad (ventana de
    // 0s, así el examen no se puede tomar pero sigue siendo un row válido
    // al que el docente le carga notas manualmente). Los campos de
    // duración / navegación / proctoring / reintentos NO se incluyen en
    // el payload — los DEFAULT de la DB se encargan, y así nos blindamos
    // contra "Could not find the 'X' column in schema cache" si alguna
    // columna fue añadida por migración reciente.
    const startIso = new Date(form.start_time!).toISOString();
    const endIso = isExternal ? startIso : new Date(form.end_time!).toISOString();
    const basePayload: Record<string, any> = {
      title: form.title,
      description: form.description ?? null,
      start_time: startIso,
      end_time: endIso,
      parent_exam_id: form.parent_exam_id || null,
      created_by: user.id,
      cut_id: courseIds.length === 1 ? form.cut_id || null : null,
      is_external: isExternal,
    };
    if (!isExternal) {
      basePayload.time_limit_minutes = Number(form.time_limit_minutes) || 60;
      basePayload.navigation_type = form.navigation_type ?? "libre";
      basePayload.shuffle_enabled = !!form.shuffle_enabled;
      basePayload.schedule_type = ((form as any).schedule_type ?? "normal") as string;
      basePayload.retry_mode = ((form as any).retry_mode ?? "last") as string;
      basePayload.max_warnings = Math.max(
        1,
        Math.min(50, Number((form as any).max_warnings ?? 3) || 3),
      );
    }

    // Create one exam per selected course
    let firstId: string | null = null;
    for (const cid of courseIds) {
      const { data, error } = await supabase
        .from("exams")
        .insert({ ...basePayload, course_id: cid } as any)
        .select()
        .single();
      if (error) {
        toast.error(error.message);
        return;
      }
      if (!firstId) firstId = data.id;
      // Auto-asignar todos los estudiantes matriculados en el curso
      await autoAssignExam(data.id, cid);
      // Notificar a los estudiantes del curso. Para externos no aplica
      // (la actividad ya pasó, solo se registra la nota).
      if (!isExternal) {
        await supabase.rpc("notify_course_students", {
          _course_id: cid,
          _title: "Nuevo examen disponible",
          _body: `Se ha publicado el examen "${form.title}"`,
          _kind: "exam",
          _link: "/app/student/exams",
        });
      }
    }

    toast.success(
      courseIds.length > 1
        ? t("exam.createdIn", { count: courseIds.length })
        : t("exam.createdOne"),
    );
    setOpen(false);
    if (firstId) navigate({ to: "/app/teacher/exams/$examId", params: { examId: firstId } });
  };

  if (!isTeacher) return <p className="text-muted-foreground">{t("exam.needsTeacherRole")}</p>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("exam.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {filteredExams.length === exams.length
              ? t("exam.subtitle", { count: exams.length })
              : `${filteredExams.length} de ${exams.length}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ImportExportMenu
            label={t("exam.title")}
            resourceName="examenes"
            templateCsv={EXAMS_TEMPLATE}
            onExport={() => {
              if (!exams.length) return "";
              return toCSV(
                exams.map((e) => ({
                  course_name: e.course?.name ?? "",
                  title: e.title,
                  description: e.description ?? "",
                  start_time: e.start_time,
                  end_time: e.end_time,
                  time_limit_minutes: e.time_limit_minutes,
                  navigation_type: e.navigation_type,
                  shuffle_enabled: e.shuffle_enabled ? "true" : "false",
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
                if (!cid || !r.title || !r.start_time || !r.end_time) {
                  skipped++;
                  continue;
                }
                const { error } = await supabase.from("exams").insert({
                  course_id: cid,
                  title: r.title,
                  description: r.description || null,
                  start_time: new Date(r.start_time).toISOString(),
                  end_time: new Date(r.end_time).toISOString(),
                  time_limit_minutes: Number(r.time_limit_minutes) || 60,
                  navigation_type: r.navigation_type || "libre",
                  shuffle_enabled: String(r.shuffle_enabled).toLowerCase() === "true",
                  created_by: user.id,
                });
                if (error) skipped++;
                else created++;
              }
              await load();
              return t("import.imported", { created, skipped });
            }}
          />
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4 mr-1" />
            {t("exam.newExam")}
          </Button>
        </div>
      </div>

      <ListFilters
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar examen por título…"
        courseId={courseFilter}
        onCourseChange={setCourseFilter}
        courses={courses}
      />

      <MultiSelectToolbar
        count={sel.count}
        onClear={sel.clear}
        onDelete={() => setBulkDeleteOpen(true)}
        entityNameSingular="examen"
        entityNamePlural="exámenes"
      />

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <MultiSelectHeaderCheckbox state={sel} />
                </TableHead>
                <TableHead>{t("exam.columns.title")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("exam.columns.course")}</TableHead>
                <TableHead className="hidden sm:table-cell">{t("exam.columns.start")}</TableHead>
                <TableHead className="hidden lg:table-cell">{t("exam.columns.duration")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("exam.columns.type")}</TableHead>
                <TableHead className="hidden lg:table-cell">
                  {t("exam.columns.navigation")}
                </TableHead>
                <TableHead className="text-right">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exams.length === 0 ? (
                <TableEmpty
                  colSpan={8}
                  icon={FileText}
                  text="Aún no has creado ningún examen."
                  hint="Diseña tu primer examen — puedes generar preguntas con IA."
                  action={
                    <Button size="sm" onClick={openNew}>
                      <Plus className="h-4 w-4 mr-1" />
                      Crear primer examen
                    </Button>
                  }
                />
              ) : filteredExams.length === 0 ? (
                <TableEmpty
                  colSpan={8}
                  icon={FileText}
                  text="Sin resultados para los filtros actuales."
                  hint="Limpia el buscador o el curso para ver todos los exámenes."
                />
              ) : null}
              {filteredExams.map((e) => (
                <TableRow key={e.id} data-state={sel.isSelected(e.id) ? "selected" : undefined}>
                  <TableCell className="w-10">
                    <MultiSelectCheckbox id={e.id} state={sel} />
                  </TableCell>
                  <TableCell className="font-medium">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span>{e.title}</span>
                        {e.parent_exam_id && (
                          <Badge variant="outline" className="text-[10px]">
                            <GitBranch className="h-3 w-3 mr-1" />
                            {t("exam.supletorio")}
                          </Badge>
                        )}
                      </div>
                      <div className="md:hidden text-xs text-muted-foreground truncate">
                        {e.course?.name}
                        {e.course?.period && (
                          <span className="ml-1.5 text-[10px]">({e.course.period})</span>
                        )}
                      </div>
                      <div className="sm:hidden text-[11px] text-muted-foreground tabular-nums">
                        {formatDateTime(e.start_time)} · {formatDuration(e.time_limit_minutes)}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell">
                    {e.course?.name}
                    {e.course?.period && (
                      <Badge variant="outline" className="ml-1.5 text-[9px]">
                        {e.course.period}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm hidden sm:table-cell tabular-nums">
                    {formatDateTime(e.start_time)}
                  </TableCell>
                  <TableCell className="text-sm hidden lg:table-cell tabular-nums">
                    {formatDuration(e.time_limit_minutes)}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {(e as any).is_external ? (
                      <Badge variant="outline" className="text-[10px]">
                        {t("exam.kindExternal")}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">
                        {t("exam.kindOnline")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <Badge variant="secondary" className="text-[10px]">
                      {e.navigation_type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-0.5">
                      <RowAction asChild label={t("exam.liveMonitor")} icon={Monitor}>
                        <Link to="/app/teacher/monitor/$examId" params={{ examId: e.id }} />
                      </RowAction>
                      <RowAction asChild label={t("common.edit")} icon={Pencil}>
                        <Link to="/app/teacher/exams/$examId" params={{ examId: e.id }} />
                      </RowAction>
                      <RowAction label="Duplicar" icon={Copy} onClick={() => duplicate(e)} />
                      <RowAction
                        label={t("common.delete", { defaultValue: "Eliminar" })}
                        icon={Trash2}
                        tone="destructive"
                        onClick={() => remove(e)}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={examDirty.guardOpenChange(setOpen)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("exam.newExam")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {/*
             * Toggle de actividad externa: cuando se activa, el examen
             * no es para tomarlo en línea — es solo registro de notas
             * de un parcial presencial. Escondemos los campos que no
             * aplican (duración, navegación, proctoring, padre) y la
             * fecha de fin (la actividad ya pasó, fecha = un instante).
             */}
            <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 p-2.5">
              <div className="space-y-0.5">
                <Label htmlFor="is-external" className="text-sm">
                  Actividad externa
                </Label>
                <p className="text-[11px] text-muted-foreground leading-tight">
                  Un parcial que ocurrió fuera de la plataforma — presencial o hecho en otra
                  herramienta. Solo registras notas para el cálculo del corte.
                </p>
              </div>
              <Switch
                id="is-external"
                checked={!!(form as any).is_external}
                onCheckedChange={(v) => setForm({ ...form, is_external: v } as any)}
              />
            </div>
            <div>
              <Label required>{t("common.title")}</Label>
              <Input
                value={form.title ?? ""}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div>
              <Label>{t("common.description")}</Label>
              <Textarea
                value={form.description ?? ""}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div>
              <Label required>
                {t("nav.courses")}{" "}
                <span className="text-xs text-muted-foreground font-normal">
                  {t("exam.selectCourses")}
                </span>
              </Label>
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
              {selectedCourseIds.size > 1 && (
                <p className="text-xs text-muted-foreground mt-1">{t("exam.coursesHelp")}</p>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label required>
                  {(form as any).is_external ? "Fecha del parcial" : t("common.start")}
                </Label>
                <DateTimePicker
                  value={form.start_time as string}
                  onChange={(start) => {
                    const startMs = new Date(start).getTime();
                    // Auto-set end to start + 1h if end is empty or not after start
                    const currentEnd = form.end_time ? new Date(form.end_time).getTime() : 0;
                    const autoEnd =
                      currentEnd > startMs
                        ? form.end_time
                        : toLocal(new Date(startMs + 60 * 60 * 1000));
                    const diffMin = Math.max(
                      1,
                      Math.round((new Date(autoEnd!).getTime() - startMs) / 60000),
                    );
                    setForm({
                      ...form,
                      start_time: start,
                      end_time: autoEnd,
                      time_limit_minutes: diffMin,
                    });
                  }}
                />
              </div>
              {!(form as any).is_external && (
                <div>
                  <Label required>{t("common.end")}</Label>
                  <DateTimePicker
                    value={form.end_time as string}
                    onChange={(end) => {
                      const diffMin = form.start_time
                        ? Math.max(
                            1,
                            Math.round(
                              (new Date(end).getTime() - new Date(form.start_time!).getTime()) /
                                60000,
                            ),
                          )
                        : form.time_limit_minutes;
                      setForm({ ...form, end_time: end, time_limit_minutes: diffMin });
                    }}
                  />
                </div>
              )}
            </div>
            {!(form as any).is_external && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label required>
                    {t("common.duration")} ({t("common.min")})
                  </Label>
                  <Input
                    type="number"
                    min={1}
                    value={form.time_limit_minutes || ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        time_limit_minutes:
                          e.target.value === "" ? 0 : Math.max(1, Number(e.target.value)),
                      })
                    }
                  />
                </div>
                <div>
                  <Label>{t("exam.navigation")}</Label>
                  <Select
                    value={form.navigation_type}
                    onValueChange={(v) => setForm({ ...form, navigation_type: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="libre">{t("exam.navigationFree")}</SelectItem>
                      <SelectItem value="secuencial">{t("exam.navigationSequential")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            {!(form as any).is_external && (
              <div>
                <Label>
                  Tipo de programación{" "}
                  <span className="text-xs text-muted-foreground font-normal">
                    (Normal: el cronómetro cuenta hasta la fecha de fin para todos. Relativo: cada
                    estudiante tiene la duración indicada desde que abre el examen, dentro de la
                    ventana.)
                  </span>
                </Label>
                <Select
                  value={(form as any).schedule_type ?? "normal"}
                  onValueChange={(v) => setForm({ ...form, schedule_type: v } as any)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">Normal (sincrónico)</SelectItem>
                    <SelectItem value="relativo">Relativo (por estudiante)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {!(form as any).is_external && (
              <div>
                <Label>
                  Modo de calificación con reintentos{" "}
                  <span className="text-xs text-muted-foreground font-normal">
                    (Aplica solo si se permite más de un intento.)
                  </span>
                </Label>
                <Select
                  value={(form as any).retry_mode ?? "last"}
                  onValueChange={(v) => setForm({ ...form, retry_mode: v } as any)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="last">Último intento</SelectItem>
                    <SelectItem value="average">Promedio</SelectItem>
                    <SelectItem value="highest">Más alto</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {!(form as any).is_external && (
              <div className="flex items-center justify-between">
                <Label>{t("exam.shuffle")}</Label>
                <Switch
                  checked={!!form.shuffle_enabled}
                  onCheckedChange={(v) => setForm({ ...form, shuffle_enabled: v })}
                />
              </div>
            )}
            {!(form as any).is_external && (
              <div>
                <Label>
                  Advertencias máximas{" "}
                  <span className="text-xs text-muted-foreground font-normal">
                    (cambiar pestaña, copiar/pegar, salir de pantalla completa, etc.)
                  </span>
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={(form as any).max_warnings ?? 3}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      max_warnings:
                        e.target.value === ""
                          ? 3
                          : Math.max(1, Math.min(50, Number(e.target.value))),
                    } as any)
                  }
                />
              </div>
            )}
            <div>
              <Label>
                Corte de evaluación{" "}
                <span className="text-xs text-muted-foreground font-normal">(opcional)</span>
              </Label>
              {(() => {
                const single = selectedCourseIds.size === 1;
                const targetCourseId = [...selectedCourseIds][0];
                const availableCuts = single
                  ? cuts.filter((c) => c.course_id === targetCourseId)
                  : [];
                return (
                  <Select
                    value={form.cut_id ?? "__none__"}
                    onValueChange={(v) => setForm({ ...form, cut_id: v === "__none__" ? null : v })}
                    disabled={!single}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Sin corte asignado" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Sin corte asignado</SelectItem>
                      {availableCuts.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                );
              })()}
              {selectedCourseIds.size > 1 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Selecciona un único curso para asignar un corte.
                </p>
              )}
            </div>
            {!(form as any).is_external && (
              <div>
                <Label>{t("exam.parentExam")}</Label>
                <Select
                  value={form.parent_exam_id ?? "none"}
                  onValueChange={(v) =>
                    setForm({ ...form, parent_exam_id: v === "none" ? null : v })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("exam.originalExam")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("common.none")}</SelectItem>
                    {exams
                      .filter((e) => !e.parent_exam_id && e.course_id === form.course_id)
                      .map((e) => (
                        <SelectItem key={e.id} value={e.id}>
                          {e.title}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={save}>{t("common.create")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BulkDeleteDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        items={selectedExamItems}
        entityNameSingular="examen"
        entityNamePlural="exámenes"
        extraWarning="Se eliminarán también todas las preguntas, asignaciones y entregas de los exámenes seleccionados."
        onConfirm={handleBulkDelete}
      />
    </div>
  );
}

function toLocal(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
