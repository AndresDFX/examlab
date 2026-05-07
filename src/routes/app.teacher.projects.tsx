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
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { Switch } from "@/components/ui/switch";
import { ExternalGradesEditor } from "@/components/ExternalGradesEditor";
import { ProjectGroupsEditor } from "@/components/ProjectGroupsEditor";
import { toast } from "sonner";
import {
  Plus,
  Pencil,
  Trash2,
  Users,
  FileText,
  ClipboardList,
  Sparkles,
  Save,
  UserPlus,
  FolderKanban,
  UsersRound,
} from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  useMultiSelect,
  MultiSelectHeaderCheckbox,
  MultiSelectCheckbox,
  MultiSelectToolbar,
  BulkDeleteDialog,
} from "@/components/ui/multi-select";
import { ListFilters } from "@/components/ui/list-filters";
import { TeacherProjectFilesEditor } from "@/components/ProjectFiles";
import { AssignSelector } from "@/components/AssignSelector";
import { FeedbackThread } from "@/components/FeedbackThread";
import { FraudPanel } from "@/components/FraudPanel";
import { DecimalInput } from "@/components/ui/decimal-input";
import { RowAction } from "@/components/ui/row-action";
import { Spinner } from "@/components/ui/spinner";
import { DateTimePicker } from "@/components/ui/date-picker";
import { statusLabel } from "@/utils/status-labels";
import { StatusBadge } from "@/components/ui/status-badge";
import { TableEmpty } from "@/components/ui/empty-state";
import { ListSkeleton } from "@/components/ui/table-skeleton";
import { formatDateTime } from "@/lib/format";
import { useDirtyDialog } from "@/hooks/use-dirty-dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

// projects, project_* aún no están en los tipos generados.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const Route = createFileRoute("/app/teacher/projects")({ component: TeacherProjects });

type Course = { id: string; name: string; period: string | null; language?: string | null };
type Cut = {
  id: string;
  course_id: string;
  name: string;
  weight: number;
  workshop_weight: number;
  exam_weight: number;
  project_weight: number;
  attendance_weight: number;
};
type Student = { id: string; full_name: string; institutional_email: string };

