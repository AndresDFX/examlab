import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import i18next from "i18next";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/use-auth";
import { isStaffRole } from "@/shared/lib/roles";
import { logEvent } from "@/shared/lib/audit";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { HelpHint } from "@/components/ui/help-hint";
import { SearchInput } from "@/components/ui/search-input";
import { RowAction } from "@/components/ui/row-action";
import { DecimalInput } from "@/components/ui/decimal-input";
import { friendlyError } from "@/shared/lib/db-errors";
import { ErrorState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ClipboardList } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  Download,
  GitBranch,
  FileText,
  FileSpreadsheet,
  Hammer,
  Save,
  Scale,
  AlertTriangle,
  Eye,
  Inbox,
  FolderKanban,
  CalendarCheck,
  Award,
  RotateCcw,
  ChevronDown,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { startImpersonate } from "@/modules/admin/impersonation";
import { downloadCSV, toCSV } from "@/shared/lib/csv";
import { toXLSX, downloadXLSX } from "@/shared/lib/xlsx";
import { computeWeightedGrade, type GradedItem } from "@/modules/grading/grade";
import { computeAttemptGrade, type RetryMode } from "@/modules/exams/exam-attempts";
import {
  downloadCertificate,
  downloadCertificatesZip,
  buildVerifyUrl,
} from "@/modules/certificates/certificate-pdf";

// grade_cuts/projects pueden no estar en types.ts auto-generados
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const Route = createFileRoute("/app/teacher/gradebook")({ component: Gradebook });

type Course = {
  id: string;
  name: string;
  grade_scale_min: number;
  grade_scale_max: number;
  passing_grade: number;
  exam_weight: number;
  workshop_weight: number;
};
type Exam = {
  id: string;
  title: string;
  parent_exam_id: string | null;
  course_id: string;
  cut_id?: string | null;
  weight?: number | null;
  retry_mode?: string | null;
};
type Workshop = {
  id: string;
  title: string;
  course_id: string;
  max_score: number;
  cut_id?: string | null;
  weight?: number | null;
  is_external?: boolean | null;
};
type Project = {
  id: string;
  title: string;
  course_id: string;
  max_score: number;
  cut_id: string | null;
  weight?: number | null;
  is_external?: boolean | null;
};
type Cut = {
  id: string;
  name: string;
  position: number;
  start_date: string | null;
  end_date: string | null;
  weight: number;
  workshop_weight: number;
  exam_weight: number;
  project_weight: number;
  attendance_weight: number;
};
type AttSession = { id: string; session_date: string; cut_id?: string | null };
type AttRecord = { session_id: string; user_id: string; status: string };
type ProjectSub = {
  project_id: string;
  user_id: string;
  ai_grade: number | null;
  final_grade: number | null;
  status: string;
};
type Student = {
  id: string;
  full_name: string;
  institutional_email: string;
  personal_email: string | null;
  cohorte: string | null;
};
type ExamSub = {
  id: string;
  exam_id: string;
  user_id: string;
  ai_grade: number | null;
  final_override_grade: number | null;
  status: string;
  created_at: string;
};
type WsSub = {
  id: string;
  workshop_id: string;
  user_id: string;
  ai_grade: number | null;
  final_grade: number | null;
  status: string;
};

/** A column in the grid — examen, taller o proyecto */
type GradeColumn = {
  id: string;
  title: string;
  kind: "exam" | "workshop" | "project";
  parentExamId?: string | null;
  maxScore?: number;
  isExternal?: boolean;
  /** Peso del item como % de la nota final (cap = su bucket en el corte).
   *  Se muestra en los encabezados del export para que la columna sea tan
   *  clara como el grid (igual que los cortes muestran su %). */
  weight?: number | null;
  /** Corte al que pertenece el item (exam.cut_id / workshop_courses.cut_id /
   *  project_courses.cut_id). null = sin corte. Usado por el export Excel para
   *  la fila de grupo que agrupa cada entregable bajo su corte. */
  cutId?: string | null;
};

/** Editable grade cell keyed by `${studentId}::${columnId}` */
type EditMap = Record<string, string>;

