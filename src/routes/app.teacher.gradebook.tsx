import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { HelpHint } from "@/components/ui/help-hint";
import { RowAction } from "@/components/ui/row-action";
import { Input } from "@/components/ui/input";
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
  Hammer,
  Save,
  Loader2,
  Scale,
  AlertTriangle,
  Eye,
  Inbox,
  FolderKanban,
  CalendarCheck,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { downloadCSV, toCSV } from "@/lib/csv";
import { computeWeightedGrade, type GradedItem } from "@/utils/grade";
import { computeAttemptGrade, type RetryMode } from "@/utils/exam-attempts";

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
type AttSession = { id: string; session_date: string };
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
};

/** Editable grade cell keyed by `${studentId}::${columnId}` */
type EditMap = Record<string, string>;

function Gradebook() {
  const { roles } = useAuth();
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState<string>("");
  const [columns, setColumns] = useState<GradeColumn[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
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
  const isTeacher = roles.includes("Docente") || roles.includes("Admin");

  // Load courses
  useEffect(() => {
    supabase
      .from("courses")
      .select(
        "id, name, grade_scale_min, grade_scale_max, passing_grade, exam_weight, workshop_weight",
      )
      .order("name")
      .then(({ data }) => {
        setCourses(data ?? []);
        if (data?.[0]) setCourseId(data[0].id);
      });
  }, []);

  // Load data for selected course
  const loadCourse = useCallback(async () => {
    if (!courseId) return;

    // Exams (incluye cut_id para el consolidado de cortes)
    const { data: exams } = await (supabase as any)
      .from("exams")
      .select("id, title, parent_exam_id, course_id, cut_id, weight, retry_mode")
      .eq("course_id", courseId)
      .order("start_time");

    // Workshops
    const { data: workshops } = await supabase
      .from("workshops")
      .select("id, title, course_id, max_score, cut_id, weight, is_external")
      .eq("course_id", courseId)
      .order("created_at");

    // Cortes evaluativos
    const { data: cutsData } = await db
      .from("grade_cuts")
      .select(
        "id, name, position, start_date, end_date, weight, workshop_weight, exam_weight, project_weight, attendance_weight",
      )
      .eq("course_id", courseId)
      .order("position");

    // Proyectos
    const { data: projectsData } = await db
      .from("projects")
      .select("id, title, course_id, max_score, cut_id, weight, is_external")
      .eq("course_id", courseId);

    // Sesiones de asistencia
    const { data: sessions } = await db
      .from("attendance_sessions")
      .select("id, session_date")
      .eq("course_id", courseId);

    setAllExams((exams ?? []) as Exam[]);
    setAllWorkshops((workshops ?? []) as Workshop[]);
    setCuts((cutsData ?? []) as Cut[]);
    setProjects((projectsData ?? []) as Project[]);
    setAttSessions((sessions ?? []) as AttSession[]);

    // Build columns: original exams (no parent) + workshops + projects
    const examCols: GradeColumn[] = ((exams ?? []) as Exam[])
      .filter((e) => !e.parent_exam_id)
      .map((e) => ({ id: e.id, title: e.title, kind: "exam" as const, parentExamId: null }));

    const wsCols: GradeColumn[] = ((workshops ?? []) as Workshop[]).map((w) => ({
      id: w.id,
      title: w.title,
      kind: "workshop" as const,
      maxScore: w.max_score,
    }));

    const prjCols: GradeColumn[] = ((projectsData ?? []) as Project[]).map((p) => ({
      id: p.id,
      title: p.title,
      kind: "project" as const,
      maxScore: p.max_score,
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
        .select("id, full_name, institutional_email, personal_email")
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
      toast.info("No hay cambios para guardar");
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
          else saved++;
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
          else saved++;
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
    if (saved > 0) toast.success(`${saved} calificación(es) guardada(s) correctamente`);
    if (errors > 0) toast.error(`${errors} error(es) — solo se pueden editar entregas existentes`);
    setEdits({});
    loadCourse();
  };

  // Export CSV
  const exportCourse = () => {
    if (!students.length || !columns.length) {
      toast.info("No hay datos para exportar");
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

    const csvRows = students.map((s) => {
      const row: Record<string, string> = {
        nombre: s.full_name,
        email_institucional: s.institutional_email,
        email_personal: s.personal_email ?? "",
      };
      // Detalle item por item (exámenes y talleres con su nota cruda).
      columns.forEach((col) => {
        const g = getGrade(s.id, col);
        const prefix = col.kind === "workshop" ? "[T] " : "";
        const label = `${prefix}${col.title}`;
        if (g.grade != null) {
          row[label] = `${g.grade}${g.isMakeup ? " (S)" : ""}`;
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
      row["Calificación final"] = fmt(stuConsolidated?.finalGrade ?? null);
      return row;
    });

    const courseName = courses.find((c) => c.id === courseId)?.name ?? "curso";
    downloadCSV(
      `calificaciones-${courseName.replace(/\s+/g, "_")}-${Date.now()}.csv`,
      toCSV(csvRows),
    );
    toast.success("Archivo exportado correctamente");
  };

  const hasEdits = Object.values(edits).some((v) => v !== "");
  const selectedCourse = courses.find((c) => c.id === courseId);

  // Agrupa columnas (exámenes + talleres) por corte para que la grilla
  // editable se separe en "items dentro de un corte" (visibles solo en
  // el modal de Ver detalle) vs "items sin corte" (visibles en su
  // propia card debajo del consolidado).
  const columnsByCut = useMemo(() => {
    const map = new Map<string | null, GradeColumn[]>();
    for (const col of columns) {
      let cutId: string | null = null;
      if (col.kind === "exam") {
        const exam = allExams.find((e) => e.id === col.id);
        cutId = exam?.cut_id ?? null;
      } else if (col.kind === "workshop") {
        const ws = allWorkshops.find((w) => w.id === col.id);
        cutId = ws?.cut_id ?? null;
      } else {
        const pr = projects.find((p) => p.id === col.id);
        cutId = pr?.cut_id ?? null;
      }
      const arr = map.get(cutId) ?? [];
      arr.push(col);
      map.set(cutId, arr);
    }
    return map;
  }, [columns, allExams, allWorkshops, projects]);

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
          if (!cut.start_date || !cut.end_date) return null;
          const sessionsInCut = attSessions.filter(
            (s) => s.session_date >= cut.start_date! && s.session_date <= cut.end_date!,
          );
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

  if (!isTeacher) return <p className="text-muted-foreground">Necesitas rol Docente.</p>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Calificaciones</h1>
          <p className="text-sm text-muted-foreground">
            Exámenes y talleres del curso · Haz clic en una celda para editar
          </p>
        </div>
        <div className="flex flex-wrap gap-2 w-full sm:w-auto">
          <Select value={courseId} onValueChange={setCourseId}>
            <SelectTrigger className="w-full sm:w-56">
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
          {hasEdits && (
            <Button size="sm" onClick={saveAll} disabled={saving}>
              {saving ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-1" />
              )}
              Guardar cambios
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={exportCourse}>
            <Download className="h-4 w-4 mr-1" />
            CSV
          </Button>
        </div>
      </div>

      {selectedCourse && (
        <div className="flex flex-wrap items-center gap-4 rounded-md border p-3 bg-muted/30">
          <div className="flex items-center gap-1.5 text-sm">
            <Scale className="h-4 w-4 text-primary" />
            <span className="font-medium">Escala:</span>
            <span className="tabular-nums">
              {selectedCourse.grade_scale_min} – {selectedCourse.grade_scale_max}
            </span>
          </div>
          <div className="text-sm text-muted-foreground inline-flex items-center gap-1">
            Aprobar ≥{" "}
            <span className="font-medium tabular-nums">{selectedCourse.passing_grade}</span>
          </div>
          <div className="text-sm text-muted-foreground inline-flex items-center gap-1">
            ¿Cómo se calcula la nota final?
            <HelpHint>
              La calificación final del curso se calcula desde los{" "}
              <strong>cortes evaluativos</strong> configurados (Curso → Cortes → [Talleres,
              Exámenes, Proyectos, Asistencia]). Los estudiantes ven el consolidado en su vista de
              Calificaciones.
            </HelpHint>
          </div>
        </div>
      )}

      {/* Consolidado por cortes — solo lectura */}
      {selectedCourse && consolidated && cuts.length > 0 && (
        <Card>
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h2 className="text-sm font-semibold inline-flex items-center gap-1.5">
              Consolidado por cortes
              <HelpHint>
                Curso → Σ(Cortes × peso) → Σ(Talleres, Exámenes, Proyectos, Asistencia × peso). Esta
                vista es solo lectura — los pesos se editan en Cursos → Cortes.
              </HelpHint>
            </h2>
            <Badge variant="outline" className="text-[10px]">
              Solo lectura
            </Badge>
          </div>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-10 bg-card min-w-48">Estudiante</TableHead>
                  {cuts.map((c) => {
                    const itemCount = (columnsByCut.get(c.id) ?? []).length;
                    return (
                      <TableHead key={c.id} className="text-center min-w-32">
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="truncate max-w-28" title={c.name}>
                            {c.name}
                          </span>
                          <Badge variant="outline" className="text-[9px] py-0 h-3.5">
                            {c.weight}%
                          </Badge>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[10px] gap-1 mt-0.5"
                            onClick={() => setDetailCutId(c.id)}
                            disabled={itemCount === 0}
                            title={
                              itemCount === 0
                                ? "Sin items asignados a este corte"
                                : "Ver detalle del corte"
                            }
                          >
                            <Eye className="h-3 w-3" />
                            Ver detalle
                          </Button>
                        </div>
                      </TableHead>
                    );
                  })}
                  <TableHead className="text-center min-w-24 bg-muted/40">Final</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {consolidated.map((row) => {
                  const passes =
                    row.finalGrade != null ? row.finalGrade >= selectedCourse.passing_grade : null;
                  return (
                    <TableRow key={row.student.id}>
                      <TableCell className="sticky left-0 z-10 bg-card">
                        <div className="font-medium text-sm">{row.student.full_name}</div>
                        <div className="text-xs text-muted-foreground">
                          {row.student.institutional_email}
                        </div>
                      </TableCell>
                      {row.cutGrades.map((cg) => (
                        <TableCell key={cg.cutId} className="text-center text-sm tabular-nums">
                          {cg.grade != null ? cg.grade.toFixed(2) : "—"}
                        </TableCell>
                      ))}
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
                    </TableRow>
                  );
                })}
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
              <h2 className="text-sm font-semibold">Sin corte asignado</h2>
              <p className="text-xs text-muted-foreground">
                Estos items no están vinculados a ningún corte. No suman al consolidado pero se
                pueden calificar para llevar registro.
              </p>
            </div>
          </div>
          {renderEditableGrid({
            columns: uncutColumns,
            students,
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
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Detalle del corte: {detailCut?.name}
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
              students,
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
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {(() => {
                const stu = students.find((x) => x.id === detailStudentId);
                return (
                  <>
                    Detalle: {stu?.full_name ?? "—"}
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
  // Sesiones de este corte (entre start_date y end_date).
  const sessionsInCut = (() => {
    if (!cut.start_date || !cut.end_date) return [];
    return attSessions.filter(
      (s) => s.session_date >= cut.start_date! && s.session_date <= cut.end_date!,
    );
  })();
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
        Este corte no tiene actividades ni asistencia configuradas todavía.
      </p>
    );
  }

  // Subtotal de un bucket = promedio simple de notas de los items de
  // ese tipo en este corte (todas ya escaladas a 0..grade_scale_max por
  // getGrade). Items sin nota se omiten (no penalizan); si todos están
  // sin nota, el subtotal es null y se muestra "—".
  const bucketAvg = (studentId: string, cols: GradeColumn[]): number | null => {
    const grades = cols
      .map((c) => getGrade(studentId, c).grade)
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
    { label: "Talleres", icon: Hammer, weight: Number(cut.workshop_weight ?? 0) || 0 },
    { label: "Exámenes", icon: FileText, weight: Number(cut.exam_weight ?? 0) || 0 },
    { label: "Proyectos", icon: FolderKanban, weight: Number(cut.project_weight ?? 0) || 0 },
    {
      label: "Asistencia",
      icon: CalendarCheck,
      weight: Number(cut.attendance_weight ?? 0) || 0,
    },
  ].filter((b) => b.weight > 0);

  return (
    <div className="space-y-3">
      {bucketSummary.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2">
          <span className="text-[11px] text-muted-foreground">Buckets del corte:</span>
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
                <TableHead className="sticky left-0 z-10 bg-card min-w-48">Estudiante</TableHead>
                {showWorkshops && (
                  <TableHead className="text-center min-w-28">
                    <div className="inline-flex items-center gap-1">
                      <Hammer className="h-3 w-3 text-amber-500 dark:text-amber-400" />
                      Talleres
                    </div>
                  </TableHead>
                )}
                {showExams && (
                  <TableHead className="text-center min-w-28">
                    <div className="inline-flex items-center gap-1">
                      <FileText className="h-3 w-3 text-primary" />
                      Exámenes
                    </div>
                  </TableHead>
                )}
                {showProjects && (
                  <TableHead className="text-center min-w-28">
                    <div className="inline-flex items-center gap-1">
                      <FolderKanban className="h-3 w-3 text-indigo-500 dark:text-indigo-400" />
                      Proyectos
                    </div>
                  </TableHead>
                )}
                {showAttendance && (
                  <TableHead className="text-center min-w-28 bg-amber-400/5">
                    <div className="inline-flex items-center gap-1">
                      <CalendarCheck className="h-3 w-3 text-primary" />
                      Asistencia
                    </div>
                  </TableHead>
                )}
                <TableHead className="text-right w-[1%]">Detalle</TableHead>
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
                    No hay estudiantes matriculados en este curso.
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
                        label="Ver detalle del estudiante"
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
          {cut.start_date && cut.end_date
            ? "No hay sesiones de asistencia registradas en el rango de fechas del corte — la columna Asistencia queda en —."
            : "El corte no tiene fechas configuradas; la asistencia no se puede asociar al corte."}
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
  const sessionsInCut =
    cut.start_date && cut.end_date
      ? attSessions.filter(
          (s) => s.session_date >= cut.start_date! && s.session_date <= cut.end_date!,
        )
      : [];
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
      label: "Talleres",
      icon: Hammer,
      cols: columns.filter((c) => c.kind === "workshop"),
      bucketWeight: Number(cut.workshop_weight ?? 0) || 0,
    },
    {
      key: "exam",
      label: "Exámenes",
      icon: FileText,
      cols: columns.filter((c) => c.kind === "exam"),
      bucketWeight: Number(cut.exam_weight ?? 0) || 0,
    },
    {
      key: "project",
      label: "Proyectos",
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
                  {sec.cols.length} {sec.cols.length === 1 ? "actividad" : "actividades"}
                </span>
              </div>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                Peso bucket: {sec.bucketWeight.toFixed(1)}%
              </span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Actividad</TableHead>
                  <TableHead className="text-right w-32">
                    Nota{" "}
                    {selectedCourse
                      ? `(${selectedCourse.grade_scale_min}–${selectedCourse.grade_scale_max})`
                      : ""}
                  </TableHead>
                  <TableHead className="w-24 text-center">Estado</TableHead>
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
                          <Input
                            type="number"
                            step="0.1"
                            min={selectedCourse?.grade_scale_min ?? 0}
                            max={
                              col.kind === "exam"
                                ? (selectedCourse?.grade_scale_max ?? 100)
                                : (col.maxScore ?? 100)
                            }
                            value={displayGrade}
                            onChange={(e) => handleEdit(studentId, col.id, e.target.value)}
                            className="h-8 w-24 ml-auto text-right text-sm tabular-nums"
                            placeholder="—"
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
                              title="Sospechoso"
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
              <span className="text-sm font-medium">Asistencia</span>
              <span className="text-[11px] text-muted-foreground">
                {totalSess} {totalSess === 1 ? "sesión" : "sesiones"} en el rango del corte
              </span>
            </div>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              Peso bucket: {Number(cut.attendance_weight ?? 0).toFixed(1)}%
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">Sesiones presente</TableHead>
                <TableHead className="text-right">Total sesiones</TableHead>
                <TableHead className="text-right">% asistencia</TableHead>
                {selectedCourse && (
                  <TableHead className="text-right">
                    Nota ({selectedCourse.grade_scale_min}–{selectedCourse.grade_scale_max})
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
                    {cut.start_date && cut.end_date
                      ? "No hay sesiones registradas en el rango."
                      : "El corte no tiene fechas configuradas."}
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
        Las ediciones se acumulan en el botón global "Guardar cambios" del gradebook (afuera del
        modal).
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
            <TableHead className="sticky left-0 z-10 bg-card min-w-48">Estudiante</TableHead>
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
                      ? "Examen"
                      : col.kind === "workshop"
                        ? `Taller (/${col.maxScore ?? 100})`
                        : `Proyecto (/${col.maxScore ?? 100})`}
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
                No hay estudiantes matriculados en este curso.
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
                        <Input
                          type="number"
                          step="0.1"
                          min={selectedCourse?.grade_scale_min ?? 0}
                          max={
                            col.kind === "workshop"
                              ? (col.maxScore ?? 100)
                              : (selectedCourse?.grade_scale_max ?? 100)
                          }
                          value={displayGrade}
                          onChange={(e) => handleEdit(s.id, col.id, e.target.value)}
                          className="h-8 w-20 mx-auto text-center text-sm tabular-nums"
                          placeholder="—"
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
                              title="Intento marcado como sospechoso (alertas de integridad)"
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