type Project = {
  id: string;
  course_id: string;
  cut_id: string | null;
  title: string;
  description: string | null;
  instructions: string | null;
  external_link: string | null;
  max_files: number;
  start_date: string | null;
  due_date: string | null;
  max_score: number;
  status: "draft" | "published" | "closed";
  is_external?: boolean;
  group_mode?: "individual" | "teacher_assigned" | "self_signup";
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
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [courseFilter, setCourseFilter] = useState<string | null>(null);
  const [cutFilter, setCutFilter] = useState<string | null>(null);
  // Proyectos filtrados por título, curso y corte. A diferencia de
  // talleres/exámenes, un proyecto puede estar vinculado a N cursos
  // vía linked_course_ids — el match contra el filtro chequea esa
  // lista (cae al course_id legacy si no hay vínculos). El filtro de
  // corte aplica sobre cut_id (el corte siempre es del curso primario).
  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects.filter((p) => {
      if (courseFilter) {
        const linked = p.linked_course_ids ?? [p.course_id];
        if (!linked.includes(courseFilter)) return false;
      }
      if (cutFilter && p.cut_id !== cutFilter) return false;
      if (q && !p.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [projects, search, courseFilter, cutFilter]);
  const sel = useMultiSelect(filteredProjects);

  const handleBulkDelete = async (ids: string[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from("projects").delete().in("id", ids);
    if (error) throw new Error(error.message);
    toast.success(`${ids.length} proyecto(s) eliminado(s) correctamente`);
    sel.clear();
    load();
  };

  const selectedProjectItems = useMemo(
    () =>
      filteredProjects
        .filter((p) => sel.isSelected(p.id))
        .map((p) => ({ id: p.id, label: p.title })),
    [filteredProjects, sel],
  );
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [form, setForm] = useState<Partial<Project>>({});
  const projectDirty = useDirtyDialog(open, form);

  const [filesOpen, setFilesOpen] = useState(false);
  const [filesProject, setFilesProject] = useState<Project | null>(null);

  const [groupsOpen, setGroupsOpen] = useState(false);
  const [groupsProject, setGroupsProject] = useState<Project | null>(null);

  /**
   * Abre el editor de grupos del proyecto. Si está en modo `individual`,
   * lo cambia a `teacher_assigned` silenciosamente para que el flujo
   * sea de un click — espejo del comportamiento en talleres.
   */
  const openGroupsForProject = async (p: Project) => {
    const mode = (p as any).group_mode ?? "individual";
    let updated = p;
    if (mode === "individual") {
      const { error } = await db
        .from("projects")
        .update({ group_mode: "teacher_assigned" })
        .eq("id", p.id);
      if (error) {
        toast.error(error.message);
        return;
      }
      updated = { ...p, group_mode: "teacher_assigned" } as Project;
      setProjects((prev) => prev.map((x) => (x.id === p.id ? updated : x)));
      toast.success("Trabajo en grupo activado");
    }
    setGroupsProject(updated);
    setGroupsOpen(true);
  };

  const [assignOpen, setAssignOpen] = useState(false);
  const [assignProject, setAssignProject] = useState<Project | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [assigned, setAssigned] = useState<Set<string>>(new Set());
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignFilterCourses, setAssignFilterCourses] = useState<Set<string>>(new Set());
  const [studentsByCourse, setStudentsByCourse] = useState<Map<string, Set<string>>>(new Map());

  // Grading dialog state
  type Submission = {
    id: string;
    user_id: string;
    status: string;
    final_grade: number | null;
    ai_grade: number | null;
    submission_grade: number | null;
    defense_factor: number | null;
    defense_notes: string | null;
    defense_at: string | null;
    repository_url: string | null;
    submitted_at: string | null;
    profile?: { full_name: string; institutional_email: string };
  };
  type SubFile = {
    id: string;
    submission_id: string;
    file_id: string;
    content: string | null;
    ai_grade: number | null;
    ai_feedback: string | null;
    ai_likelihood: number | null;
  };
  const [gradingOpen, setGradingOpen] = useState(false);
  const [gradingProject, setGradingProject] = useState<Project | null>(null);
  const [gradingFiles, setGradingFiles] = useState<
    Array<{ id: string; title: string; points: number }>
  >([]);
  const [gradingSubs, setGradingSubs] = useState<Submission[]>([]);
  const [gradingAnsBySub, setGradingAnsBySub] = useState<Record<string, SubFile[]>>({});
  const [gradingLoading, setGradingLoading] = useState(false);
  // Submission a destacar/scrollear cuando el dialog abre desde un
  // deep-link (?submission=ID).
  const [highlightSubId, setHighlightSubId] = useState<string | null>(null);
  // Archivo a destacar dentro del accordion expandido cuando el
  // deep-link viene del modal de Conversaciones abiertas (?file=ID).
  const [highlightFileId, setHighlightFileId] = useState<string | null>(null);
  const [openAccordionItems, setOpenAccordionItems] = useState<string[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [aiRegradingId, setAiRegradingId] = useState<string | null>(null);

  /** Auto-assign a project to all students enrolled in any of the linked courses. */
  const autoAssignProject = async (projectId: string, courseIds: string[]) => {
    if (!courseIds.length) return 0;
    const { data: enr } = await db
      .from("course_enrollments")
      .select("user_id")
      .in("course_id", courseIds);
    const enrolled = Array.from(
      new Set(((enr ?? []) as { user_id: string }[]).map((r) => r.user_id)),
    );
    if (!enrolled.length) return 0;
    const { data: existing } = await db
      .from("project_assignments")
      .select("user_id")
      .eq("project_id", projectId);
    const existSet = new Set(((existing ?? []) as { user_id: string }[]).map((r) => r.user_id));
    const toAdd = enrolled.filter((uid) => !existSet.has(uid));
    if (!toAdd.length) return 0;
    const rows = toAdd.map((uid) => ({ project_id: projectId, user_id: uid }));
    const { error } = await db.from("project_assignments").insert(rows);
    if (error) {
      toast.error(error.message);
      return 0;
    }
    return toAdd.length;
  };

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
      const cs2 = await db
        .from("grade_cuts")
        .select(
          "id, course_id, name, weight, workshop_weight, exam_weight, project_weight, attendance_weight",
        )
        .order("position");
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

  // Deep-link desde notificación o modal de Conversaciones abiertas:
  //   ?project=PROJECT_ID&submission=SUB_ID&file=FILE_ID
  //   ?id=PROJECT_ID    (legacy, notificaciones viejas)
  // → abre el grading dialog, expande la submission y scrollea al
  // archivo cuya conversación se quiere ver. Si el proyecto ya no
  // existe, toast claro y limpia la URL para no re-disparar.
  const [autoOpenedFromUrl, setAutoOpenedFromUrl] = useState(false);
  useEffect(() => {
    if (autoOpenedFromUrl || projects.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const projectParam = params.get("project") ?? params.get("id");
    const subParam = params.get("submission");
    const fileParam = params.get("file");
    if (projectParam) {
      const p = projects.find((pr) => pr.id === projectParam);
      if (p) {
        if (subParam) setHighlightSubId(subParam);
        if (fileParam) setHighlightFileId(fileParam);
        void openGradingDialog(p);
      } else {
        toast.info(
          "El proyecto referenciado en la notificación ya no existe o no tienes acceso a él.",
        );
      }
      // Limpia los query params para que un refresh no re-dispare.
      const url = new URL(window.location.href);
      url.searchParams.delete("project");
      url.searchParams.delete("submission");
      url.searchParams.delete("file");
      url.searchParams.delete("id");
      window.history.replaceState({}, "", url.toString());
    }
    setAutoOpenedFromUrl(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, autoOpenedFromUrl]);

  // Cuando hay highlightFileId pendiente y la submission destacada ya
  // está expandida con sus answers cargadas, scrollea + ring a la card
  // del archivo. El accordion se auto-expandió en el effect anterior.
  useEffect(() => {
    if (!gradingOpen || !highlightFileId || !highlightSubId) return;
    const t = setTimeout(() => {
      const el = document.getElementById(`pj-file-${highlightSubId}-${highlightFileId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 250);
    const clear = setTimeout(() => setHighlightFileId(null), 3500);
    return () => {
      clearTimeout(t);
      clearTimeout(clear);
    };
  }, [gradingOpen, highlightFileId, highlightSubId, gradingSubs]);

  // Scroll + ring temporal + auto-expand del accordion a la submission
  // destacada (deep-link desde el modal "Conversaciones abiertas" o desde
  // una notificación).
  useEffect(() => {
    if (!gradingOpen || !highlightSubId || gradingSubs.length === 0) return;
    const target = gradingSubs.find((s) => s.id === highlightSubId);
    if (!target) {
      setHighlightSubId(null);
      return;
    }
    setOpenAccordionItems((prev) =>
      prev.includes(highlightSubId) ? prev : [...prev, highlightSubId],
    );
    const t = setTimeout(() => {
      const el = document.getElementById(`pj-sub-${highlightSubId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
    const clear = setTimeout(() => setHighlightSubId(null), 3500);
    return () => {
      clearTimeout(t);
      clearTimeout(clear);
    };
  }, [gradingOpen, highlightSubId, gradingSubs]);

  const openNew = () => {
    setEditing(null);
    const first = courses[0]?.id;
    setForm({
      title: "",
      description: "",
      instructions: "",
      external_link: "",
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
    const primary = next.includes(form.course_id ?? "") ? form.course_id : next[0];
    setForm({
      ...form,
      linked_course_ids: next,
      course_id: primary,
      // Si el corte ya no pertenece al curso primario, resetear
      cut_id:
        primary && cuts.find((c) => c.id === form.cut_id)?.course_id === primary
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
    const primaryCourse =
      form.course_id && linked.includes(form.course_id) ? form.course_id : linked[0];
    const maxFiles = Math.max(1, Math.min(20, Number(form.max_files) || 3));
    const isExternal = !!(form as any).is_external;
    // Patrón "campos desactivados": cuando is_external=true, omitir
    // campos sin sentido (instrucciones, link, archivos esperados) del
    // payload para no insertar dummies.
    //
    // is_external solo se envía cuando es true. Si el column todavía no
    // está en el schema cache de PostgREST (Lovable aún no aplicó la
    // migración), mandar is_external=false rompía el insert con
    // "Could not find the 'is_external' column". El default de la
    // tabla ya es false, así que omitirlo es seguro.
    const payload: Record<string, any> = {
      course_id: primaryCourse,
      cut_id: form.cut_id || null,
      title: form.title,
      description: form.description ?? null,
      max_score: Number(form.max_score) || 100,
      status: form.status ?? "draft",
    };
    if (isExternal) {
      payload.is_external = true;
      // Para externos: due_date marca cuándo ocurrió, sin start ni files.
      payload.due_date = form.due_date ? new Date(form.due_date).toISOString() : null;
    } else {
      payload.instructions = form.instructions ?? null;
      payload.external_link = form.external_link || null;
      payload.max_files = maxFiles;
      payload.start_date = form.start_date ? new Date(form.start_date).toISOString() : null;
      payload.due_date = form.due_date ? new Date(form.due_date).toISOString() : null;
    }
    // weight solo aplica con corte; si no, dejamos que el DEFAULT 1 se mantenga
    if (form.cut_id && (form as any).weight != null) {
      payload.weight = Number((form as any).weight);
    }

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

      // Auto-asignar a todos los matriculados de los cursos vinculados al publicar
      if (payload.status === "published") {
        const added = await autoAssignProject(projectId, linked);
        if (added > 0) toast.success(`${added} estudiante(s) asignados automáticamente`);
      }

      // Notificar a los estudiantes solo cuando el proyecto está
      // publicado y NO es externo. Distintos titles para create/update.
      if (payload.status === "published" && !isExternal) {
        const isUpdate = !!editing;
        const title = isUpdate ? "Proyecto actualizado" : "Nuevo proyecto disponible";
        const body = isUpdate
          ? `Se actualizó el proyecto "${form.title}"`
          : `Se ha publicado el proyecto "${form.title}"`;
        for (const cid of linked) {
          await supabase.rpc("notify_course_students", {
            _course_id: cid,
            _title: title,
            _body: body,
            _kind: "info",
            _link: "/app/student/projects",
          });
        }
      }
    }

    setOpen(false);
    await load();
  };

  const remove = async (p: Project) => {
    const ok = await confirm({
      title: `Eliminar ${p.title}`,
      description:
        "Se eliminará el proyecto y todas sus entregas. Esta acción no se puede deshacer.",
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
    setStudents([]);
    setAssigned(new Set());
    setAssignError(null);
    setAssignLoading(true);
    setAssignOpen(true);
    const courseIds = p.linked_course_ids?.length ? p.linked_course_ids : [p.course_id];
    setAssignFilterCourses(new Set(courseIds as string[]));
    try {
      const { data: enr, error: enrError } = await db
        .from("course_enrollments")
        .select("user_id, course_id")
        .in("course_id", courseIds);
      if (enrError) throw enrError;

      const enrRows = (enr ?? []) as { user_id: string; course_id: string }[];
      const byCourse = new Map<string, Set<string>>();
      for (const r of enrRows) {
        if (!byCourse.has(r.course_id)) byCourse.set(r.course_id, new Set());
        byCourse.get(r.course_id)!.add(r.user_id);
      }
      setStudentsByCourse(byCourse);

      const userIds = Array.from(new Set(enrRows.map((r) => r.user_id)));
      let list: Student[] = [];
      if (userIds.length) {
        const { data: profs, error: profError } = await db
          .from("profiles")
          .select("id, full_name, institutional_email")
          .in("id", userIds)
          .order("full_name");
        if (profError) throw profError;
        list = (profs ?? []) as Student[];
      }
      setStudents(list);

      const { data: asgn, error: asgnError } = await db
        .from("project_assignments")
        .select("user_id")
        .eq("project_id", p.id);
      if (asgnError) throw asgnError;
      setAssigned(new Set((asgn ?? []).map((a: { user_id: string }) => a.user_id)));
    } catch (e) {
      console.error("[projects] assignment load failed", e);
      const message = e instanceof Error ? e.message : "No se pudieron cargar estudiantes";
      setAssignError(message);
      toast.error(message);
    } finally {
      setAssignLoading(false);
    }
  };

  /** Estudiantes visibles según los cursos seleccionados como filtro. */
  const visibleStudents = (() => {
    if (!assignFilterCourses.size) return students;
    const allowed = new Set<string>();
    for (const cid of assignFilterCourses) {
      const set = studentsByCourse.get(cid);
      if (set) for (const uid of set) allowed.add(uid);
    }
    return students.filter((s) => allowed.has(s.id));
  })();

  const assignByCourse = async (courseId: string) => {
    if (!assignProject) return;
    const courseStudents = studentsByCourse.get(courseId);
    if (!courseStudents || !courseStudents.size) {
      toast.info("Ese curso no tiene estudiantes matriculados");
      return;
    }
    const toAdd = Array.from(courseStudents).filter((uid) => !assigned.has(uid));
    if (!toAdd.length) {
      toast.info("Ya todos los del curso están asignados");
      return;
    }
    const rows = toAdd.map((uid) => ({ project_id: assignProject.id, user_id: uid }));
    const { error } = await db.from("project_assignments").insert(rows);
    if (error) return toast.error(error.message);
    setAssigned((prev) => {
      const next = new Set(prev);
      for (const uid of toAdd) next.add(uid);
      return next;
    });
    toast.success(`${toAdd.length} estudiante(s) asignados del curso`);
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

  const assignMany = async (visibleIds: string[]) => {
    if (!assignProject) return;
    const toAdd = visibleIds.filter((id) => !assigned.has(id));
    if (!toAdd.length) return;
    const rows = toAdd.map((id) => ({ project_id: assignProject.id, user_id: id }));
    const { error } = await db.from("project_assignments").insert(rows);
    if (error) return toast.error(error.message);
    setAssigned((prev) => new Set([...prev, ...toAdd]));
    toast.success(`${toAdd.length} estudiantes asignados`);
  };

  const unassignMany = async (visibleIds: string[]) => {
    if (!assignProject) return;
    const toRemove = visibleIds.filter((id) => assigned.has(id));
    if (!toRemove.length) return;
    const { error } = await db
      .from("project_assignments")
      .delete()
      .eq("project_id", assignProject.id)
      .in("user_id", toRemove);
    if (error) return toast.error(error.message);
    setAssigned((prev) => {
      const next = new Set(prev);
      toRemove.forEach((id) => next.delete(id));
      return next;
    });
    toast.success(`${toRemove.length} asignación(es) removidas`);
  };

  // ===== Grading dialog =====
  const openGradingDialog = async (p: Project) => {
    setGradingProject(p);
    setGradingFiles([]);
    setGradingSubs([]);
    setGradingAnsBySub({});
    setGradingOpen(true);
    setGradingLoading(true);
    try {
      const [{ data: files }, { data: subs }] = await Promise.all([
        db
          .from("project_files")
          .select("id, title, points, position")
          .eq("project_id", p.id)
          .order("position"),
        db
          .from("project_submissions")
          .select(
            "id, user_id, status, final_grade, ai_grade, submission_grade, defense_factor, defense_notes, defense_at, repository_url, submitted_at",
          )
          .eq("project_id", p.id)
          .order("submitted_at", { ascending: false }),
      ]);
      setGradingFiles((files ?? []) as Array<{ id: string; title: string; points: number }>);

      const subsList = (subs ?? []) as Submission[];
      if (subsList.length) {
        const userIds = subsList.map((s) => s.user_id);
        const subIds = subsList.map((s) => s.id);
        const [{ data: profs }, { data: ans }] = await Promise.all([
          db.from("profiles").select("id, full_name, institutional_email").in("id", userIds),
          db
            .from("project_submission_files")
            .select("id, submission_id, file_id, content, ai_grade, ai_feedback, ai_likelihood")
            .in("submission_id", subIds),
        ]);
        const profMap = new Map(((profs ?? []) as Array<{ id: string }>).map((pp) => [pp.id, pp]));
        const grouped: Record<string, SubFile[]> = {};
        for (const a of (ans ?? []) as SubFile[]) {
          (grouped[a.submission_id] ||= []).push(a);
        }
        setGradingAnsBySub(grouped);
        setGradingSubs(
          subsList.map((s) => ({ ...s, profile: profMap.get(s.user_id) as Submission["profile"] })),
        );
      }
    } catch (e) {
      console.error("[projects] grading load failed", e);
      toast.error(e instanceof Error ? e.message : "Error cargando entregas");
    } finally {
      setGradingLoading(false);
    }
  };

  const recomputeProjectGrade = (subId: string): number => {
    if (!gradingProject) return 0;
    const ans = gradingAnsBySub[subId] ?? [];
    const totalPoints = gradingFiles.reduce((s, f) => s + Number(f.points || 0), 0);
    if (totalPoints <= 0) return 0;
    const earned = gradingFiles.reduce((s, f) => {
      const a = ans.find((x) => x.file_id === f.id);
      const g = Math.min(Number(a?.ai_grade ?? 0) || 0, Number(f.points) || 0);
      return s + g;
    }, 0);
    return Number(((earned / totalPoints) * Number(gradingProject.max_score)).toFixed(2));
  };

  const patchSubFile = (subId: string, fileId: string, patch: Partial<SubFile>) => {
    setGradingAnsBySub((prev) => {
      const list = (prev[subId] ?? []).slice();
      const idx = list.findIndex((a) => a.file_id === fileId);
      if (idx >= 0) list[idx] = { ...list[idx], ...patch };
      return { ...prev, [subId]: list };
    });
  };

  const saveSubFileGrade = async (subId: string, fileId: string) => {
    const ans = (gradingAnsBySub[subId] ?? []).find((a) => a.file_id === fileId);
    if (!ans?.id) {
      toast.error("Esta entrega no tiene contenido para este archivo");
      return;
    }
    setSavingId(ans.id);
    try {
      const { error } = await db
        .from("project_submission_files")
        .update({ ai_grade: ans.ai_grade, ai_feedback: ans.ai_feedback })
        .eq("id", ans.id);
      if (error) {
        toast.error(error.message);
        return;
      }
      const newSubmissionGrade = recomputeProjectGrade(subId);
      // Modelo: submission_grade siempre se actualiza con la nota de la
      // entrega. final_grade depende de defense_factor: si ya hay sustentación,
      // se recalcula; si no, queda null hasta que el docente sustente.
      const sub = gradingSubs.find((s) => s.id === subId);
      const factor = sub?.defense_factor;
      const newFinalGrade =
        factor != null ? Number((newSubmissionGrade * factor).toFixed(2)) : null;
      const { error: subErr } = await db
        .from("project_submissions")
        .update({
          submission_grade: newSubmissionGrade,
          final_grade: newFinalGrade,
          status: factor != null ? "calificado" : "entregado",
        })
        .eq("id", subId);
      if (subErr) {
        toast.error(`Guardado, pero falló recalcular: ${subErr.message}`);
        return;
      }
      setGradingSubs((prev) =>
        prev.map((s) =>
          s.id === subId
            ? {
                ...s,
                submission_grade: newSubmissionGrade,
                final_grade: newFinalGrade,
                status: factor != null ? "calificado" : "entregado",
              }
            : s,
        ),
      );
      toast.success(
        factor != null
          ? `Guardado · final: ${newFinalGrade}/${gradingProject?.max_score ?? 100} (entrega ${newSubmissionGrade} × sustentación ${factor})`
          : `Entrega: ${newSubmissionGrade}/${gradingProject?.max_score ?? 100} — falta sustentación`,
      );
    } finally {
      setSavingId(null);
    }
  };

  /**
   * Persiste la sustentación: factor 0..1 + notas. Recalcula final_grade
   * como submission_grade × factor. Si factor es null/vacío, deja la
   * entrega "sin sustentar" (final_grade null, status entregado).
   */
  const saveDefense = async (subId: string, factor: number | null, notes: string) => {
    const sub = gradingSubs.find((s) => s.id === subId);
    if (!sub) return;
    const subGrade = sub.submission_grade ?? sub.ai_grade;
    if (subGrade == null) {
      toast.error("La entrega aún no tiene calificación. Califica los archivos primero.");
      return;
    }
    const validFactor =
      factor != null && !Number.isNaN(factor) ? Math.max(0, Math.min(1, factor)) : null;
    const newFinal =
      validFactor != null ? Number((Number(subGrade) * validFactor).toFixed(2)) : null;
    const { error } = await db
      .from("project_submissions")
      .update({
        defense_factor: validFactor,
        defense_notes: notes || null,
        defense_at: validFactor != null ? new Date().toISOString() : null,
        final_grade: newFinal,
        status: validFactor != null ? "calificado" : "entregado",
      })
      .eq("id", subId);
    if (error) {
      toast.error(error.message);
      return;
    }
    setGradingSubs((prev) =>
      prev.map((s) =>
        s.id === subId
          ? {
              ...s,
              defense_factor: validFactor,
              defense_notes: notes || null,
              defense_at: validFactor != null ? new Date().toISOString() : null,
              final_grade: newFinal,
              status: validFactor != null ? "calificado" : "entregado",
            }
          : s,
      ),
    );
    toast.success(
      validFactor != null
        ? `Sustentación guardada · nota final: ${newFinal}/${gradingProject?.max_score ?? 100}`
        : "Sustentación borrada",
    );
  };

  const aiRegradeSubFile = async (
    subId: string,
    file: { id: string; title: string; points: number },
  ) => {
    const ans = (gradingAnsBySub[subId] ?? []).find((a) => a.file_id === file.id);
    if (!ans?.id) {
      toast.error("Sin contenido para recalificar");
      return;
    }
    setAiRegradingId(ans.id);
    try {
      const courseLang = (gradingProject?.course?.language === "en" ? "en" : "es") as "es" | "en";
      // fetch expected_rubric + description for the file
      const { data: meta } = await db
        .from("project_files")
        .select("description, expected_rubric")
        .eq("id", file.id)
        .maybeSingle();
      const { data: aiData, error: aiErr } = await supabase.functions.invoke(
        "ai-grade-submission",
        {
          body: {
            projectFileGrading: true,
            fileTitle: file.title,
            fileDescription: meta?.description ?? null,
            expectedRubric: meta?.expected_rubric ?? null,
            maxPoints: file.points,
            studentContent: ans.content ?? "",
            courseLanguage: courseLang,
          },
        },
      );
      if (aiErr || aiData?.error) {
        toast.error(`Error IA: ${aiErr?.message ?? aiData?.error}`);
        return;
      }
      const newGrade = Number(aiData?.grade ?? 0);
      const newFeedback = String(aiData?.feedback ?? "");
      patchSubFile(subId, file.id, { ai_grade: newGrade, ai_feedback: newFeedback });
      await db
        .from("project_submission_files")
        .update({ ai_grade: newGrade, ai_feedback: newFeedback })
        .eq("id", ans.id);
      toast.success("Archivo recalificado con IA");
    } finally {
      setAiRegradingId(null);
    }
  };

  const deleteSubmission = async (sub: Submission) => {
    const name = sub.profile?.full_name ?? "estudiante";
    const ok = await confirm({
      title: `Eliminar entrega de ${name}`,
      description: "Se eliminará la entrega y todos sus archivos de forma permanente.",
      confirmLabel: "Eliminar entrega",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("project_submissions").delete().eq("id", sub.id);
    if (error) return toast.error(error.message);
    setGradingSubs((prev) => prev.filter((s) => s.id !== sub.id));
    setGradingAnsBySub((prev) => {
      const next = { ...prev };
      delete next[sub.id];
      return next;
    });
    toast.success("Entrega eliminada");
  };

  const courseLanguage = (filesProject?.course?.language === "en" ? "en" : "es") as "es" | "en";

  if (!isTeacher) return <p className="text-muted-foreground">{t("project.needsTeacherRole")}</p>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Proyectos</h1>
          <p className="text-sm text-muted-foreground">
            {filteredProjects.length === projects.length
              ? `${projects.length} proyectos`
              : `${filteredProjects.length} de ${projects.length} proyectos`}
          </p>
        </div>
        <Button onClick={openNew}>
          <Plus className="h-4 w-4 mr-1" /> Nuevo proyecto
        </Button>
      </div>

      <ListFilters
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar proyecto por título…"
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
        entityNameSingular="proyecto"
        entityNamePlural="proyectos"
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <MultiSelectHeaderCheckbox state={sel} />
                </TableHead>
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
              {filteredProjects.map((p) => (
                <TableRow key={p.id} data-state={sel.isSelected(p.id) ? "selected" : undefined}>
                  <TableCell className="w-10">
                    <MultiSelectCheckbox id={p.id} state={sel} />
                  </TableCell>
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
                    <StatusBadge status={p.status} />
                  </TableCell>
                  <TableCell className="text-xs tabular-nums">
                    {formatDateTime(p.due_date)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-0.5">
                      <RowAction
                        label="Archivos esperados"
                        icon={FileText}
                        onClick={() => openFilesDialog(p)}
                      />
                      <RowAction
                        label="Asignar estudiantes"
                        icon={Users}
                        onClick={() => openAssignDialog(p)}
                      />
                      {!p.is_external && (
                        <RowAction
                          label={
                            (p as any).group_mode && (p as any).group_mode !== "individual"
                              ? "Grupos"
                              : "Activar grupos"
                          }
                          icon={UsersRound}
                          onClick={() => openGroupsForProject(p)}
                        />
                      )}
                      <RowAction
                        label="Entregas y calificación"
                        icon={ClipboardList}
                        onClick={() => openGradingDialog(p)}
                      />
                      <RowAction
                        label={t("common.edit")}
                        icon={Pencil}
                        onClick={() => openEdit(p)}
                      />
                      <RowAction
                        label={t("common.delete")}
                        icon={Trash2}
                        tone="destructive"
                        onClick={() => remove(p)}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {projects.length === 0 ? (
                <TableEmpty
                  colSpan={8}
                  icon={FolderKanban}
                  text="Aún no has creado ningún proyecto."
                  hint="Define los archivos esperados y asígnalo a uno o varios cursos."
                  action={
                    <Button size="sm" onClick={openNew}>
                      <Plus className="h-4 w-4 mr-1" />
                      Crear primer proyecto
                    </Button>
                  }
                />
              ) : filteredProjects.length === 0 ? (
                <TableEmpty
                  colSpan={8}
                  icon={FolderKanban}
                  text="Sin resultados para los filtros actuales."
                  hint="Limpia el buscador o el curso para ver todos los proyectos."
                />
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* New / edit project dialog */}
      <Dialog open={open} onOpenChange={projectDirty.guardOpenChange(setOpen)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Editar proyecto" : "Nuevo proyecto"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {/*
             * Toggle "Actividad externa": cuando el proyecto ya ocurrió fuera
             * de la plataforma y solo se registra la nota. Esconde campos que
             * no aplican (instrucciones, link, archivos esperados) y al editar
             * la calificación se muestra el editor de notas externas.
             */}
            <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 p-2.5">
              <div className="space-y-0.5">
                <Label htmlFor="project-is-external" className="text-sm">
                  Actividad externa
                </Label>
                <p className="text-[11px] text-muted-foreground leading-tight">
                  Un proyecto que ocurrió fuera de la plataforma. Solo registras notas y
                  observaciones por estudiante.
                </p>
              </div>
              <Switch
                id="project-is-external"
                checked={!!(form as any).is_external}
                onCheckedChange={(v) => setForm({ ...form, is_external: v } as any)}
              />
            </div>
            <div>
              <Label required>Título</Label>
              <Input
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
            {!(form as any).is_external && (
              <div>
                <Label>Instrucciones</Label>
                <Textarea
                  rows={4}
                  value={form.instructions ?? ""}
                  onChange={(e) => setForm({ ...form, instructions: e.target.value })}
                />
              </div>
            )}
            {!(form as any).is_external && (
              <div>
                <Label>Link externo (opcional)</Label>
                <Input
                  placeholder="https://..."
                  value={form.external_link ?? ""}
                  onChange={(e) => setForm({ ...form, external_link: e.target.value })}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label required>{t("nav.courses")} (puedes seleccionar varios)</Label>
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
                      <Checkbox checked={checked} onCheckedChange={() => toggleFormCourse(c.id)} />
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
            <div>
              {(() => {
                const selectedCut = form.cut_id ? cuts.find((c) => c.id === form.cut_id) : null;
                const pjBucket = Number(selectedCut?.project_weight ?? 0);
                const editingId = (form as any).id as string | undefined;
                const otherProjectsSum = projects
                  .filter((p) => p.cut_id === form.cut_id && p.id !== editingId)
                  .reduce((s, p) => s + Number((p as any).weight ?? 0), 0);
                const pjMax = Math.max(0, pjBucket - otherProjectsSum);
                const currentWeight = Number((form as any).weight ?? 1) || 0;
                const overBucket = currentWeight > pjMax + 0.01;
                return (
                  <>
                    <Label>Peso del proyecto (% del bucket de proyectos del corte)</Label>
                    <div className="relative w-32">
                      <Input
                        type="number"
                        min={0}
                        max={pjMax || undefined}
                        step="0.1"
                        placeholder="1"
                        className="pr-7"
                        disabled={!selectedCut}
                        value={(form as any).weight ?? 1}
                        onChange={(e) => {
                          const raw = e.target.value === "" ? 1 : Number(e.target.value);
                          const capped = pjMax > 0 ? Math.min(raw, pjMax) : raw;
                          setForm({ ...form, weight: capped } as any);
                        }}
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
                        %
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {selectedCut ? (
                        <>
                          Bucket proyectos del corte{" "}
                          <span className="font-medium">{selectedCut.name}</span>: {pjBucket}%.
                          Otros proyectos del corte suman {otherProjectsSum.toFixed(1)}%, te queda{" "}
                          <strong>{pjMax.toFixed(1)}%</strong> disponible.
                          {overBucket && (
                            <span className="block text-destructive mt-1">
                              El peso actual ({currentWeight.toFixed(1)}%) excede el bucket. Reduce
                              este o ajusta el bucket en el editor de cortes.
                            </span>
                          )}
                        </>
                      ) : (
                        "Asigna primero un corte para poder configurar el peso."
                      )}
                    </p>
                  </>
                );
              })()}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {!(form as any).is_external && (
                <div>
                  <Label required>Número de archivos</Label>
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
              )}
              <div>
                <Label required>Puntaje máximo</Label>
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
              {!(form as any).is_external && (
                <div>
                  <Label required>{t("common.startDate")}</Label>
                  <DateTimePicker
                    value={form.start_date ? toLocal(form.start_date) : ""}
                    onChange={(v) => setForm({ ...form, start_date: v })}
                  />
                </div>
              )}
              <div>
                <Label required>
                  {(form as any).is_external ? "Fecha del evento" : t("common.endDate")}
                </Label>
                <DateTimePicker
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

      {/* Project groups editor dialog */}
      <Dialog open={groupsOpen} onOpenChange={setGroupsOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Grupos del proyecto {groupsProject ? `— ${groupsProject.title}` : ""}
            </DialogTitle>
          </DialogHeader>
          {groupsProject && (
            <ProjectGroupsEditor
              projectId={groupsProject.id}
              courseIds={
                groupsProject.linked_course_ids?.length
                  ? groupsProject.linked_course_ids
                  : [groupsProject.course_id]
              }
            />
          )}
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

          <AssignSelector
            items={visibleStudents}
            selectedIds={assigned}
            onToggle={(id) => toggleAssign(id)}
            onSelectAll={assignMany}
            onDeselectAll={unassignMany}
            loading={assignLoading}
            errorText={assignError}
            emptyText="Sin estudiantes matriculados."
            countNoun="asignados"
            headerExtras={
              assignProject && (assignProject.linked_course_ids ?? []).length > 0 ? (
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground">
                    Filtra por curso o asigna a todos los matriculados de un curso.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {(assignProject.linked_course_ids ?? []).map((cid) => {
                      const c = courses.find((cc) => cc.id === cid);
                      if (!c) return null;
                      const enabled = assignFilterCourses.has(cid);
                      const count = studentsByCourse.get(cid)?.size ?? 0;
                      return (
                        <div key={cid} className="flex items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => {
                              setAssignFilterCourses((prev) => {
                                const next = new Set(prev);
                                if (next.has(cid)) next.delete(cid);
                                else next.add(cid);
                                return next;
                              });
                            }}
                            className={`text-[10px] px-2 py-0.5 rounded-full border ${
                              enabled
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-muted text-muted-foreground"
                            }`}
                          >
                            {c.name} ({count})
                          </button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0"
                            title="Asignar a todos los matriculados de este curso"
                            onClick={() => assignByCourse(cid)}
                          >
                            <UserPlus className="h-3 w-3" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null
            }
          />
        </DialogContent>
      </Dialog>

      {/* Grading / submissions dialog */}
      <Dialog open={gradingOpen} onOpenChange={setGradingOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {gradingProject?.is_external ? "Notas externas" : "Entregas"} —{" "}
              {gradingProject?.title}
            </DialogTitle>
          </DialogHeader>
          {/* Proyecto externo: mostrar el editor de notas externas en lugar
              de la lista de entregas reales. */}
          {gradingProject?.is_external && (
            <ExternalGradesEditor
              kind="project"
              refId={gradingProject.id}
              courseId={gradingProject.course_id}
              maxScore={Number(gradingProject.max_score) || 100}
            />
          )}
          {!gradingProject?.is_external && gradingLoading && (
            <ListSkeleton rows={3} rowHeight="h-24" />
          )}
          {!gradingProject?.is_external && !gradingLoading && gradingSubs.length === 0 && (
            <p className="text-sm text-muted-foreground p-4 text-center">
              Aún no hay entregas para este proyecto.
            </p>
          )}
          {!gradingProject?.is_external &&
            !gradingLoading &&
            gradingProject &&
            gradingSubs.length > 0 && (
              <FraudPanel
                kind="project"
                refId={gradingProject.id}
                userNames={Object.fromEntries(
                  gradingSubs.map((s) => [s.user_id, (s as any).profile?.full_name ?? "—"]),
                )}
              />
            )}
          {!gradingProject?.is_external && !gradingLoading && gradingSubs.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {gradingSubs.length} entrega(s) · puntaje máximo {gradingProject?.max_score} ·{" "}
                <span className="font-medium">decimales con coma (ej. 4,5)</span>
              </p>
              <Accordion
                type="multiple"
                className="w-full"
                value={openAccordionItems}
                onValueChange={setOpenAccordionItems}
              >
                {gradingSubs.map((sub) => {
                  const ans = gradingAnsBySub[sub.id] ?? [];
                  // grade que aparece en el badge del header: la final si ya
                  // hay sustentación, si no la de la entrega (submission_grade
                  // o el legacy ai_grade), si no nada.
                  const headerGrade = sub.final_grade ?? sub.submission_grade ?? sub.ai_grade;
                  return (
                    <AccordionItem
                      key={sub.id}
                      value={sub.id}
                      id={`pj-sub-${sub.id}`}
                      className={
                        highlightSubId === sub.id ? "ring-2 ring-primary/60 rounded-md" : ""
                      }
                    >
                      <AccordionTrigger className="hover:no-underline">
                        <div className="flex flex-1 items-center gap-2 text-left">
                          <span className="font-medium text-sm">
                            {sub.profile?.full_name ?? "—"}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {sub.profile?.institutional_email}
                          </span>
                          <div className="ml-auto">
                            <StatusBadge status={sub.status} />
                          </div>
                          {sub.defense_factor == null && headerGrade != null && (
                            <Badge variant="secondary" className="text-[9px]">
                              Falta sustentar
                            </Badge>
                          )}
                          <Badge variant="outline" className="text-[10px] tabular-nums">
                            {headerGrade != null
                              ? `${headerGrade}/${gradingProject?.max_score}`
                              : "—"}
                          </Badge>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent>
                        <div className="space-y-3">
                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <p className="text-[11px] text-muted-foreground tabular-nums">
                              Enviado: {formatDateTime(sub.submitted_at)}
                            </p>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive"
                              onClick={() => deleteSubmission(sub)}
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-1" /> Eliminar entrega
                            </Button>
                          </div>
                          {sub.repository_url && (
                            <div className="rounded-md border bg-amber-500/5 dark:bg-amber-500/10 border-amber-500/30 p-2.5 space-y-1">
                              <div className="text-[11px] text-muted-foreground">
                                Repositorio del estudiante (verificar fechas vs entrega):
                              </div>
                              <a
                                href={sub.repository_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-primary hover:underline break-all"
                              >
                                {sub.repository_url}
                              </a>
                            </div>
                          )}
                          <DefensePanel
                            sub={sub}
                            maxScore={Number(gradingProject?.max_score ?? 100)}
                            onSave={saveDefense}
                          />
                          {gradingFiles.map((f) => {
                            const a = ans.find((x) => x.file_id === f.id);
                            const isHighlighted =
                              highlightSubId === sub.id && highlightFileId === f.id;
                            return (
                              <Card
                                key={f.id}
                                id={`pj-file-${sub.id}-${f.id}`}
                                className={isHighlighted ? "ring-2 ring-primary/60" : undefined}
                              >
                                <CardContent className="p-3 space-y-2">
                                  <div className="flex items-center gap-2">
                                    <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                                    <span className="text-sm font-medium">{f.title}</span>
                                    <span className="text-[10px] text-muted-foreground">
                                      {f.points} pts
                                    </span>
                                    {a?.ai_likelihood != null && (
                                      <Badge variant="outline" className="text-[10px] ml-auto">
                                        IA: {Math.round(Number(a.ai_likelihood) * 100)}%
                                      </Badge>
                                    )}
                                  </div>
                                  <Textarea
                                    value={a?.content ?? ""}
                                    readOnly
                                    rows={6}
                                    className="font-mono text-xs"
                                  />
                                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                    <div>
                                      <Label className="text-[10px]">
                                        Calificación (max {f.points})
                                      </Label>
                                      <DecimalInput
                                        min={0}
                                        max={f.points}
                                        value={a?.ai_grade ?? null}
                                        onChange={(v) =>
                                          patchSubFile(sub.id, f.id, { ai_grade: v })
                                        }
                                      />
                                    </div>
                                    <div className="md:col-span-2">
                                      <Label className="text-[10px]">Retroalimentación</Label>
                                      <Textarea
                                        rows={2}
                                        value={a?.ai_feedback ?? ""}
                                        onChange={(e) =>
                                          patchSubFile(sub.id, f.id, {
                                            ai_feedback: e.target.value,
                                          })
                                        }
                                      />
                                    </div>
                                  </div>
                                  <div className="flex gap-2 justify-end">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={aiRegradingId === a?.id}
                                      onClick={() => aiRegradeSubFile(sub.id, f)}
                                    >
                                      {aiRegradingId === a?.id ? (
                                        <Spinner size="sm" className="mr-1" />
                                      ) : (
                                        <Sparkles className="h-3.5 w-3.5 mr-1" />
                                      )}
                                      Recalificar IA
                                    </Button>
                                    <Button
                                      size="sm"
                                      disabled={savingId === a?.id}
                                      onClick={() => saveSubFileGrade(sub.id, f.id)}
                                    >
                                      {savingId === a?.id ? (
                                        <Spinner size="sm" className="mr-1" />
                                      ) : (
                                        <Save className="h-3.5 w-3.5 mr-1" />
                                      )}
                                      Guardar
                                    </Button>
                                  </div>
                                  <FeedbackThread
                                    parentKind="project"
                                    questionId={f.id}
                                    submissionId={sub.id}
                                    isTeacher
                                  />
                                </CardContent>
                              </Card>
                            );
                          })}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <BulkDeleteDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        items={selectedProjectItems}
        entityNameSingular="proyecto"
        entityNamePlural="proyectos"
        extraWarning="Se eliminarán también las asignaciones, archivos esperados y entregas de los proyectos seleccionados."
        onConfirm={handleBulkDelete}
      />
    </div>
  );
}

/**
 * Panel de sustentación dentro del dialog de calificación. Muestra la
 * nota de la entrega + un input 0..1 para el factor de sustentación +
 * notas + botón guardar. Calcula la nota final como
 * `submission_grade × defense_factor` cuando se guarda.
 */
function DefensePanel({
  sub,
  maxScore,
  onSave,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sub: any;
  maxScore: number;
  onSave: (subId: string, factor: number | null, notes: string) => Promise<void>;
}) {
  const [factor, setFactor] = useState<string>(
    sub.defense_factor != null ? String(sub.defense_factor) : "",
  );
  const [notes, setNotes] = useState<string>(sub.defense_notes ?? "");
  const [saving, setSaving] = useState(false);
  const subGrade: number | null = sub.submission_grade ?? sub.ai_grade ?? null;
  const factorNum = factor.trim() === "" ? null : Number(factor.replace(",", "."));
  const factorValid = factorNum == null || (factorNum >= 0 && factorNum <= 1);
  const previewFinal =
    subGrade != null && factorNum != null && factorValid
      ? Number((Number(subGrade) * factorNum).toFixed(2))
      : null;
  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="p-3 space-y-2">
        <div className="text-sm font-medium">Sustentación</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
          <div>
            <div className="text-muted-foreground text-[11px]">Nota entrega</div>
            <div className="font-mono tabular-nums">
              {subGrade != null ? `${subGrade}/${maxScore}` : "—"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-[11px]">Factor (0–1)</div>
            <Input
              type="text"
              inputMode="decimal"
              placeholder="ej. 0,8"
              value={factor}
              onChange={(e) => setFactor(e.target.value)}
              className="h-8 text-xs"
            />
            {!factorValid && (
              <p className="text-[10px] text-destructive mt-0.5">Debe estar entre 0 y 1</p>
            )}
          </div>
          <div>
            <div className="text-muted-foreground text-[11px]">Nota final = entrega × factor</div>
            <div className="font-mono tabular-nums font-semibold">
              {previewFinal != null ? `${previewFinal}/${maxScore}` : "—"}
            </div>
          </div>
        </div>
        <Textarea
          rows={2}
          placeholder="Notas de la sustentación (opcional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="text-xs"
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={async () => {
              if (!factorValid) return;
              setSaving(true);
              try {
                await onSave(sub.id, factorNum, notes);
              } finally {
                setSaving(false);
              }
            }}
            disabled={saving || !factorValid}
          >
            {saving ? <Spinner size="sm" className="mr-1" /> : null}
            Guardar sustentación
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function toLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
