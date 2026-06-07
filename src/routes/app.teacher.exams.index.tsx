import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { friendlyError, friendlyUniqueViolation } from "@/shared/lib/db-errors";
import { supabase } from "@/integrations/supabase/client";
import { softDelete, softDeleteMany } from "@/modules/trash/soft-delete";
import { useAuth } from "@/hooks/use-auth";
import { logEvent } from "@/shared/lib/audit";
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
import {
  Plus,
  Pencil,
  GitBranch,
  Monitor,
  Copy,
  Trash2,
  FileText,
  CheckCircle2,
  Lock,
  ExternalLink,
} from "lucide-react";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { DuplicateAssessmentDialog } from "@/shared/components/DuplicateAssessmentDialog";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { DateCell } from "@/components/ui/date-cell";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";
import { formatDateTime, formatDuration, formatPercent } from "@/shared/lib/format";
import { ImportExportMenu } from "@/shared/components/ImportExportMenu";
import { toCSV } from "@/shared/lib/csv";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import {
  useMultiSelect,
  MultiSelectHeaderCheckbox,
  MultiSelectCheckbox,
  MultiSelectToolbar,
  BulkDeleteDialog,
} from "@/components/ui/multi-select";
import { ListFilters } from "@/components/ui/list-filters";
import { StatCard } from "@/components/ui/stat-card";
import { CourseListCell } from "@/components/ui/course-list-cell";
import { HelpHint } from "@/components/ui/help-hint";
import { DecimalInput } from "@/components/ui/decimal-input";
import { StatusBadge } from "@/components/ui/status-badge";

const EXAMS_TEMPLATE = `course_name,title,description,start_time,end_time,time_limit_minutes,navigation_type,shuffle_enabled
Programación I,Parcial 1,Examen del primer corte,2025-09-15T08:00,2025-09-15T10:00,90,libre,false
Programación I,Quiz 1,Quiz corto sobre listas,2025-09-22T08:00,2025-09-22T08:30,30,secuencial,true`;

export const Route = createFileRoute("/app/teacher/exams/")({ component: TeacherExams });