function Gradebook() {
  const { t } = useTranslation();

  const { roles, loading: authLoading } = useAuth();
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState<string>("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [columns, setColumns] = useState<GradeColumn[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [studentSearch, setStudentSearch] = useState("");
  const [examSubs, setExamSubs] = useState<ExamSub[]>([]);
  const [wsSubs, setWsSubs] = useState<WsSub[]>([]);
  const [allExams, setAllExams] = useState<Exam[]>([]);
  const [allWorkshops, setAllWorkshops] = useState<Workshop[]>([]);
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectSubs, setProjectSubs] = useState<ProjectSub[]>([]);
  const [attSessions, setAttSessions] = useState<AttSession[]>([]);
  const [attRecords, setAttRecords] = useState<AttRecord[]>([]);
  const [edits, setEdits] = useState<EditMap>({});
  const [saving, setSaving] = useState(false);
  // Cuál corte tiene abierto el modal de "Ver detalle"
  const [detailCutId, setDetailCutId] = useState<string | null>(null);
  // Cuál estudiante tiene abierto el modal anidado "detalle por estudiante"
  // (se abre desde el ojo en cada fila del modal de corte).
  const [detailStudentId, setDetailStudentId] = useState<string | null>(null);
  // Certificados emitidos en este curso, indexados por user_id (solo el activo).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [certByUserId, setCertByUserId] = useState<Record<string, any>>({});
  const [issuingId, setIssuingId] = useState<string | null>(null);
  const [bulkIssuing, setBulkIssuing] = useState(false);
  const confirm = useConfirm();
  // SA accede a pantallas Docente para soporte / diagnóstico — sin SA
  // en el set, recibía "Necesitas rol Docente" silencioso al entrar.
  const isTeacher = isStaffRole(roles);

  // Carga certificados activos del curso (refresh tras emitir)
  const reloadCertificates = useCallback(async () => {
    if (!courseId) return;
    const { data, error } = await db
      .from("certificates")
      .select("*")
      .eq("course_id", courseId)
      .is("revoked_at", null);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map: Record<string, any> = {};
    for (const c of (data ?? []) as Array<{ user_id: string }>) {
      map[c.user_id] = c;
    }
    setCertByUserId(map);
  }, [courseId]);

  useEffect(() => {
    void reloadCertificates();
  }, [reloadCertificates]);

  // Load courses
  useEffect(() => {
    supabase
      .from("courses")
      .select(
        "id, name, grade_scale_min, grade_scale_max, passing_grade, exam_weight, workshop_weight",
      )
      .is("deleted_at", null)
      .order("name")
      .then(({ data, error }) => {
        if (error) {
          setLoadError(
            friendlyError(error, t("hc_routesAppTeacherGradebook.couldNotLoadCourses")),
          );
          return;
        }
        setLoadError(null);
        setCourses(data ?? []);
        if (data?.[0]) setCourseId(data[0].id);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  // Load data for selected course
  const loadCourse = useCallback(async () => {
    if (!courseId) return;

    // Exams (incluye cut_id para el consolidado de cortes)
    const { data: exams } = await (supabase as any)
      .from("exams")
      .select("id, title, parent_exam_id, course_id, cut_id, weight, retry_mode")
      .eq("course_id", courseId)
      .is("deleted_at", null)
      .order("start_time");

    // Workshops
    const { data: workshops } = await supabase
      .from("workshops")
      .select("id, title, course_id, max_score, cut_id, weight, is_external")
      .eq("course_id", courseId)
      .is("deleted_at", null)
      .order("created_at");

    // Cortes evaluativos
    const { data: cutsData } = await db
      .from("grade_cuts")
      .select(
        "id, name, position, start_date, end_date, weight, workshop_weight, exam_weight, project_weight, attendance_weight",
      )
      .eq("course_id", courseId)
      .order("position");

    // Proyectos: query via project_courses para incluir secundarios y usar
    // cut_id/weight por curso en vez del global de projects.
    const { data: pcData } = await db
      .from("project_courses")
      .select("cut_id, weight, project:projects(id, title, course_id, max_score, is_external, deleted_at)")
      .eq("course_id", courseId);
    const projectsData = (pcData ?? [])
      .filter((pc: any) => pc.project && !pc.project.deleted_at) // en papelera → excluido
      .map((pc: any) => ({
        ...pc.project,
        cut_id: pc.cut_id,
        weight: pc.weight,
      }));

    // Sesiones de asistencia. cut_id es el FK explícito al corte
    // (migración 20260509020000). Si llega null, la sesión no aporta a
    // ningún corte — comportamiento intencional del docente.
    const { data: sessions } = await db
      .from("attendance_sessions")
      .select("id, session_date, cut_id")
      .eq("course_id", courseId)
      .is("deleted_at", null);

    setAllExams((exams ?? []) as Exam[]);
    setAllWorkshops((workshops ?? []) as Workshop[]);
    setCuts((cutsData ?? []) as Cut[]);
    setProjects((projectsData ?? []) as Project[]);
    setAttSessions((sessions ?? []) as AttSession[]);

    // Build columns: original exams (no parent) + workshops + projects
    const examCols: GradeColumn[] = ((exams ?? []) as Exam[])
      .filter((e) => !e.parent_exam_id)
      .map((e) => ({
        id: e.id,
        title: e.title,
        kind: "exam" as const,
        parentExamId: null,
        weight: e.weight ?? null,
        cutId: e.cut_id ?? null,
      }));

    const wsCols: GradeColumn[] = ((workshops ?? []) as Workshop[]).map((w) => ({
      id: w.id,
      title: w.title,
      kind: "workshop" as const,
      maxScore: w.max_score,
      isExternal: !!w.is_external,
      weight: w.weight ?? null,
      cutId: w.cut_id ?? null,
    }));

    const prjCols: GradeColumn[] = ((projectsData ?? []) as Project[]).map((p) => ({
      id: p.id,
      title: p.title,
      kind: "project" as const,
      maxScore: p.max_score,
      isExternal: !!p.is_external,
      weight: p.weight ?? null,
      cutId: p.cut_id ?? null,
    }));

    setColumns([...examCols, ...wsCols, ...prjCols]);

    // Students
    const { data: enr } = await supabase
      .from("course_enrollments")
      .select("user_id")
      .eq("course_id", courseId);
    const userIds = (enr ?? []).map((r: any) => r.user_id);

    if (userIds.length) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, full_name, institutional_email, personal_email, cohorte")
        .in("id", userIds)
        .order("full_name");
      setStudents((profs ?? []) as Student[]);
    } else {
      setStudents([]);
    }

    // Exam submissions
    const examIds = (exams ?? []).map((e: any) => e.id);
    if (examIds.length) {
      const { data: es } = await supabase
        .from("submissions")
        .select("id, exam_id, user_id, ai_grade, final_override_grade, status, created_at")
        .in("exam_id", examIds);
      setExamSubs((es ?? []) as ExamSub[]);
    } else {
      setExamSubs([]);
    }

    // Workshop submissions
    const wsIds = (workshops ?? []).map((w: any) => w.id);
    if (wsIds.length) {
      const { data: ws } = await supabase
        .from("workshop_submissions")
        .select("id, workshop_id, user_id, ai_grade, final_grade, status")
        .in("workshop_id", wsIds);
      setWsSubs((ws ?? []) as WsSub[]);
    } else {
      setWsSubs([]);
    }

    // Project submissions (todos los estudiantes)
    const prjIds = ((projectsData ?? []) as Project[]).map((p) => p.id);
    if (prjIds.length && userIds.length) {
      const { data: ps } = await db
        .from("project_submissions")
        .select("project_id, user_id, ai_grade, final_grade, status")
        .in("project_id", prjIds);
      setProjectSubs((ps ?? []) as ProjectSub[]);
    } else {
      setProjectSubs([]);
    }

    // Attendance records (todas las sesiones del curso)
    const sessIds = ((sessions ?? []) as AttSession[]).map((s) => s.id);
    if (sessIds.length && userIds.length) {
      const { data: ar } = await db
        .from("attendance_records")
        .select("session_id, user_id, status")
        .in("session_id", sessIds);
      setAttRecords((ar ?? []) as AttRecord[]);
    } else {
      setAttRecords([]);
    }

    setEdits({});
  }, [courseId]);

  useEffect(() => {
    loadCourse();
  }, [loadCourse]);

  // Get the effective grade for a student + column
  const getGrade = (
    studentId: string,
    col: GradeColumn,
  ): {
    grade: number | null;
    isMakeup: boolean;
    status?: string;
    subId?: string;
  } => {
    if (col.kind === "exam") {
      const examMeta = allExams.find((e) => e.id === col.id);
      const mode = (examMeta?.retry_mode as RetryMode) ?? "last";

      // Todos los intentos directos del estudiante en este examen
      const own = examSubs.filter((s) => s.user_id === studentId && s.exam_id === col.id);
      if (own.length) {
        const grade = computeAttemptGrade(own, mode);
        // Para edición / referencia, usar el más reciente
        const latest = [...own].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        )[0];
        return { grade, isMakeup: false, status: latest.status, subId: latest.id };
      }
      // Recuperaciones (parent_exam_id)
      const makeups = allExams.filter((e) => e.parent_exam_id === col.id);
      for (const m of makeups) {
        const subs = examSubs.filter((s) => s.user_id === studentId && s.exam_id === m.id);
        if (subs.length) {
          const mMode = (m.retry_mode as RetryMode) ?? "last";
          const grade = computeAttemptGrade(subs, mMode);
          const latest = [...subs].sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
          )[0];
          return { grade, isMakeup: true, status: latest.status, subId: latest.id };
        }
      }
      return { grade: null, isMakeup: false };
    } else if (col.kind === "workshop") {
      const sub = wsSubs.find((s) => s.user_id === studentId && s.workshop_id === col.id);
      if (sub)
        return {
          grade: sub.final_grade ?? sub.ai_grade,
          isMakeup: false,
          status: sub.status,
          subId: sub.id,
        };
      return { grade: null, isMakeup: false };
    } else {
      // project
      const sub = projectSubs.find((s) => s.user_id === studentId && s.project_id === col.id);
      if (sub)
        return {
          grade: sub.final_grade ?? sub.ai_grade,
          isMakeup: false,
          status: sub.status,
          // project_submissions no expone `id` en la query actual; sin
          // subId no podemos editar inline. Se considera follow-up
          // separado si se quiere editar proyectos desde aquí.
          subId: undefined,
        };
      return { grade: null, isMakeup: false };
    }
  };

  // Edit handler
  const cellKey = (studentId: string, colId: string) => `${studentId}::${colId}`;

  const handleEdit = (studentId: string, colId: string, value: string) => {
    setEdits((prev) => ({ ...prev, [cellKey(studentId, colId)]: value }));
  };

  // Save all edits
  const saveAll = async () => {
    const entries = Object.entries(edits).filter(([, v]) => v !== "");
    if (!entries.length) {
      toast.info(
        i18n.t("toast.routes_app_teacher_gradebook.noChangesToSave", {
          defaultValue: "No hay cambios para guardar",
        }),
      );
      return;
    }

    setSaving(true);
    let saved = 0;
    let errors = 0;

    for (const [key, value] of entries) {
      const [studentId, colId] = key.split("::");
      const col = columns.find((c) => c.id === colId);
      if (!col) continue;

      const numValue = Number(value);
      if (isNaN(numValue)) {
        errors++;
        continue;
      }

      if (col.kind === "exam") {
        const g = getGrade(studentId, col);
        if (g.subId) {
          const { error } = await supabase
            .from("submissions")
            .update({ final_override_grade: numValue })
            .eq("id", g.subId);
          if (error) errors++;
          else {
            saved++;
            void logEvent({
              action: "grade.manual_override",
              category: "grading",
              severity: "warning",
              entityType: "submission",
              entityId: g.subId,
              courseId: courseId ?? null,
              metadata: {
                source: "gradebook",
                kind: "exam",
                exam_id: col.id,
                student_id: studentId,
                new: numValue,
              },
            });
          }
        } else {
          errors++; // No submission to update
        }
      } else if (col.kind === "workshop") {
        const g = getGrade(studentId, col);
        if (g.subId) {
          const { error } = await supabase
            .from("workshop_submissions")
            .update({ final_grade: numValue, status: "calificado" })
            .eq("id", g.subId);
          if (error) errors++;
          else {
            saved++;
            void logEvent({
              action: "grade.manual_override",
              category: "grading",
              severity: "warning",
              entityType: "workshop_submission",
              entityId: g.subId,
              courseId: courseId ?? null,
              metadata: {
                source: "gradebook",
                kind: "workshop",
                workshop_id: col.id,
                student_id: studentId,
                new: numValue,
              },
            });
          }
        } else {
          errors++; // No submission to update
        }
      } else {
        // project — la cell muestra read-only en la grilla porque
        // projectSubs no carga `id`; saltamos. Si se quiere editar
        // desde aquí, hay que extender projectSubs select y getGrade.
        errors++;
      }
    }

    setSaving(false);
    if (saved > 0)
      toast.success(
        i18n.t("toast.routes_app_teacher_gradebook.gradesSaved", {
          defaultValue: "{{count}} calificación(es) guardada(s) correctamente",
          count: saved,
        }),
      );
    if (errors > 0)
      toast.error(
        i18n.t("toast.routes_app_teacher_gradebook.gradesSaveErrors", {
          defaultValue: "{{count}} error(es) — solo se pueden editar entregas existentes",
          count: errors,
        }),
      );
    setEdits({});
    loadCourse();
  };

  // Export CSV
  const exportCourse = (format: "csv" | "xlsx" = "csv") => {
    if (!students.length || !columns.length) {
      toast.info(
        i18n.t("toast.routes_app_teacher_gradebook.noDataToExport", {
          defaultValue: "No hay datos para exportar",
        }),
      );
      return;
    }

    // Mapa user_id → calificaciones consolidadas por corte + final
    // ponderada. Usa la misma lógica del consolidado en pantalla, así
    // el CSV refleja exactamente lo que ve el docente.
    const consolidatedByUser = new Map<
      string,
      { cutGrades: Array<{ cutId: string; grade: number | null }>; finalGrade: number | null }
    >();
    if (consolidated) {
      for (const r of consolidated) {
        consolidatedByUser.set(r.student.id, {
          cutGrades: r.cutGrades,
          finalGrade: r.finalGrade,
        });
      }
    }
    const fmt = (n: number | null | undefined) => (n != null ? n.toFixed(2) : "");

    // ¿El curso usa cohortes? Si al menos un estudiante tiene cohorte,
    // agregamos una columna "Cohorte" y AGRUPAMOS las filas por cohorte
    // (orden es-CO; sin cohorte al final) para que el export sea legible
    // por grupo. Si no hay cohortes, se mantiene el orden por nombre.
    const anyCohort = students.some((s) => !!s.cohorte?.trim());
    const cohortHeader = t("hc_routesAppTeacherGradebook.csvCohort", { defaultValue: "Cohorte" });
    const exportStudents = anyCohort
      ? [...students].sort((a, b) => {
          const ca = (a.cohorte ?? "").trim();
          const cb = (b.cohorte ?? "").trim();
          if (ca !== cb) {
            if (!ca) return 1; // sin cohorte al final
            if (!cb) return -1;
            return ca.localeCompare(cb, "es-CO", { numeric: true, sensitivity: "base" });
          }
          return a.full_name.localeCompare(b.full_name, "es-CO", {
            numeric: true,
            sensitivity: "base",
          });
        })
      : students;

    // Etiqueta de columna de item — debe ser IDÉNTICA tanto en el row de datos
    // como en la fila de grupo del Excel (es la KEY del objeto que ambos usan),
    // así que la centralizamos para que no diverjan.
    const itemLabel = (col: GradeColumn) => {
      const prefix =
        col.kind === "workshop" ? t("hc_routesAppTeacherGradebook.csvWorkshopPrefix") : "";
      const pct = col.weight != null ? ` (${col.weight}%)` : "";
      return `${prefix}${col.title}${pct}`;
    };

    const csvRows = exportStudents.map((s) => {
      const row: Record<string, string> = {
        [t("hc_routesAppTeacherGradebook.csvName")]: s.full_name,
      };
      // Columna Cohorte (2ª, junto al nombre) sólo si el curso usa cohortes.
      if (anyCohort) row[cohortHeader] = s.cohorte?.trim() ?? "";
      row[t("hc_routesAppTeacherGradebook.csvInstitutionalEmail")] = s.institutional_email;
      row[t("hc_routesAppTeacherGradebook.csvPersonalEmail")] = s.personal_email ?? "";
      // Detalle item por item (exámenes y talleres con su nota cruda). El
      // encabezado incluye el % del item (peso sobre la nota final) para que
      // la columna sea tan clara como el grid — igual que los cortes muestran
      // su % (ej. "Parcial 1 (15%)").
      columns.forEach((col) => {
        const g = getGrade(s.id, col);
        const label = itemLabel(col);
        if (g.grade != null) {
          row[label] = `${g.grade}${
            g.isMakeup ? t("hc_routesAppTeacherGradebook.csvMakeupSuffix") : ""
          }`;
        } else {
          row[label] = "";
        }
      });
      // Calificación por corte + final ponderada al final del row, en
      // orden de los cortes para que sea fácil de leer en Excel.
      const stuConsolidated = consolidatedByUser.get(s.id);
      cuts.forEach((cut) => {
        const cg = stuConsolidated?.cutGrades.find((c) => c.cutId === cut.id);
        row[`${cut.name} (${cut.weight}%)`] = fmt(cg?.grade ?? null);
      });
      row[t("hc_routesAppTeacherGradebook.csvFinalGrade")] = fmt(
        stuConsolidated?.finalGrade ?? null,
      );
      return row;
    });

    const courseName =
      courses.find((c) => c.id === courseId)?.name ??
      t("hc_routesAppTeacherGradebook.courseFallback");
    const fileBase = `${t("hc_routesAppTeacherGradebook.csvFilePrefix")}-${courseName.replace(
      /\s+/g,
      "_",
    )}-${Date.now()}`;
    if (format === "xlsx") {
      // Fila de grupo EXCLUSIVA de Excel: mapea la etiqueta de cada columna de
      // item al nombre del corte al que pertenece (cut.name). Las columnas de
      // nombre/cohorte/email/cortes/final quedan en blanco (no se mapean). Las
      // columnas de items sin corte quedan en blanco también (cutId == null).
      const groupHeader: Record<string, string> = {};
      columns.forEach((col) => {
        const cut = col.cutId ? cuts.find((c) => c.id === col.cutId) : null;
        if (cut) groupHeader[itemLabel(col)] = cut.name;
      });
      // Si ningún item tiene corte, no agregamos la fila de grupo (evita una
      // fila inicial en blanco): pasamos undefined en vez de un mapa vacío.
      downloadXLSX(
        `${fileBase}.xlsx`,
        toXLSX(
          csvRows,
          undefined,
          "Datos",
          Object.keys(groupHeader).length ? { groupHeader } : undefined,
        ),
      );
    } else {
      downloadCSV(`${fileBase}.csv`, toCSV(csvRows));
    }
    toast.success(
      i18n.t("toast.routes_app_teacher_gradebook.fileExported", {
        defaultValue: "Archivo exportado correctamente",
      }),
    );
  };

  const hasEdits = Object.values(edits).some((v) => v !== "");
  const selectedCourse = courses.find((c) => c.id === courseId);

  // Filtra estudiantes por nombre o correo. Aplica al consolidado, a la
  // sub-grid de "Sin corte asignado" y al modal de detalle. Tabular nums
  // y exports siguen usando `students` (la lista completa) para que el
  // CSV traiga TODO aunque haya un filtro activo en pantalla.
  const filteredStudents = useMemo(() => {
    if (!studentSearch.trim()) return students;
    const q = studentSearch.toLowerCase();
    return students.filter((s) => {
      const name = s.full_name.toLowerCase();
      const email = s.institutional_email.toLowerCase();
      return name.includes(q) || email.includes(q);
    });
  }, [students, studentSearch]);

  // Agrupa columnas (exámenes + talleres) por corte para que la grilla
  // editable se separe en "items dentro de un corte" (visibles solo en
  // el modal de Ver detalle) vs "items sin corte" (visibles en su
  // propia card debajo del consolidado).
  const columnsByCut = useMemo(() => {
    const map = new Map<string | null, GradeColumn[]>();
    for (const col of columns) {
      // `col.cutId` ya viene resuelto al construir las columnas en loadCourse
      // (exam.cut_id / workshop.cut_id / project_courses.cut_id) — única fuente
      // de verdad, compartida con la fila de grupo del export Excel.
      const cutId = col.cutId ?? null;
      const arr = map.get(cutId) ?? [];
      arr.push(col);
      map.set(cutId, arr);
    }
    return map;
  }, [columns]);

  const uncutColumns = columnsByCut.get(null) ?? [];
  const detailCutColumns = detailCutId ? (columnsByCut.get(detailCutId) ?? []) : [];
  const detailCut = detailCutId ? cuts.find((c) => c.id === detailCutId) : null;

  // ───────── Consolidado por cortes (modelo nuevo: peso = % de la nota final)
  // Cada item (examen, taller, proyecto) y la asistencia por corte aportan
  // directamente con su peso al cálculo. La nota del corte y la final usan
  // computeWeightedGrade que reescala pesos cuando hay items sin score.
  const consolidated = useMemo(() => {
    if (!selectedCourse || !cuts.length || !students.length) return null;

    const min = selectedCourse.grade_scale_min;
    const max = selectedCourse.grade_scale_max;
    const toScale = (raw: number, rawMax: number) => {
      const pct = rawMax > 0 ? raw / rawMax : 0;
      return min + pct * (max - min);
    };

    const recordsBySessionUser = new Map<string, string>();
    for (const r of attRecords) {
      recordsBySessionUser.set(`${r.session_id}::${r.user_id}`, r.status);
    }

    return students.map((stu) => {
      // Lista de items del curso (con su corte y peso). Se reusa para
      // calcular el promedio del corte y el final.
      const allItems: Array<{ cutId: string | null; score: number | null; weight: number }> = [];

      // Exams (con makeup fallback)
      for (const e of allExams.filter((x) => !x.parent_exam_id)) {
        let sub = examSubs.find((s) => s.user_id === stu.id && s.exam_id === e.id);
        if (!sub) {
          const makeups = allExams.filter((m) => m.parent_exam_id === e.id).map((m) => m.id);
          sub = examSubs.find((s) => s.user_id === stu.id && makeups.includes(s.exam_id));
        }
        const raw = sub ? (sub.final_override_grade ?? sub.ai_grade) : null;
        allItems.push({
          cutId: e.cut_id ?? null,
          weight: Math.max(0, Number((e as any).weight ?? 1) || 0),
          score: raw != null ? toScale(Number(raw), max) : null,
        });
      }

      // Workshops — para is_external la nota está en escala del curso
      // (la captura ExternalGradesEditor con cap = grade_scale_max).
      for (const w of allWorkshops) {
        const sub = wsSubs.find((s) => s.user_id === stu.id && s.workshop_id === w.id);
        const raw = sub ? (sub.final_grade ?? sub.ai_grade) : null;
        const wMax = w.is_external ? max : (w.max_score ?? 100);
        allItems.push({
          cutId: w.cut_id ?? null,
          weight: Math.max(0, Number((w as any).weight ?? 1) || 0),
          score: raw != null ? toScale(Number(raw), wMax) : null,
        });
      }

      // Projects — misma regla que workshops para is_external.
      for (const p of projects) {
        const sub = projectSubs.find((s) => s.user_id === stu.id && s.project_id === p.id);
        const raw = sub ? (sub.final_grade ?? sub.ai_grade) : null;
        const pMax = p.is_external ? max : (p.max_score ?? 100);
        allItems.push({
          cutId: p.cut_id ?? null,
          weight: Math.max(0, Number((p as any).weight ?? 1) || 0),
          score: raw != null ? toScale(Number(raw), pMax) : null,
        });
      }

      // Asistencia por corte: solo aporta si hay sesiones programadas en la
      // ventana del corte. Sin sesiones → no es "nota perdida", es "no aplica
      // todavía" → omitirlo del weighted avg (mismo criterio que la vista del
      // estudiante en app.student.grades.tsx).
      const attEntries = cuts
        .map((cut) => {
          // Filtramos sesiones por cut_id explícito (migración
          // 20260509020000). Antes se inferiía por rango de fechas; ahora
          // el docente la asigna al crear la sesión.
          const sessionsInCut = attSessions.filter((s) => s.cut_id === cut.id);
          if (sessionsInCut.length === 0) return null;
          const present = sessionsInCut.filter(
            (s) => recordsBySessionUser.get(`${s.id}::${stu.id}`) === "presente",
          ).length;
          const attAvg = min + (present / sessionsInCut.length) * (max - min);
          return {
            cutId: cut.id,
            weight: Math.max(0, Number(cut.attendance_weight ?? 0) || 0),
            score: attAvg,
          };
        })
        .filter((e): e is { cutId: string; weight: number; score: number } => e != null);

      // Nota por corte: weighted avg de items del corte + asistencia del corte
      const cutGrades = cuts.map((cut) => {
        const items: GradedItem[] = allItems
          .filter((i) => i.cutId === cut.id)
          .map((i) => ({ score: i.score, weight: i.weight }));
        const att = attEntries.find((a) => a.cutId === cut.id);
        if (att) items.push({ score: att.score, weight: att.weight });
        return { cutId: cut.id, grade: computeWeightedGrade(items) };
      });

      // Nota final: weighted avg de TODOS los items + TODAS las asistencias.
      // No es lo mismo que ponderar las notas de los cortes — esto evita
      // doble redondeo/re-escala y respeta exactamente el peso configurado.
      const finalItems: GradedItem[] = [
        ...allItems.map((i) => ({ score: i.score, weight: i.weight })),
        ...attEntries.map((a) => ({ score: a.score, weight: a.weight })),
      ];
      const finalGrade = computeWeightedGrade(finalItems);

      return { student: stu, cutGrades, finalGrade };
    });
  }, [
    selectedCourse,
    cuts,
    students,
    allExams,
    allWorkshops,
    projects,
    examSubs,
    wsSubs,
    projectSubs,
    attSessions,
    attRecords,
  ]);

  // ── Certificados: emitir individual + bulk + descargar ──

  const issueCertForStudent = useCallback(
    async (studentId: string, finalGrade: number | null) => {
      if (!courseId || finalGrade == null) return;
      if (!selectedCourse) return;
      if (finalGrade < selectedCourse.passing_grade) {
        toast.error(
          i18n.t("toast.routes_app_teacher_gradebook.finalGradeBelowPassing", {
            defaultValue: "La nota final es menor al mínimo de aprobación.",
          }),
        );
        return;
      }
      setIssuingId(studentId);
      try {
        const { error } = await db.rpc("issue_certificate", {
          _user_id: studentId,
          _course_id: courseId,
          _final_grade: finalGrade,
        });
        if (error) {
          toast.error(friendlyError(error));
          return;
        }
        toast.success(
          i18n.t("toast.routes_app_teacher_gradebook.certificateIssued", {
            defaultValue: "Certificado emitido",
          }),
        );
        await reloadCertificates();
      } finally {
        setIssuingId(null);
      }
    },
    [courseId, reloadCertificates, selectedCourse],
  );

  /**
   * Regenera el certificado de un estudiante: revoca el vigente y emite
   * uno nuevo con la nota actual. Útil cuando la nota cambió, el snapshot
   * de settings cambió (logo/firma/mensaje) o el docente quiere forzar
   * una nueva emisión.
   *
   * El proceso es atómico-ish: si la emisión nueva falla después de
   * revocar la vieja, mostramos el error y el alumno queda sin
   * certificado vigente (puede re-intentarse).
   */
  const regenerateCertForStudent = useCallback(
    async (studentId: string, finalGrade: number | null) => {
      if (!courseId || finalGrade == null || !selectedCourse) return;
      if (finalGrade < selectedCourse.passing_grade) {
        toast.error(
          i18n.t("toast.routes_app_teacher_gradebook.finalGradeBelowPassing", {
            defaultValue: "La nota final es menor al mínimo de aprobación.",
          }),
        );
        return;
      }
      const existing = certByUserId[studentId];
      if (!existing) {
        toast.info(
          i18n.t("toast.routes_app_teacher_gradebook.noActiveCertToRegenerate", {
            defaultValue: "No hay certificado vigente para regenerar — usa Emitir.",
          }),
        );
        return;
      }
      const ok = await confirm({
        title: t("hc_routesAppTeacherGradebook.regenerateCertTitle"),
        description: t("hc_routesAppTeacherGradebook.regenerateCertDescription", {
          grade: finalGrade.toFixed(2),
        }),
        tone: "warning",
        confirmLabel: t("hc_routesAppTeacherGradebook.regenerate"),
      });
      if (!ok) return;
      setIssuingId(studentId);
      try {
        // 1) Revocar el vigente.
        const { error: revErr } = await db
          .from("certificates")
          .update({ revoked_at: new Date().toISOString(), revoke_reason: "regenerado" })
          .eq("id", existing.id);
        if (revErr) {
          toast.error(
            i18n.t("toast.routes_app_teacher_gradebook.revocationFailed", {
              defaultValue: "Revocación falló: {{error}}",
              error: friendlyError(revErr),
            }),
          );
          return;
        }
        // 2) Emitir uno nuevo.
        const { error: issueErr } = await db.rpc("issue_certificate", {
          _user_id: studentId,
          _course_id: courseId,
          _final_grade: finalGrade,
        });
        if (issueErr) {
          toast.error(
            i18n.t("toast.routes_app_teacher_gradebook.newIssuanceFailed", {
              defaultValue: "Emisión nueva falló: {{error}}",
              error: friendlyError(issueErr),
            }),
          );
          return;
        }
        toast.success(
          i18n.t("toast.routes_app_teacher_gradebook.certificateRegenerated", {
            defaultValue: "Certificado regenerado",
          }),
        );
        await reloadCertificates();
      } finally {
        setIssuingId(null);
      }
    },
    [confirm, courseId, certByUserId, reloadCertificates, selectedCourse],
  );

  const bulkIssueAll = useCallback(async () => {
    if (!selectedCourse || !consolidated) return;
    const candidates = consolidated.filter((r) => {
      if (r.finalGrade == null) return false;
      if (r.finalGrade < selectedCourse.passing_grade) return false;
      if (certByUserId[r.student.id]) return false;
      return true;
    });
    if (candidates.length === 0) {
      toast.info(
        i18n.t("toast.routes_app_teacher_gradebook.noPendingStudents", {
          defaultValue: "Sin estudiantes pendientes: todos los aprobados ya tienen certificado.",
        }),
      );
      return;
    }
    const ok = await confirm({
      title: t("hc_routesAppTeacherGradebook.bulkIssueTitle", { count: candidates.length }),
      description: t("hc_routesAppTeacherGradebook.bulkIssueDescription", {
        course: selectedCourse.name,
      }),
      confirmLabel: t("hc_routesAppTeacherGradebook.issueAll"),
      tone: "warning",
    });
    if (!ok) return;
    setBulkIssuing(true);
    try {
      let issued = 0;
      let failed = 0;
      for (const r of candidates) {
        const { error } = await db.rpc("issue_certificate", {
          _user_id: r.student.id,
          _course_id: courseId,
          _final_grade: r.finalGrade,
        });
        if (error) {
          failed++;
        } else {
          issued++;
        }
      }
      toast.success(
        i18n.t("toast.routes_app_teacher_gradebook.certificatesIssuedBulk", {
          defaultValue: "Emitidos {{issued}}{{failedSuffix}}",
          issued,
          failedSuffix:
            failed > 0
              ? i18n.t("toast.routes_app_teacher_gradebook.certificatesIssuedBulkFailedSuffix", {
                  defaultValue: " · {{count}} fallaron",
                  count: failed,
                })
              : "",
        }),
      );
      await reloadCertificates();
    } finally {
      setBulkIssuing(false);
    }
  }, [confirm, consolidated, courseId, certByUserId, reloadCertificates, selectedCourse]);

  /**
   * Genera + descarga TODOS los certificados del curso en un ZIP único.
   *
   * Dos modos:
   *  - `regenerate = false` (default, "Generar y descargar"): emite los
   *    pendientes y descarga el ZIP con todos los vigentes. NO toca a
   *    los ya emitidos.
   *  - `regenerate = true` ("Regenerar todos"): REVOCA todos los
   *    vigentes y emite uno nuevo por cada aprobado, refrescando el
   *    snapshot (nuevo logo/firma/mensaje + nota actual). Útil cuando
   *    cambió la configuración del curso o las notas finales.
   *
   * El docente confirma una sola vez. Si solo quiere emitir sin descargar
   * (flujo asíncrono), usa el botón "Emitir certificados".
   */
  const bulkGenerateAndDownload = useCallback(
    async (regenerate = false) => {
      if (!selectedCourse || !consolidated) return;
      // Universo de aprobados (válidos para emisión, con o sin cert vigente).
      const approved = consolidated.filter((r) => {
        if (r.finalGrade == null) return false;
        if (r.finalGrade < selectedCourse.passing_grade) return false;
        return true;
      });
      // En modo regenerar, todos los aprobados se vuelven a emitir.
      // En modo normal, solo los pendientes (sin cert vigente activo).
      const targets = regenerate ? approved : approved.filter((r) => !certByUserId[r.student.id]);
      const existingCount = Object.keys(certByUserId).length;
      if (targets.length === 0 && existingCount === 0) {
        toast.info(
          i18n.t("toast.routes_app_teacher_gradebook.noApprovedIssuable", {
            defaultValue: "No hay aprobados con certificado emitible en este curso.",
          }),
        );
        return;
      }
      if (regenerate && approved.length === 0) {
        toast.info(
          i18n.t("toast.routes_app_teacher_gradebook.noApprovedStudents", {
            defaultValue: "No hay estudiantes aprobados en este curso.",
          }),
        );
        return;
      }
      const ok = await confirm({
        title: regenerate
          ? t("hc_routesAppTeacherGradebook.bulkRegenerateTitle", { count: approved.length })
          : t("hc_routesAppTeacherGradebook.bulkGenerateTitle", {
              count: targets.length + existingCount,
            }),
        description: regenerate
          ? t("hc_routesAppTeacherGradebook.bulkRegenerateDescription", {
              count: approved.length,
              course: selectedCourse.name,
            })
          : targets.length > 0
            ? t("hc_routesAppTeacherGradebook.bulkGenerateDescriptionWithIssue", {
                count: targets.length,
                course: selectedCourse.name,
                total: targets.length + existingCount,
              })
            : t("hc_routesAppTeacherGradebook.bulkGenerateDescriptionDownloadOnly", {
                count: existingCount,
                course: selectedCourse.name,
              }),
        confirmLabel: regenerate
          ? t("hc_routesAppTeacherGradebook.regenerateAll")
          : t("hc_routesAppTeacherGradebook.generateAndDownload"),
        tone: "warning",
      });
      if (!ok) return;
      setBulkIssuing(true);
      try {
        // 1a) En modo regenerar, revocar todos los vigentes primero.
        if (regenerate && existingCount > 0) {
          const { error: revErr } = await db
            .from("certificates")
            .update({ revoked_at: new Date().toISOString(), revoke_reason: "regenerado en lote" })
            .eq("course_id", courseId)
            .is("revoked_at", null);
          if (revErr) {
            toast.error(
              i18n.t("toast.routes_app_teacher_gradebook.bulkRevocationFailed", {
                defaultValue: "Revocación masiva falló: {{error}}",
                error: friendlyError(revErr),
              }),
            );
            return;
          }
          // Refrescamos certByUserId — los vigentes ya no están vigentes.
          await reloadCertificates();
        }
        // 1) Emitir los targets.
        let issued = 0;
        let failed = 0;
        for (const r of targets) {
          const { error } = await db.rpc("issue_certificate", {
            _user_id: r.student.id,
            _course_id: courseId,
            _final_grade: r.finalGrade,
          });
          if (error) failed++;
          else issued++;
        }
        // 2) Recargar la lista de certs para incluir los recién emitidos.
        await reloadCertificates();
        // 3) Leer la lista completa desde DB (state actualizado puede no
        //    estar inmediato — preferimos la fuente de verdad).
        const { data: certs, error: certsErr } = await db
          .from("certificates")
          .select("*")
          .eq("course_id", courseId)
          .is("revoked_at", null)
          .order("student_full_name");
        if (certsErr) {
          toast.error(friendlyError(certsErr));
          return;
        }
        const rows = (certs ?? []) as Array<{
          short_code: string;
          student_full_name: string;
          student_identification: string | null;
          course_name: string;
          course_period: string | null;
          final_grade: number;
          grade_scale_max: number;
          teacher_names: string[];
          university_name: string | null;
          university_logo_url: string | null;
          certificate_message: string | null;
          signature_name: string | null;
          signature_title: string | null;
          signature_image_url: string | null;
          footer_text: string | null;
          issued_at: string;
          payload_hash: string;
          revoked_at: string | null;
        }>;
        if (rows.length === 0) {
          toast.info(
            i18n.t("toast.routes_app_teacher_gradebook.noCertsToDownload", {
              defaultValue: "No quedaron certificados para descargar.",
            }),
          );
          return;
        }
        const items = rows.map((c) => ({
          shortCode: c.short_code,
          studentFullName: c.student_full_name,
          studentIdentification: c.student_identification,
          courseName: c.course_name,
          coursePeriod: c.course_period,
          finalGrade: Number(c.final_grade),
          gradeScaleMax: Number(c.grade_scale_max),
          teacherNames: c.teacher_names ?? [],
          universityName: c.university_name,
          universityLogoUrl: c.university_logo_url,
          certificateMessage: c.certificate_message,
          signatureName: c.signature_name,
          signatureTitle: c.signature_title,
          signatureImageUrl: c.signature_image_url,
          footerText: c.footer_text,
          issuedAt: c.issued_at,
          payloadHash: c.payload_hash,
          revokedAt: c.revoked_at,
        }));
        // 4) Generar PDFs + ZIP + descarga.
        const safeCourse = selectedCourse.name.replace(/[^a-z0-9]+/gi, "_").slice(0, 40);
        const today = new Date().toISOString().slice(0, 10);
        await downloadCertificatesZip(items, `Certificados_${safeCourse}_${today}.zip`);
        const issuedMsg =
          issued > 0
            ? i18n.t("toast.routes_app_teacher_gradebook.zipDownloadedIssuedSuffix", {
                defaultValue: " ({{count}} emitido(s))",
                count: issued,
              })
            : "";
        const failedMsg =
          failed > 0
            ? i18n.t("toast.routes_app_teacher_gradebook.zipDownloadedFailedSuffix", {
                defaultValue: " · {{count}} falló al emitir",
                count: failed,
              })
            : "";
        toast.success(
          i18n.t("toast.routes_app_teacher_gradebook.zipDownloaded", {
            defaultValue: "ZIP con {{count}} certificado(s) descargado{{issuedMsg}}{{failedMsg}}",
            count: items.length,
            issuedMsg,
            failedMsg,
          }),
        );
      } catch (e) {
        console.error("[gradebook] bulkGenerateAndDownload failed", e);
        toast.error(friendlyError(e, t("hc_routesAppTeacherGradebook.bulkGenerateError")));
      } finally {
        setBulkIssuing(false);
      }
    },
    [confirm, consolidated, courseId, certByUserId, reloadCertificates, selectedCourse],
  );

  const downloadCertForRow = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (cert: any) => {
      try {
        await downloadCertificate({
          shortCode: cert.short_code,
          studentFullName: cert.student_full_name,
          studentIdentification: cert.student_identification,
          courseName: cert.course_name,
          coursePeriod: cert.course_period,
          finalGrade: Number(cert.final_grade),
          gradeScaleMax: Number(cert.grade_scale_max),
          teacherNames: cert.teacher_names ?? [],
          universityName: cert.university_name,
          universityLogoUrl: cert.university_logo_url,
          certificateMessage: cert.certificate_message,
          signatureName: cert.signature_name,
          signatureTitle: cert.signature_title,
          signatureImageUrl: cert.signature_image_url,
          footerText: cert.footer_text,
          issuedAt: cert.issued_at,
          payloadHash: cert.payload_hash,
          revokedAt: cert.revoked_at,
        });
      } catch (e) {
        toast.error(friendlyError(e, i18n.t("hc_routesAppTeacherGradebook.pdfGenerationError")));
      }
    },
    [],
  );

  /**
   * "Ver como" — el Docente impersonar a un estudiante de uno de sus
   * cursos. Confirmamos antes para evitar clicks accidentales (el flow
   * dispara un full reload y deja al docente "dentro" de la sesión del
   * alumno). El edge function `admin-impersonate` revalida server-side
   * el overlap de cursos, así que aunque el botón aparezca acá nadie
   * puede saltarse el gate haciendo otra petición.
   */
  const handleImpersonateStudent = async (studentId: string, studentName: string) => {
    const ok = await confirm({
      title: t("hc_routesAppTeacherGradebook.impersonateTitle", { name: studentName }),
      description: t("hc_routesAppTeacherGradebook.impersonateDescription"),
      confirmLabel: t("hc_routesAppTeacherGradebook.impersonateConfirm"),
      tone: "warning",
    });
    if (!ok) return;
    try {
      await startImpersonate(studentId);
      // startImpersonate dispara window.location.href → no llegamos aquí.
    } catch (e) {
      toast.error(friendlyError(e, t("hc_routesAppTeacherGradebook.impersonateError")));
    }
  };

  if (authLoading) return null;
  if (!isTeacher)
    return (
      <p className="text-muted-foreground">
        {t("hc_routesAppTeacherGradebook.needTeacherRole")}
      </p>
    );

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={<ClipboardList className="h-6 w-6" />}
          title={t("hc_routesAppTeacherGradebook.pageTitle")}
        />
        <ErrorState
          message={t("hc_routesAppTeacherGradebook.loadErrorMessage")}
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<ClipboardList className="h-6 w-6" />}
        title={t("hc_routesAppTeacherGradebook.pageTitle")}
        subtitle={t("hc_routesAppTeacherGradebook.pageSubtitle")}
        actions={
          <div className="flex flex-wrap gap-2 w-full sm:w-auto">
          <Select value={courseId} onValueChange={setCourseId}>
            <SelectTrigger className="w-full sm:w-56">
              <SelectValue placeholder={t("hc_routesAppTeacherGradebook.coursePlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {courses.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hasEdits && (
            <Button size="sm" onClick={saveAll} disabled={saving}>
              {saving ? (
                <Spinner size="md" className="mr-1" />
              ) : (
                <Save className="h-4 w-4 mr-1" />
              )}
              {t("hc_routesAppTeacherGradebook.saveChanges")}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                <Download className="h-4 w-4 mr-1" />
                {t("hc_routesAppTeacherGradebook.exportLabel", { defaultValue: "Exportar" })}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => exportCourse("csv")}>
                <FileText className="h-4 w-4 mr-2" />
                CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportCourse("xlsx")}>
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                Excel
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Acciones de certificados — agrupadas en dropdown para no
              saturar la toolbar (en mobile las 3 caían en filas separadas
              y opacaban Guardar/CSV). El icono Award + caret marca que
              hay sub-acciones; el dropdown abre con labels descriptivos. */}
          {selectedCourse && consolidated && consolidated.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" disabled={bulkIssuing}>
                  {bulkIssuing ? (
                    <Spinner size="md" className="mr-1" />
                  ) : (
                    <Award className="h-4 w-4 mr-1" />
                  )}
                  {t("hc_routesAppTeacherGradebook.certificates")}
                  <ChevronDown className="h-3.5 w-3.5 ml-1 opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel>
                  {t("hc_routesAppTeacherGradebook.bulkActions")}
                </DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => void bulkIssueAll()}
                  disabled={bulkIssuing}
                  title={t("hc_routesAppTeacherGradebook.issueCertsHint")}
                >
                  <Award className="h-4 w-4 mr-2" />
                  <span className="flex-1">
                    {t("hc_routesAppTeacherGradebook.issueCerts")}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => void bulkGenerateAndDownload(false)}
                  disabled={bulkIssuing}
                  title={t("hc_routesAppTeacherGradebook.generateDownloadBulkHint")}
                >
                  <Download className="h-4 w-4 mr-2" />
                  <span className="flex-1">
                    {t("hc_routesAppTeacherGradebook.generateDownloadBulk")}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => void bulkGenerateAndDownload(true)}
                  disabled={bulkIssuing || Object.keys(certByUserId).length === 0}
                  title={t("hc_routesAppTeacherGradebook.regenerateAllHint")}
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  <span className="flex-1">
                    {t("hc_routesAppTeacherGradebook.regenerateAll")}
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          </div>
        }
      />

      {selectedCourse && (
        <div className="flex flex-wrap items-center gap-4 rounded-md border p-3 bg-muted/30">
          <div className="flex items-center gap-1.5 text-sm">
            <Scale className="h-4 w-4 text-primary" />
            <span className="font-medium">{t("hc_routesAppTeacherGradebook.scaleLabel")}</span>
            <span className="tabular-nums">
              {selectedCourse.grade_scale_min} – {selectedCourse.grade_scale_max}
            </span>
          </div>
          <div className="text-sm text-muted-foreground inline-flex items-center gap-1">
            {t("hc_routesAppTeacherGradebook.passLabel")}{" "}
            <span className="font-medium tabular-nums">{selectedCourse.passing_grade}</span>
          </div>
          <div className="text-sm text-muted-foreground inline-flex items-center gap-1">
            {t("hc_routesAppTeacherGradebook.howFinalGradeCalculated")}
            <HelpHint>
              {t("hc_routesAppTeacherGradebook.finalGradeHelpPrefix")}{" "}
              <strong>{t("hc_routesAppTeacherGradebook.evaluativeCuts")}</strong>{" "}
              {t("hc_routesAppTeacherGradebook.finalGradeHelpSuffix")}
            </HelpHint>
          </div>
        </div>
      )}

      {/* Búsqueda por estudiante — filtra el consolidado, "Sin corte" y
          el modal de detalle. Útil cuando el curso tiene 30-40 alumnos y
          el docente busca uno específico. El CSV exporta TODO igual. */}
      {selectedCourse && students.length > 0 && (
        <SearchInput
          value={studentSearch}
          onChange={setStudentSearch}
          placeholder={t("hc_routesAppTeacherGradebook.searchStudentPlaceholder")}
        />
      )}

      {/* Consolidado por cortes — solo lectura */}
      {selectedCourse && consolidated && cuts.length > 0 && (
        <Card>
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h2 className="text-sm font-semibold inline-flex items-center gap-1.5">
              {t("hc_routesAppTeacherGradebook.consolidatedByCuts")}
              <HelpHint>{t("help.consolidatedByCutsExplanation")}</HelpHint>
            </h2>
            <Badge variant="outline" className="text-[10px]">
              {t("hc_routesAppTeacherGradebook.readOnly")}
            </Badge>
          </div>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-10 bg-card min-w-36 sm:min-w-48">
                    {t("gradebook.studentColumn")}
                  </TableHead>
                  {cuts.map((c, idx) => {
                    const itemCount = (columnsByCut.get(c.id) ?? []).length;
                    // Tinte distintivo por corte para que el ojo siga la
                    // columna correcta cuando hay 3+ cortes. Cycle de 4
                    // tonos suaves que funcionan en light y dark.
                    const TINTS = [
                      "bg-indigo-500/5 dark:bg-indigo-500/10 border-l-2 border-indigo-500/30",
                      "bg-emerald-500/5 dark:bg-emerald-500/10 border-l-2 border-emerald-500/30",
                      "bg-amber-500/5 dark:bg-amber-500/10 border-l-2 border-amber-500/30",
                      "bg-cyan-500/5 dark:bg-cyan-500/10 border-l-2 border-cyan-500/30",
                    ];
                    const tint = TINTS[idx % TINTS.length];
                    return (
                      <TableHead key={c.id} className={`text-center min-w-28 sm:min-w-32 ${tint}`}>
                        <div className="flex flex-col items-center gap-1 py-1">
                          <span
                            className="truncate max-w-28 font-semibold text-foreground"
                            title={c.name}
                          >
                            {c.name}
                          </span>
                          <Badge
                            variant="outline"
                            className="text-[9px] py-0 h-4 px-1.5 bg-background/60"
                          >
                            {c.weight}% ·{" "}
                            {t("hc_routesAppTeacherGradebook.itemCount", { count: itemCount })}
                          </Badge>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[10px] gap-1"
                            onClick={() => setDetailCutId(c.id)}
                            disabled={itemCount === 0}
                            title={
                              itemCount === 0
                                ? t("hc_routesAppTeacherGradebook.noItemsInCut")
                                : t("hc_routesAppTeacherGradebook.viewCutDetailHint")
                            }
                          >
                            <Eye className="h-3 w-3" />
                            {t("hc_routesAppTeacherGradebook.detail")}
                          </Button>
                        </div>
                      </TableHead>
                    );
                  })}
                  <TableHead className="text-center min-w-24 bg-muted/40">
                    {t("gradebook.finalColumn")}
                  </TableHead>
                  <TableHead className="text-center min-w-28 sm:min-w-32">
                    {t("hc_routesAppTeacherGradebook.certificateColumn")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(() => {
                  // Filtra el consolidado por los IDs visibles. Construir
                  // el Set fuera del map evita O(n²) sobre listas grandes.
                  const visibleIds = new Set(filteredStudents.map((s) => s.id));
                  const visible = consolidated.filter((r) => visibleIds.has(r.student.id));
                  if (visible.length === 0) {
                    return (
                      <TableRow>
                        <TableCell
                          colSpan={cuts.length + 3}
                          className="text-center text-muted-foreground py-6 text-sm"
                        >
                          {studentSearch.trim()
                            ? t("hc_routesAppTeacherGradebook.noMatches")
                            : t("hc_routesAppTeacherGradebook.noStudents")}
                        </TableCell>
                      </TableRow>
                    );
                  }
                  return visible.map((row) => {
                    const passes =
                      row.finalGrade != null
                        ? row.finalGrade >= selectedCourse.passing_grade
                        : null;
                    return (
                      <TableRow key={row.student.id}>
                        <TableCell className="sticky left-0 z-10 bg-card max-w-36 sm:max-w-48">
                          <div className="flex items-start gap-1.5">
                            <div className="min-w-0 flex-1">
                              <div
                                className="font-medium text-sm truncate"
                                title={row.student.full_name}
                              >
                                {row.student.full_name}
                              </div>
                              <div
                                className="text-xs text-muted-foreground truncate"
                                title={row.student.institutional_email}
                              >
                                {row.student.institutional_email}
                              </div>
                            </div>
                            {/* "Ver como" — entra a la plataforma con la
                                sesión del estudiante. Útil para reproducir
                                un problema reportado o verificar qué ve el
                                alumno. Server gate (admin-impersonate)
                                revalida el overlap de cursos del Docente. */}
                            <RowAction
                              label={t("hc_routesAppTeacherGradebook.viewAsStudent", {
                                name: row.student.full_name,
                              })}
                              icon={Eye}
                              onClick={() =>
                                void handleImpersonateStudent(
                                  row.student.id,
                                  row.student.full_name,
                                )
                              }
                            />
                          </div>
                        </TableCell>
                        {row.cutGrades.map((cg, ci) => {
                          // Mismo orden de tintes que el header → la columna
                          // quedar visualmente alineada con su corte.
                          const CELL_TINTS = [
                            "bg-indigo-500/[0.03] dark:bg-indigo-500/[0.06] border-l-2 border-indigo-500/20",
                            "bg-emerald-500/[0.03] dark:bg-emerald-500/[0.06] border-l-2 border-emerald-500/20",
                            "bg-amber-500/[0.03] dark:bg-amber-500/[0.06] border-l-2 border-amber-500/20",
                            "bg-cyan-500/[0.03] dark:bg-cyan-500/[0.06] border-l-2 border-cyan-500/20",
                          ];
                          const cellTint = CELL_TINTS[ci % CELL_TINTS.length];
                          // Estado pasable/no pasable de un corte: usamos la
                          // misma referencia (passing_grade del curso) para
                          // resaltar visualmente cuando una nota individual
                          // está por debajo. NO afecta la lógica, solo color.
                          const passesCut =
                            cg.grade != null && cg.grade >= selectedCourse.passing_grade;
                          return (
                            <TableCell
                              key={cg.cutId}
                              className={`text-center text-sm tabular-nums ${cellTint} ${
                                cg.grade == null
                                  ? "text-muted-foreground"
                                  : passesCut
                                    ? "text-emerald-700 dark:text-emerald-400 font-medium"
                                    : "text-amber-700 dark:text-amber-400"
                              }`}
                            >
                              {cg.grade != null ? cg.grade.toFixed(2) : "—"}
                            </TableCell>
                          );
                        })}
                        <TableCell
                          className={`text-center text-sm font-semibold tabular-nums bg-muted/30 ${
                            passes === true
                              ? "text-success"
                              : passes === false
                                ? "text-destructive"
                                : ""
                          }`}
                        >
                          {row.finalGrade != null ? row.finalGrade.toFixed(2) : "—"}
                        </TableCell>
                        <TableCell className="text-center">
                          {(() => {
                            const cert = certByUserId[row.student.id];
                            if (cert) {
                              return (
                                <div className="flex items-center justify-center gap-1">
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] text-emerald-700 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10"
                                  >
                                    {t("hc_routesAppTeacherGradebook.issued")}
                                  </Badge>
                                  <RowAction
                                    label={t("hc_routesAppTeacherGradebook.downloadPdf")}
                                    icon={Download}
                                    onClick={() => void downloadCertForRow(cert)}
                                  />
                                  <RowAction
                                    label={t("hc_routesAppTeacherGradebook.openVerification")}
                                    icon={Eye}
                                    onClick={() => {
                                      window.open(buildVerifyUrl(cert.short_code), "_blank");
                                    }}
                                  />
                                  <RowAction
                                    label={t("hc_routesAppTeacherGradebook.regenerateRowAction")}
                                    icon={RotateCcw}
                                    onClick={() =>
                                      void regenerateCertForStudent(row.student.id, row.finalGrade)
                                    }
                                  />
                                </div>
                              );
                            }
                            if (passes !== true) {
                              return (
                                <span className="text-[11px] text-muted-foreground">
                                  {t("hc_routesAppTeacherGradebook.notPassing")}
                                </span>
                              );
                            }
                            return (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-[11px]"
                                onClick={() =>
                                  void issueCertForStudent(row.student.id, row.finalGrade)
                                }
                                disabled={issuingId === row.student.id}
                              >
                                {issuingId === row.student.id ? (
                                  <Spinner size="xs" className="mr-1" />
                                ) : (
                                  <Award className="h-3 w-3 mr-1" />
                                )}
                                {t("hc_routesAppTeacherGradebook.issue")}
                              </Button>
                            );
                          })()}
                        </TableCell>
                      </TableRow>
                    );
                  });
                })()}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Items sin corte asignado — antes formaban parte del grid grande,
          ahora viven en su propia tarjeta. Items con corte se editan
          desde el modal "Ver detalle" del consolidado. */}
      {uncutColumns.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <Inbox className="h-4 w-4 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold">
                {t("hc_routesAppTeacherGradebook.noCutAssigned")}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t("hc_routesAppTeacherGradebook.noCutAssignedDescription")}
              </p>
            </div>
          </div>
          {renderEditableGrid({
            columns: uncutColumns,
            students: filteredStudents,
            getGrade,
            edits,
            handleEdit,
            cellKey,
            selectedCourse,
          })}
        </Card>
      )}

      {/* Modal de detalle por corte — abre con "Ver detalle" en el header
          del consolidado. Muestra una sub-tabla por tipo (Talleres /
          Exámenes / Proyectos) + una sub-tabla de Asistencia per-student
          calculada desde attendance_sessions/records dentro del rango de
          fechas del corte. Las ediciones comparten el state `edits` y se
          guardan con el botón global "Guardar cambios". */}
      <Dialog
        open={detailCutId != null}
        onOpenChange={(o) => {
          if (!o) setDetailCutId(null);
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-5xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t("hc_routesAppTeacherGradebook.cutDetailTitle", { name: detailCut?.name ?? "" })}
              {detailCut && (
                <Badge variant="outline" className="ml-2 text-[10px]">
                  {detailCut.weight}%
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>
          {detailCut &&
            renderCutDetailGrouped({
              cut: detailCut,
              columns: detailCutColumns,
              students: filteredStudents,
              getGrade,
              selectedCourse,
              attSessions,
              attRecords,
              onOpenStudent: setDetailStudentId,
            })}
        </DialogContent>
      </Dialog>

      {/* Modal anidado: detalle por estudiante DENTRO de un corte. Se
          abre desde el ojo "Ver detalle" en cada fila del modal del corte.
          Muestra cada item del corte para ESE estudiante (workshops,
          exámenes, proyectos editables; asistencia read-only). */}
      <Dialog
        open={detailStudentId != null && detailCutId != null}
        onOpenChange={(o) => {
          if (!o) setDetailStudentId(null);
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {(() => {
                const stu = students.find((x) => x.id === detailStudentId);
                return (
                  <>
                    {t("hc_routesAppTeacherGradebook.studentDetailTitle", {
                      name: stu?.full_name ?? "—",
                    })}
                    {detailCut && (
                      <span className="text-muted-foreground text-sm font-normal ml-2">
                        · {detailCut.name}
                      </span>
                    )}
                  </>
                );
              })()}
            </DialogTitle>
          </DialogHeader>
          {detailCut &&
            detailStudentId &&
            renderStudentCutDetail({
              cut: detailCut,
              columns: detailCutColumns,
              studentId: detailStudentId,
              getGrade,
              edits,
              handleEdit,
              cellKey,
              selectedCourse,
              attSessions,
              attRecords,
            })}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ───────────────────────── Detalle de corte (resumen por bucket) ─────────────────────────
// Vista dentro del modal "Ver detalle del corte X". Resumen de 4 columnas
// (Talleres / Exámenes / Proyectos / Asistencia) por estudiante: cada
// celda es la nota PONDERADA del bucket dentro del corte (en escala del
// curso). Eye button por fila abre un segundo modal con el desglose
// completo (cada item + asistencia) para ese estudiante en el corte.
function renderCutDetailGrouped({
  cut,
  columns,
  students,
  getGrade,
  selectedCourse,
  attSessions,
  attRecords,
  onOpenStudent,
}: {
  cut: Cut;
  columns: GradeColumn[];
  students: Student[];
  getGrade: (
    studentId: string,
    col: GradeColumn,
  ) => { grade: number | null; isMakeup: boolean; status?: string; subId?: string };
  selectedCourse: Course | undefined;
  attSessions: AttSession[];
  attRecords: AttRecord[];
  onOpenStudent: (studentId: string) => void;
}) {
  // Sesiones de este corte usando el FK explícito attendance_sessions.cut_id
  // (migración 20260509020000). Antes se inferiía por rango de fechas.
  const sessionsInCut = attSessions.filter((s) => s.cut_id === cut.id);
  const sessionIdsInCut = new Set(sessionsInCut.map((s) => s.id));
  const recordsBySessionUser = new Map<string, string>();
  for (const r of attRecords) {
    if (sessionIdsInCut.has(r.session_id)) {
      recordsBySessionUser.set(`${r.session_id}::${r.user_id}`, r.status);
    }
  }

  const workshopCols = columns.filter((c) => c.kind === "workshop");
  const examCols = columns.filter((c) => c.kind === "exam");
  const projectCols = columns.filter((c) => c.kind === "project");
  const showWorkshops = workshopCols.length > 0 || Number(cut.workshop_weight ?? 0) > 0;
  const showExams = examCols.length > 0 || Number(cut.exam_weight ?? 0) > 0;
  const showProjects = projectCols.length > 0 || Number(cut.project_weight ?? 0) > 0;
  const showAttendance = Number(cut.attendance_weight ?? 0) > 0;

  if (
    workshopCols.length === 0 &&
    examCols.length === 0 &&
    projectCols.length === 0 &&
    !showAttendance
  ) {
    return (
      <p className="text-sm text-muted-foreground py-6 text-center">
        {i18n.t("hc_routesAppTeacherGradebook.cutNoActivities")}
      </p>
    );
  }

  // Subtotal de un bucket = promedio simple de notas de los items de
  // ese tipo en este corte, escaladas a la escala del curso
  // (0..grade_scale_max). Workshops/proyectos no externos vienen en
  // 0..max_score (típicamente 0..100), así que hay que reescalar antes
  // de promediar para que un curso con escala 0–5 no muestre 93.00.
  const courseMax = selectedCourse?.grade_scale_max ?? 100;
  const courseMin = selectedCourse?.grade_scale_min ?? 0;
  const scaleToCourse = (col: GradeColumn, raw: number): number => {
    // Exámenes y externos ya están en escala del curso.
    if (col.kind === "exam" || col.isExternal) return raw;
    const rawMax = col.maxScore ?? 100;
    const pct = rawMax > 0 ? raw / rawMax : 0;
    return courseMin + pct * (courseMax - courseMin);
  };
  const bucketAvg = (studentId: string, cols: GradeColumn[]): number | null => {
    const grades = cols
      .map((c) => {
        const g = getGrade(studentId, c).grade;
        return g != null ? scaleToCourse(c, g) : null;
      })
      .filter((g): g is number => g != null);
    if (grades.length === 0) return null;
    return grades.reduce((s, g) => s + g, 0) / grades.length;
  };

  // Asistencia por estudiante para este corte.
  const attendanceFor = (studentId: string) => {
    const present = sessionsInCut.filter(
      (ses) => recordsBySessionUser.get(`${ses.id}::${studentId}`) === "presente",
    ).length;
    const total = sessionsInCut.length;
    const pct = total > 0 ? present / total : 0;
    const nota =
      selectedCourse && total > 0
        ? selectedCourse.grade_scale_min +
          pct * (selectedCourse.grade_scale_max - selectedCourse.grade_scale_min)
        : null;
    return { present, total, nota };
  };

  // Chips de resumen de pesos arriba del grid.
  const bucketSummary = [
    {
      label: i18n.t("hc_routesAppTeacherGradebook.workshops"),
      icon: Hammer,
      weight: Number(cut.workshop_weight ?? 0) || 0,
    },
    {
      label: i18n.t("hc_routesAppTeacherGradebook.exams"),
      icon: FileText,
      weight: Number(cut.exam_weight ?? 0) || 0,
    },
    {
      label: i18n.t("hc_routesAppTeacherGradebook.projects"),
      icon: FolderKanban,
      weight: Number(cut.project_weight ?? 0) || 0,
    },
    {
      label: i18n.t("hc_routesAppTeacherGradebook.attendance"),
      icon: CalendarCheck,
      weight: Number(cut.attendance_weight ?? 0) || 0,
    },
  ].filter((b) => b.weight > 0);

  return (
    <div className="space-y-3">
      {bucketSummary.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2">
          <span className="text-[11px] text-muted-foreground">
            {i18n.t("hc_routesAppTeacherGradebook.cutBuckets")}
          </span>
          {bucketSummary.map((b) => (
            <Badge key={b.label} variant="outline" className="text-[10px] gap-1 py-0 h-5">
              <b.icon className="h-3 w-3" />
              {b.label}: {b.weight.toFixed(1)}%
            </Badge>
          ))}
        </div>
      )}

      <div className="rounded-md border overflow-hidden">
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 bg-card min-w-36 sm:min-w-48">
                  {i18next.t("gradebook.studentColumn")}
                </TableHead>
                {showWorkshops && (
                  <TableHead className="text-center min-w-28">
                    <div className="inline-flex items-center gap-1">
                      <Hammer className="h-3 w-3 text-amber-500 dark:text-amber-400" />
                      {i18n.t("hc_routesAppTeacherGradebook.workshops")}
                    </div>
                  </TableHead>
                )}
                {showExams && (
                  <TableHead className="text-center min-w-28">
                    <div className="inline-flex items-center gap-1">
                      <FileText className="h-3 w-3 text-primary" />
                      {i18n.t("hc_routesAppTeacherGradebook.exams")}
                    </div>
                  </TableHead>
                )}
                {showProjects && (
                  <TableHead className="text-center min-w-28">
                    <div className="inline-flex items-center gap-1">
                      <FolderKanban className="h-3 w-3 text-indigo-500 dark:text-indigo-400" />
                      {i18n.t("hc_routesAppTeacherGradebook.projects")}
                    </div>
                  </TableHead>
                )}
                {showAttendance && (
                  <TableHead className="text-center min-w-28 bg-amber-400/5">
                    <div className="inline-flex items-center gap-1">
                      <CalendarCheck className="h-3 w-3 text-primary" />
                      {i18n.t("hc_routesAppTeacherGradebook.attendance")}
                    </div>
                  </TableHead>
                )}
                <TableHead className="text-right w-[1%]">
                  {i18next.t("gradebook.detailColumn")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {students.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={
                      1 +
                      (showWorkshops ? 1 : 0) +
                      (showExams ? 1 : 0) +
                      (showProjects ? 1 : 0) +
                      (showAttendance ? 1 : 0) +
                      1
                    }
                    className="text-center text-muted-foreground py-8"
                  >
                    {i18n.t("hc_routesAppTeacherGradebook.noEnrolledStudents")}
                  </TableCell>
                </TableRow>
              )}
              {students.map((s) => {
                const wAvg = bucketAvg(s.id, workshopCols);
                const eAvg = bucketAvg(s.id, examCols);
                const pAvg = bucketAvg(s.id, projectCols);
                const att = attendanceFor(s.id);
                return (
                  <TableRow key={s.id}>
                    <TableCell className="sticky left-0 z-10 bg-card">
                      <div className="font-medium text-sm">{s.full_name}</div>
                      <div className="text-xs text-muted-foreground">{s.institutional_email}</div>
                    </TableCell>
                    {showWorkshops && (
                      <TableCell className="text-center text-sm tabular-nums">
                        {wAvg != null ? wAvg.toFixed(2) : "—"}
                      </TableCell>
                    )}
                    {showExams && (
                      <TableCell className="text-center text-sm tabular-nums">
                        {eAvg != null ? eAvg.toFixed(2) : "—"}
                      </TableCell>
                    )}
                    {showProjects && (
                      <TableCell className="text-center text-sm tabular-nums">
                        {pAvg != null ? pAvg.toFixed(2) : "—"}
                      </TableCell>
                    )}
                    {showAttendance && (
                      <TableCell className="text-center bg-amber-400/5">
                        {att.total > 0 ? (
                          <div className="flex flex-col items-center gap-0.5">
                            <span className="text-sm tabular-nums font-medium">
                              {att.nota != null ? att.nota.toFixed(2) : "—"}
                            </span>
                            <span className="text-[10px] text-muted-foreground tabular-nums">
                              {att.present}/{att.total}
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </TableCell>
                    )}
                    <TableCell className="text-right">
                      <RowAction
                        label={i18n.t("hc_routesAppTeacherGradebook.viewStudentDetail")}
                        icon={Eye}
                        onClick={() => onOpenStudent(s.id)}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </div>

      {showAttendance && sessionsInCut.length === 0 && (
        <p className="text-[11px] text-muted-foreground italic">
          {i18n.t("hc_routesAppTeacherGradebook.noAttendanceSessionsHint")}
        </p>
      )}
    </div>
  );
}

// ───────────────────────── Detalle por estudiante (modal anidado) ─────────────────────────
// Render del modal interno que se abre desde el ojo "Ver detalle" en
// cada fila del modal del corte. Lista CADA item del corte (workshops,
// exámenes, proyectos) para ESE estudiante con su nota editable, más
// la fila de asistencia con presentes/total/nota (read-only).
function renderStudentCutDetail({
  cut,
  columns,
  studentId,
  getGrade,
  edits,
  handleEdit,
  cellKey,
  selectedCourse,
  attSessions,
  attRecords,
}: {
  cut: Cut;
  columns: GradeColumn[];
  studentId: string;
  getGrade: (
    studentId: string,
    col: GradeColumn,
  ) => { grade: number | null; isMakeup: boolean; status?: string; subId?: string };
  edits: EditMap;
  handleEdit: (studentId: string, colId: string, value: string) => void;
  cellKey: (studentId: string, colId: string) => string;
  selectedCourse: Course | undefined;
  attSessions: AttSession[];
  attRecords: AttRecord[];
}) {
  // Filtro por cut_id explícito (migración 20260509020000).
  const sessionsInCut = attSessions.filter((s) => s.cut_id === cut.id);
  const presentCount = sessionsInCut.filter(
    (ses) =>
      attRecords.find((r) => r.session_id === ses.id && r.user_id === studentId)?.status ===
      "presente",
  ).length;
  const totalSess = sessionsInCut.length;
  const attPct = totalSess > 0 ? presentCount / totalSess : 0;
  const attNota =
    selectedCourse && totalSess > 0
      ? selectedCourse.grade_scale_min +
        attPct * (selectedCourse.grade_scale_max - selectedCourse.grade_scale_min)
      : null;

  const sectionDef: Array<{
    key: "workshop" | "exam" | "project";
    label: string;
    icon: typeof FileText;
    cols: GradeColumn[];
    bucketWeight: number;
  }> = [
    {
      key: "workshop",
      label: i18n.t("hc_routesAppTeacherGradebook.workshops"),
      icon: Hammer,
      cols: columns.filter((c) => c.kind === "workshop"),
      bucketWeight: Number(cut.workshop_weight ?? 0) || 0,
    },
    {
      key: "exam",
      label: i18n.t("hc_routesAppTeacherGradebook.exams"),
      icon: FileText,
      cols: columns.filter((c) => c.kind === "exam"),
      bucketWeight: Number(cut.exam_weight ?? 0) || 0,
    },
    {
      key: "project",
      label: i18n.t("hc_routesAppTeacherGradebook.projects"),
      icon: FolderKanban,
      cols: columns.filter((c) => c.kind === "project"),
      bucketWeight: Number(cut.project_weight ?? 0) || 0,
    },
  ];

  return (
    <div className="space-y-4">
      {sectionDef.map((sec) => {
        if (sec.cols.length === 0) return null;
        return (
          <div key={sec.key} className="rounded-md border overflow-hidden">
            <div className="flex items-center justify-between gap-2 bg-muted/40 px-3 py-2 border-b">
              <div className="flex items-center gap-2">
                <sec.icon className="h-3.5 w-3.5 text-primary" />
                <span className="text-sm font-medium">{sec.label}</span>
                <span className="text-[11px] text-muted-foreground">
                  {i18n.t("hc_routesAppTeacherGradebook.activityCount", {
                    count: sec.cols.length,
                  })}
                </span>
              </div>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {i18n.t("hc_routesAppTeacherGradebook.bucketWeight", {
                  weight: sec.bucketWeight.toFixed(1),
                })}
              </span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{i18next.t("gradebook.activityColumn")}</TableHead>
                  <TableHead className="text-right w-32">
                    <span className="inline-flex items-center justify-end gap-1">
                      {i18n.t("hc_routesAppTeacherGradebook.grade")}
                      <HelpHint side="top">
                        {i18n.t("hc_routesAppTeacherGradebook.courseScaleLabel")}{" "}
                        <strong>
                          {selectedCourse?.grade_scale_min ?? 0}–
                          {selectedCourse?.grade_scale_max ?? "—"}
                        </strong>
                        . {i18n.t("hc_routesAppTeacherGradebook.gradeHelpWorkshopsProjects")}{" "}
                        <em>{i18n.t("hc_routesAppTeacherGradebook.itemMaxScore")}</em>{" "}
                        {i18n.t("hc_routesAppTeacherGradebook.gradeHelpDecimals")}
                      </HelpHint>
                    </span>
                  </TableHead>
                  <TableHead className="w-24 text-center">
                    {i18n.t("hc_routesAppTeacherGradebook.status")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sec.cols.map((col) => {
                  const g = getGrade(studentId, col);
                  const key = cellKey(studentId, col.id);
                  const isEditing = key in edits;
                  const displayGrade = isEditing
                    ? edits[key]
                    : g.grade != null
                      ? String(g.grade)
                      : "";
                  return (
                    <TableRow key={col.id}>
                      <TableCell className="font-medium text-sm">
                        {col.title}
                        {col.maxScore != null && (
                          <span className="text-[10px] text-muted-foreground ml-1">
                            (/{col.maxScore})
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {g.subId ? (
                          <DecimalInput
                            min={selectedCourse?.grade_scale_min ?? 0}
                            max={
                              col.kind === "exam"
                                ? (selectedCourse?.grade_scale_max ?? 100)
                                : (col.maxScore ?? 100)
                            }
                            value={
                              displayGrade === "" ? null : Number(displayGrade.replace(",", "."))
                            }
                            onChange={(v) =>
                              handleEdit(studentId, col.id, v == null ? "" : String(v))
                            }
                            placeholder="—"
                            className="h-8 w-24 ml-auto text-right text-sm tabular-nums"
                          />
                        ) : g.grade != null ? (
                          <span className="text-sm tabular-nums font-medium">
                            {Number(g.grade).toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="inline-flex items-center justify-center gap-1">
                          {g.isMakeup && (
                            <Badge variant="outline" className="text-[9px] py-0 h-4 px-1">
                              <GitBranch className="h-2.5 w-2.5 mr-0.5" /> S
                            </Badge>
                          )}
                          {g.status === "sospechoso" && (
                            <span
                              title={i18n.t("hc_routesAppTeacherGradebook.suspicious")}
                              className="inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-destructive/40 bg-destructive/10 text-destructive"
                            >
                              <AlertTriangle className="h-3 w-3" />
                            </span>
                          )}
                          {!g.isMakeup && g.status !== "sospechoso" && (
                            <span className="text-[10px] text-muted-foreground">—</span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        );
      })}

      {Number(cut.attendance_weight ?? 0) > 0 && (
        <div className="rounded-md border overflow-hidden">
          <div className="flex items-center justify-between gap-2 bg-amber-400/5 px-3 py-2 border-b">
            <div className="flex items-center gap-2">
              <CalendarCheck className="h-3.5 w-3.5 text-primary" />
              <span className="text-sm font-medium">
                {i18n.t("hc_routesAppTeacherGradebook.attendance")}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {i18n.t("hc_routesAppTeacherGradebook.sessionsInCutRange", { count: totalSess })}
              </span>
            </div>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {i18n.t("hc_routesAppTeacherGradebook.bucketWeight", {
                weight: Number(cut.attendance_weight ?? 0).toFixed(1),
              })}
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">
                  {i18n.t("hc_routesAppTeacherGradebook.sessionsPresent")}
                </TableHead>
                <TableHead className="text-right">
                  {i18n.t("hc_routesAppTeacherGradebook.totalSessions")}
                </TableHead>
                <TableHead className="text-right">
                  {i18n.t("hc_routesAppTeacherGradebook.attendancePct")}
                </TableHead>
                {selectedCourse && (
                  <TableHead className="text-right">
                    {i18n.t("hc_routesAppTeacherGradebook.gradeWithScale", {
                      min: selectedCourse.grade_scale_min,
                      max: selectedCourse.grade_scale_max,
                    })}
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {totalSess === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={selectedCourse ? 4 : 3}
                    className="text-center text-muted-foreground py-4 text-xs italic"
                  >
                    {i18n.t("hc_routesAppTeacherGradebook.noAttendanceSessionsInCut")}
                  </TableCell>
                </TableRow>
              ) : (
                <TableRow>
                  <TableCell className="text-right tabular-nums">{presentCount}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {totalSess}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {Math.round(attPct * 100)}%
                  </TableCell>
                  {selectedCourse && (
                    <TableCell className="text-right tabular-nums font-medium">
                      {attNota != null ? attNota.toFixed(2) : "—"}
                    </TableCell>
                  )}
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground italic">
        {i18n.t("hc_routesAppTeacherGradebook.editsAccumulateHint")}
      </p>
    </div>
  );
}

// ───────────────────────── Editable grid (compartida) ─────────────────────────
// Antes la grilla estaba inline en el JSX. La extraímos para reutilizar entre
// "Sin corte asignado" y el modal de Ver detalle por corte.
function renderEditableGrid({
  columns,
  students,
  getGrade,
  edits,
  handleEdit,
  cellKey,
  selectedCourse,
}: {
  columns: GradeColumn[];
  students: Student[];
  getGrade: (
    studentId: string,
    col: GradeColumn,
  ) => { grade: number | null; isMakeup: boolean; status?: string; subId?: string };
  edits: EditMap;
  handleEdit: (studentId: string, colId: string, value: string) => void;
  cellKey: (studentId: string, colId: string) => string;
  selectedCourse: Course | undefined;
}) {
  return (
    <CardContent className="p-0 overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-10 bg-card min-w-36 sm:min-w-48">
              <span className="inline-flex items-center gap-1.5">
                {i18n.t("hc_routesAppTeacherGradebook.student")}
                <HelpHint side="bottom" align="start">
                  <strong>{i18n.t("hc_routesAppTeacherGradebook.courseScaleLabel")}</strong>{" "}
                  {selectedCourse?.grade_scale_min ?? 0}–
                  {selectedCourse?.grade_scale_max ?? "—"}.{" "}
                  {i18n.t("hc_routesAppTeacherGradebook.gridHelpExamsPrefix")}{" "}
                  <strong>{i18n.t("hc_routesAppTeacherGradebook.exams")}</strong>{" "}
                  {i18n.t("hc_routesAppTeacherGradebook.gridHelpExamsSuffix")}{" "}
                  <strong>{i18n.t("hc_routesAppTeacherGradebook.workshops")}</strong>{" "}
                  {i18n.t("hc_routesAppTeacherGradebook.gridHelpAnd")}{" "}
                  <strong>{i18n.t("hc_routesAppTeacherGradebook.projects")}</strong>
                  {i18n.t("hc_routesAppTeacherGradebook.gridHelpProjectsSuffix")}{" "}
                  <em>{i18n.t("hc_routesAppTeacherGradebook.itemMaxScore")}</em>{" "}
                  {i18n.t("hc_routesAppTeacherGradebook.gradeHelpDecimals")}
                </HelpHint>
              </span>
            </TableHead>
            {columns.map((col) => (
              <TableHead key={col.id} className="text-center min-w-28">
                <div className="flex flex-col items-center gap-0.5">
                  <div className="flex items-center gap-1">
                    {col.kind === "exam" ? (
                      <FileText className="h-3 w-3 text-primary shrink-0" />
                    ) : col.kind === "workshop" ? (
                      <Hammer className="h-3 w-3 text-amber-500 dark:text-amber-400 shrink-0" />
                    ) : (
                      <FolderKanban className="h-3 w-3 text-indigo-500 dark:text-indigo-400 shrink-0" />
                    )}
                    <span className="truncate max-w-24" title={col.title}>
                      {col.title}
                    </span>
                  </div>
                  <Badge variant="outline" className="text-[9px] py-0 h-3.5">
                    {col.kind === "exam"
                      ? i18n.t("hc_routesAppTeacherGradebook.examBadge", {
                          max: selectedCourse?.grade_scale_max ?? 5,
                        })
                      : col.kind === "workshop"
                        ? i18n.t("hc_routesAppTeacherGradebook.workshopBadge", {
                            max: col.maxScore ?? 100,
                          })
                        : i18n.t("hc_routesAppTeacherGradebook.projectBadge", {
                            max: col.maxScore ?? 100,
                          })}
                  </Badge>
                </div>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {students.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={columns.length + 1}
                className="text-center text-muted-foreground py-8"
              >
                {i18n.t("hc_routesAppTeacherGradebook.noEnrolledStudents")}
              </TableCell>
            </TableRow>
          )}
          {students.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="sticky left-0 z-10 bg-card">
                <div className="font-medium text-sm">{s.full_name}</div>
                <div className="text-xs text-muted-foreground">{s.institutional_email}</div>
              </TableCell>
              {columns.map((col) => {
                const g = getGrade(s.id, col);
                const key = cellKey(s.id, col.id);
                const isEditing = key in edits;
                const displayGrade = isEditing
                  ? edits[key]
                  : g.grade != null
                    ? String(g.grade)
                    : "";

                return (
                  <TableCell key={col.id} className="text-center p-1">
                    {g.subId ? (
                      <div className="relative">
                        <DecimalInput
                          min={selectedCourse?.grade_scale_min ?? 0}
                          max={
                            col.kind === "workshop"
                              ? (col.maxScore ?? 100)
                              : (selectedCourse?.grade_scale_max ?? 100)
                          }
                          value={
                            displayGrade === "" ? null : Number(displayGrade.replace(",", "."))
                          }
                          onChange={(v) => handleEdit(s.id, col.id, v == null ? "" : String(v))}
                          placeholder="—"
                          className="h-8 w-20 mx-auto text-center text-sm tabular-nums"
                        />
                        <div className="flex min-h-[1.125rem] items-center justify-center gap-1 mt-0.5">
                          {g.isMakeup && (
                            <Badge
                              variant="outline"
                              className="text-[8px] py-0 h-4 px-1 inline-flex items-center gap-0.5"
                            >
                              <GitBranch className="h-2.5 w-2.5 shrink-0" aria-hidden />S
                            </Badge>
                          )}
                          {g.status === "sospechoso" && (
                            <span
                              title={i18n.t("hc_routesAppTeacherGradebook.suspiciousAttemptHint")}
                              className="inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-destructive/40 bg-destructive/10 text-destructive"
                            >
                              <AlertTriangle className="h-3 w-3" strokeWidth={2} aria-hidden />
                            </span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardContent>
  );
}