type Course = { id: string; name: string; period: string | null };
type Cut = { id: string; course_id: string; name: string; exam_weight?: number };
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
  weight?: number | null;
  /** Estado manual (draft|published|closed). Default published si la
   *  columna llega undefined (migración 20260603120000 pendiente). */
  status?: string | null;
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
  const [cutFilter, setCutFilter] = useState<string | null>(null);
  // Filtra exámenes por título, curso y corte. Se aplica también al
  // multi-select para que el "seleccionar todo" abarque solo lo visible.
  const filteredExams = useMemo(() => {
    const q = search.trim().toLowerCase();
    return exams.filter((e) => {
      if (courseFilter && e.course_id !== courseFilter) return false;
      if (cutFilter && e.cut_id !== cutFilter) return false;
      if (q && !e.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [exams, search, courseFilter, cutFilter]);

  // Quick-stats estables del listado completo (no se mueven al filtrar).
  // Cuatro tiles: borradores, publicados, cerrados, externos. Igual que
  // en talleres y proyectos — pulso rápido del estado del catálogo.
  const examStats = useMemo(() => {
    let draft = 0,
      published = 0,
      closed = 0,
      external = 0;
    for (const e of exams) {
      if ((e as any).is_external) external++;
      const s = (e as any).status ?? "published";
      if (s === "draft") draft++;
      else if (s === "published") published++;
      else if (s === "closed") closed++;
    }
    return { draft, published, closed, external };
  }, [exams]);

  const sel = useMultiSelect(filteredExams);

  // Paginación client-side sobre la lista filtrada. El multi-select
  // sigue trabajando sobre `filteredExams` (todas las páginas) para
  // que "seleccionar todos" abarque las coincidencias del filtro y no
  // solo la página visible. resetKey vuelve a la página 1 al cambiar
  // search/curso/corte.
  const pagination = usePagination(filteredExams, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:teacher_exams",
    resetKey: `${search}|${courseFilter ?? ""}|${cutFilter ?? ""}`,
  });

  const handleBulkDelete = async (ids: string[]) => {
    // Soft-delete: la fila queda invisible para las queries (filtran
    // is('deleted_at', null)) pero recuperable desde /app/trash hasta
    // que el cron de purga (30 días) la borre físicamente.
    const { error } = await softDeleteMany("exams", ids);
    if (error) throw new Error(error.message);
    toast.success(`${ids.length} examen(es) enviado(s) a papelera`);
    void logEvent({
      action: "exam.deleted",
      category: "exam",
      actorRole: roles[0],
      metadata: { count: ids.length, ids },
    });
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
  // Per-course cut+weight used only during multi-course creation.
  const [courseCuts, setCourseCuts] = useState<
    Record<string, { cut_id: string | null; weight: number }>
  >({});
  const isTeacher = roles.includes("Docente") || roles.includes("Admin");
  const confirm = useConfirm();

  const remove = async (exam: Exam) => {
    const ok = await confirm({
      title: t("exam.deleteTitle", { defaultValue: "Enviar a papelera" }),
      description: t("exam.deleteDesc", {
        defaultValue:
          'El examen "{{title}}" se ocultará de la lista pero quedará en papelera por 30 días por si querés restaurarlo. Las preguntas, asignaciones y entregas no se borran todavía.',
        title: exam.title,
      }),
      confirmLabel: t("common.delete", { defaultValue: "Enviar a papelera" }),
      tone: "warning",
    });
    if (!ok) return;
    const { error } = await softDelete("exams", exam.id);
    if (error) return toast.error(friendlyUniqueViolation(error) ?? error.message);
    toast.success(t("exam.deleted", { defaultValue: "Examen enviado a papelera" }));
    void logEvent({
      action: "exam.deleted",
      category: "exam",
      actorRole: roles[0],
      entityType: "exam",
      entityId: exam.id,
      entityName: exam.title,
      courseId: exam.course_id,
      courseName: courses.find((c) => c.id === exam.course_id)?.name,
    });
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

  // Estado del dialog de duplicar. Abre `DuplicateAssessmentDialog`
  // que permite elegir curso destino + título + llama RPC clone_exam
  // (con validación de permisos sobre origen y destino).
  const [duplicateSource, setDuplicateSource] = useState<{
    id: string;
    title: string;
    courseId: string;
  } | null>(null);
  const openDuplicate = (exam: Exam) => {
    setDuplicateSource({ id: exam.id, title: exam.title, courseId: exam.course_id });
  };

  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const load = async () => {
    const [{ data: cs, error: csErr }, { data: es, error: esErr }, { data: cs2 }] =
      await Promise.all([
        supabase
          .from("courses")
          .select("id, name, period")
          // Ocultar cursos en papelera del selector de filtro.
          .is("deleted_at", null)
          .order("name"),
        supabase
          .from("exams")
          .select("*, course:courses(name, period)")
          // Ocultar exámenes en papelera de la lista del docente.
          .is("deleted_at", null)
          .order("start_time", { ascending: false }),
        (supabase as any)
          .from("grade_cuts")
          .select("id, course_id, name, exam_weight")
          .order("position"),
      ]);
    if (csErr || esErr) {
      setLoadError(friendlyError(csErr ?? esErr, "No pudimos cargar los exámenes."));
      return;
    }
    setLoadError(null);
    setCourses((cs ?? []) as Course[]);
    setExams((es ?? []) as any);
    setCuts((cs2 ?? []) as Cut[]);
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  // Cap dinámico del peso del examen para validación single-curso.
  const examWeightMax = useMemo(() => {
    if (selectedCourseIds.size !== 1 || !form.cut_id) return null;
    const cut = cuts.find((c) => c.id === form.cut_id);
    if (!cut) return null;
    const bucket = Number(cut.exam_weight ?? 0);
    const sumOthers = exams
      .filter((e) => e.cut_id === form.cut_id && !e.parent_exam_id)
      .reduce((s, e) => s + Number(e.weight ?? 0), 0);
    return Math.max(0, bucket - sumOthers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.cut_id, selectedCourseIds.size, cuts, exams]);

  const openNew = () => {
    const now = new Date();
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const first = courses[0]?.id;
    setForm({
      title: "",
      course_id: first,
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
      status: "draft",
    } as any);
    setSelectedCourseIds(new Set(first ? [first] : []));
    setCourseCuts(first ? { [first]: { cut_id: null, weight: 1 } } : {});
    setOpen(true);
  };

  const toggleCourse = (id: string) => {
    setSelectedCourseIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      const arr = [...next];
      const first = arr[0];
      setForm((f) => {
        const single = arr.length === 1;
        const validCut =
          single && f.cut_id ? cuts.some((c) => c.id === f.cut_id && c.course_id === first) : false;
        return {
          ...f,
          course_id: first ?? f.course_id,
          cut_id: validCut ? f.cut_id : null,
        };
      });
      setCourseCuts((prevCuts) => {
        const updated: Record<string, { cut_id: string | null; weight: number }> = {};
        for (const cid of next) {
          updated[cid] = prevCuts[cid] ?? { cut_id: null, weight: 1 };
        }
        return updated;
      });
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
    const isMultiCourse = courseIds.length > 1;
    const basePayload: Record<string, any> = {
      title: form.title,
      description: form.description ?? null,
      start_time: startIso,
      end_time: endIso,
      parent_exam_id: form.parent_exam_id || null,
      created_by: user.id,
      // Multi-course: cut_id+weight are set per-course in the loop.
      cut_id: isMultiCourse ? null : form.cut_id || null,
      is_external: isExternal,
      status: ((form as any).status ?? "published") as string,
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
    // Single-course weight validation
    if (!isMultiCourse && form.cut_id && (form as any).weight != null) {
      const requested = Math.max(0, Number((form as any).weight));
      const cap = examWeightMax ?? 0;
      if (requested > cap + 0.01) {
        toast.error(
          `El peso del examen (${requested}%) supera el bucket disponible del corte ` +
            `(${cap.toFixed(2)}% restantes). Reduce el peso o ajusta los demás exámenes del corte.`,
        );
        return;
      }
      basePayload.weight = requested;
    }
    // Multi-course weight validation per course
    if (isMultiCourse) {
      for (const cid of courseIds) {
        const cc = courseCuts[cid];
        if (!cc?.cut_id) continue;
        const requested = Math.max(0, Number(cc.weight ?? 1));
        const cut = cuts.find((c) => c.id === cc.cut_id);
        const bucket = Number(cut?.exam_weight ?? 0);
        const sumOthers = exams
          .filter((e) => e.cut_id === cc.cut_id && !e.parent_exam_id)
          .reduce((s, e) => s + Number(e.weight ?? 0), 0);
        const available = Math.max(0, bucket - sumOthers);
        if (requested > available + 0.01) {
          const cName = courses.find((c) => c.id === cid)?.name ?? cid;
          toast.error(
            `${cName}: El peso del examen (${requested}%) supera el bucket disponible del corte ` +
              `(${available.toFixed(2)}% restantes). Reduce el peso o ajusta los demás exámenes del corte.`,
          );
          return;
        }
      }
    }

    // Create one exam per selected course
    let firstId: string | null = null;
    for (const cid of courseIds) {
      const perCourse: Record<string, any> = { ...basePayload, course_id: cid };
      if (isMultiCourse) {
        const cc = courseCuts[cid];
        perCourse.cut_id = cc?.cut_id || null;
        if (cc?.cut_id && cc?.weight != null) {
          perCourse.weight = Math.max(0, Number(cc.weight));
        }
      }
      const { data, error } = await supabase
        .from("exams")
        .insert(perCourse as any)
        .select()
        .single();
      if (error) {
        toast.error(friendlyUniqueViolation(error) ?? error.message);
        return;
      }
      if (!firstId) firstId = data.id;
      // Auto-asignar todos los estudiantes matriculados en el curso
      await autoAssignExam(data.id, cid);
      // Notificar a los estudiantes del curso. NO aplica para externos
      // (la actividad ya pasó, solo se registra la nota) ni para draft
      // (el examen aún no es visible, mandar push sería confuso).
      const initialStatus = (basePayload.status as string) ?? "published";
      if (!isExternal && initialStatus === "published") {
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
    for (const cid of courseIds) {
      void logEvent({
        action: "exam.created",
        category: "exam",
        actorRole: roles[0],
        entityType: "exam",
        entityId: firstId ?? undefined,
        entityName: form.title,
        courseId: cid,
        courseName: courses.find((c) => c.id === cid)?.name,
        metadata: { is_external: !!(form as any).is_external },
      });
    }
    setOpen(false);
    if (firstId) navigate({ to: "/app/teacher/exams/$examId", params: { examId: firstId } });
  };

  if (!isTeacher) return <p className="text-muted-foreground">{t("exam.needsTeacherRole")}</p>;

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader icon={<FileText className="h-6 w-6" />} title={t("exam.title")} />
        <ErrorState
          message="No pudimos cargar los exámenes"
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<FileText className="h-6 w-6" />}
        title={t("exam.title")}
        subtitle={
          filteredExams.length === exams.length
            ? t("exam.subtitle", { count: exams.length })
            : `${filteredExams.length} de ${exams.length}`
        }
        actions={
          <>
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
                const courseByName = new Map(
                  courses.map((c) => [c.name.toLowerCase().trim(), c.id]),
                );
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
            <Button size="sm" onClick={openNew} data-tour-id="create-exam">
              <Plus className="h-4 w-4 mr-1" />
              {t("exam.newExam")}
            </Button>
          </>
        }
      />

      {/* Stats 4-card — siempre visible, mismo patrón que el resto. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={Pencil} label="Borradores" value={examStats.draft} />
        <StatCard
          icon={CheckCircle2}
          label="Publicados"
          value={examStats.published}
          tone={examStats.published > 0 ? "success" : "default"}
        />
        <StatCard icon={Lock} label="Cerrados" value={examStats.closed} />
        <StatCard icon={ExternalLink} label="Externos" value={examStats.external} />
      </div>

      <ListFilters
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar examen por título…"
        courseId={courseFilter}
        onCourseChange={(v) => {
          setCourseFilter(v);
          setCutFilter(null);
        }}
        courses={courses}
        cuts={cuts}
        cutId={cutFilter}
        onCutChange={setCutFilter}
      />

      <MultiSelectToolbar
        count={sel.count}
        onClear={sel.clear}
        onDelete={() => setBulkDeleteOpen(true)}
        entityNameSingular="examen"
        entityNamePlural="exámenes"
      />

      {/* Resumen de pesos cuando se filtra por corte: cuánto suman los
          exámenes del corte vs el bucket exam_weight. Excluye supletorios
          (parent_exam_id != null) — solo el examen original aporta peso. */}
      {cutFilter &&
        (() => {
          const cut = cuts.find((c) => c.id === cutFilter);
          if (!cut) return null;
          const sum = filteredExams
            .filter((e) => !e.parent_exam_id)
            .reduce((s, e) => s + Number(e.weight ?? 0), 0);
          const bucket = Number(cut.exam_weight ?? 0);
          const ok = Math.abs(sum - bucket) < 0.01;
          return (
            <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                Suma de pesos en <span className="font-medium text-foreground">{cut.name}</span>:
              </span>
              <Badge
                variant={ok ? "secondary" : sum > bucket + 0.01 ? "destructive" : "default"}
                className="tabular-nums"
              >
                {formatPercent(sum)}% / {formatPercent(bucket)}%
              </Badge>
              {!ok && sum < bucket - 0.01 && (
                <span className="text-muted-foreground">
                  Quedan <strong>{formatPercent(bucket - sum)}%</strong> sin asignar.
                </span>
              )}
              {sum > bucket + 0.01 && (
                <span className="text-destructive">
                  Sobrepasa el bucket por <strong>{formatPercent(sum - bucket)}%</strong>.
                </span>
              )}
            </div>
          );
        })()}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {/* table-fixed: anchos por columna respetados; títulos largos
              truncan en cada cell (ver wrapper truncate más abajo). */}
          <Table fixed resizable>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <MultiSelectHeaderCheckbox state={sel} />
                </TableHead>
                <TableHead className="w-48 max-w-[320px]">{t("exam.columns.title")}</TableHead>
                <TableHead className="hidden md:table-cell w-32">
                  {t("exam.columns.course")}
                </TableHead>
                <TableHead className="hidden md:table-cell w-24">{t("exam.columns.cut")}</TableHead>
                <TableHead className="text-right hidden md:table-cell w-16">Peso</TableHead>
                <TableHead className="hidden sm:table-cell w-28">
                  {t("exam.columns.start")}
                </TableHead>
                <TableHead className="hidden sm:table-cell w-28">{t("exam.columns.end")}</TableHead>
                <TableHead className="hidden lg:table-cell w-24">
                  {t("exam.columns.duration")}
                </TableHead>
                <TableHead className="hidden md:table-cell w-24">
                  {t("exam.columns.type")}
                </TableHead>
                <TableHead className="w-24">Estado</TableHead>
                <TableHead className="hidden lg:table-cell w-28">
                  {t("exam.columns.navigation")}
                </TableHead>
                <TableHead className="text-right w-20">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exams.length === 0 ? (
                <TableEmpty
                  colSpan={12}
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
                  colSpan={12}
                  icon={FileText}
                  text="Sin resultados para los filtros actuales."
                  hint="Limpia el buscador o el curso para ver todos los exámenes."
                />
              ) : null}
              {pagination.paginatedItems.map((e) => (
                <TableRow key={e.id} data-state={sel.isSelected(e.id) ? "selected" : undefined}>
                  <TableCell className="w-10">
                    <MultiSelectCheckbox id={e.id} state={sel} />
                  </TableCell>
                  <TableCell className="font-medium">
                    <div className="flex flex-col gap-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                        <span className="truncate" title={e.title}>
                          {e.title}
                        </span>
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
                    {e.course ? (
                      <CourseListCell
                        courses={[
                          {
                            id: e.course_id,
                            name: e.course.name,
                            period: e.course.period,
                          },
                        ]}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs hidden md:table-cell">
                    {cuts.find((c) => c.id === e.cut_id)?.name ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums text-right hidden md:table-cell">
                    {e.cut_id != null && e.weight != null
                      ? `${formatPercent(Number(e.weight))}%`
                      : "—"}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <DateCell value={e.start_time} variant="datetime" />
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {(() => {
                      // Fin = inicio + duración. Para sync con end_time
                      // explícito tomamos el menor (la ventana puede
                      // cerrar antes que el time_limit del intento).
                      const start = new Date(e.start_time).getTime();
                      const limit = Number(e.time_limit_minutes ?? 0) * 60_000;
                      const fromLimit = start + limit;
                      const explicit = (e as any).end_time
                        ? new Date((e as any).end_time).getTime()
                        : null;
                      const end = explicit ? Math.min(explicit, fromLimit) : fromLimit;
                      return <DateCell value={new Date(end)} variant="datetime" />;
                    })()}
                  </TableCell>
                  <TableCell
                    className="text-sm hidden lg:table-cell tabular-nums whitespace-nowrap"
                    truncate
                    title={formatDuration(e.time_limit_minutes)}
                  >
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
                  <TableCell>
                    <StatusBadge status={(e as any).status ?? "published"} />
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <Badge variant="secondary" className="text-[10px]">
                      {e.navigation_type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActionsMenu
                      actions={[
                        {
                          label: t("exam.liveMonitor"),
                          icon: Monitor,
                          to: "/app/teacher/monitor/$examId",
                          params: { examId: e.id },
                        },
                        {
                          label: t("common.edit"),
                          icon: Pencil,
                          to: "/app/teacher/exams/$examId",
                          params: { examId: e.id },
                        },
                        { label: "Duplicar", icon: Copy, onClick: () => openDuplicate(e) },
                        {
                          label: t("common.delete", { defaultValue: "Eliminar" }),
                          icon: Trash2,
                          tone: "destructive",
                          separatorBefore: true,
                          onClick: () => remove(e),
                        },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <DataPagination state={pagination} entityNamePlural="exámenes" />
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={examDirty.guardOpenChange(setOpen)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg" data-tour-id="dialog-exam">
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
            <div
              className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 p-2.5"
              data-tour-id="exam-field-external"
            >
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
            <div data-tour-id="exam-field-title">
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
              <Label>
                Estado{" "}
                <HelpHint>{t("help.examStatusHelp")}</HelpHint>
              </Label>
              <Select
                value={(form as any).status ?? "published"}
                onValueChange={(v) => setForm({ ...form, status: v } as any)}
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
            <div data-tour-id="exam-field-courses">
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-tour-id="exam-field-dates">
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
                  <HelpHint>
                    <strong>Normal:</strong> el cronómetro cuenta hasta la fecha de fin para todos.{" "}
                    <strong>Relativo:</strong> cada estudiante tiene la duración indicada desde que
                    abre el examen, dentro de la ventana.
                  </HelpHint>
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
                  <HelpHint>{t("help.examRetryModeHelp")}</HelpHint>
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
                  <HelpHint>{t("help.examMaxWarningsHelp")}</HelpHint>
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
            {/* Corte y peso: tabla per-curso si hay varios; selectores normales si uno solo */}
            {selectedCourseIds.size > 1 ? (
              <div className="space-y-2">
                <Label>
                  Corte y peso por curso{" "}
                  <HelpHint>{t("help.examCutWeightPerCourseHelp")}</HelpHint>
                </Label>
                {[...selectedCourseIds].map((cid) => {
                  const course = courses.find((c) => c.id === cid);
                  const cc = courseCuts[cid] ?? { cut_id: null, weight: 1 };
                  const cutsForCourse = cuts.filter((c) => c.course_id === cid);
                  const selectedCut = cc.cut_id ? cuts.find((c) => c.id === cc.cut_id) : null;
                  const exBucket = Number(selectedCut?.exam_weight ?? 0);
                  const sumOthers = exams
                    .filter((e) => e.cut_id === cc.cut_id && !e.parent_exam_id)
                    .reduce((s, e) => s + Number(e.weight ?? 0), 0);
                  const exMax = Math.max(0, exBucket - sumOthers);
                  const overBucket = !!cc.cut_id && Number(cc.weight) > exMax + 0.01;
                  return (
                    <div key={cid} className="rounded-md border bg-muted/30 p-3 space-y-2">
                      <p className="text-sm font-medium">{course?.name ?? cid}</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                          <Label className="text-xs text-muted-foreground">Corte</Label>
                          <Select
                            value={cc.cut_id ?? "__none__"}
                            onValueChange={(v) =>
                              setCourseCuts((prev) => ({
                                ...prev,
                                [cid]: {
                                  ...(prev[cid] ?? { weight: 1 }),
                                  cut_id: v === "__none__" ? null : v,
                                },
                              }))
                            }
                          >
                            <SelectTrigger className="mt-1 h-8 text-sm">
                              <SelectValue placeholder="Sin corte" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">Sin corte</SelectItem>
                              {cutsForCourse.map((c) => (
                                <SelectItem key={c.id} value={c.id}>
                                  {c.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {cutsForCourse.length === 0 && (
                            <p className="text-xs text-muted-foreground mt-1">
                              Sin cortes definidos
                            </p>
                          )}
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">Peso (%)</Label>
                          <div className="relative mt-1">
                            <DecimalInput
                              min={0}
                              max={exMax > 0 ? exMax : undefined}
                              placeholder="1,0"
                              className="pr-7 h-8 text-sm"
                              disabled={!cc.cut_id}
                              value={cc.weight}
                              onChange={(v) =>
                                setCourseCuts((prev) => ({
                                  ...prev,
                                  [cid]: { ...(prev[cid] ?? { cut_id: null }), weight: v ?? 1 },
                                }))
                              }
                            />
                            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
                              %
                            </span>
                          </div>
                          {selectedCut && (
                            <p
                              className={`text-xs mt-1 ${overBucket ? "text-destructive" : "text-muted-foreground"}`}
                            >
                              Disponible: <strong>{exMax.toFixed(1)}%</strong> (bucket {exBucket}% −
                              otros {sumOthers.toFixed(1)}%)
                              {overBucket && (
                                <span className="block">Excede el bucket disponible.</span>
                              )}
                            </p>
                          )}
                          {!cc.cut_id && (
                            <p className="text-xs text-muted-foreground mt-1">
                              Asigna un corte para configurar el peso.
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <>
                <div>
                  <Label>
                    Corte de evaluación{" "}
                    <HelpHint>{t("help.examCutWeightHelp")}</HelpHint>
                  </Label>
                  {(() => {
                    const targetCourseId = [...selectedCourseIds][0];
                    const availableCuts = cuts.filter((c) => c.course_id === targetCourseId);
                    return (
                      <Select
                        value={form.cut_id ?? "__none__"}
                        onValueChange={(v) =>
                          setForm({ ...form, cut_id: v === "__none__" ? null : v })
                        }
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
                </div>
                {form.cut_id &&
                  (() => {
                    const selectedCut = cuts.find((c) => c.id === form.cut_id);
                    const exBucket = Number(selectedCut?.exam_weight ?? 0);
                    const exMax = examWeightMax ?? 0;
                    const sumOthers = exams
                      .filter((e) => e.cut_id === form.cut_id && !e.parent_exam_id)
                      .reduce((s, e) => s + Number(e.weight ?? 0), 0);
                    const currentWeight = Number((form as any).weight ?? 1) || 0;
                    const overBucket = currentWeight > exMax + 0.01;
                    return (
                      <div>
                        <Label>Peso del examen (% del bucket de exámenes del corte)</Label>
                        <div className="relative mt-1 w-32">
                          <DecimalInput
                            min={0}
                            max={exMax || undefined}
                            placeholder="1,0"
                            className="pr-7"
                            value={(form as any).weight ?? 1}
                            onChange={(v) => setForm({ ...form, weight: v ?? 1 } as any)}
                          />
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
                            %
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          Bucket exámenes del corte{" "}
                          <span className="font-medium">{selectedCut?.name}</span>: {exBucket}%.
                          Otros exámenes suman {sumOthers.toFixed(1)}%, te queda{" "}
                          <strong>{exMax.toFixed(1)}%</strong> disponible.
                          {overBucket && (
                            <span className="block text-destructive mt-1">
                              El peso actual ({currentWeight.toFixed(1)}%) excede el bucket.
                            </span>
                          )}
                        </p>
                      </div>
                    );
                  })()}
              </>
            )}
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

      {duplicateSource && (
        <DuplicateAssessmentDialog
          open={!!duplicateSource}
          onOpenChange={(o) => !o && setDuplicateSource(null)}
          source={duplicateSource}
          target="exam"
          onDuplicated={() => {
            setDuplicateSource(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function toLocal(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
