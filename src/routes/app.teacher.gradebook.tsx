import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { Download, GitBranch, FileText, Hammer, Save, Loader2 } from "lucide-react";
import { downloadCSV, toCSV } from "@/lib/csv";

export const Route = createFileRoute("/app/teacher/gradebook")({ component: Gradebook });

type Course = { id: string; name: string };
type Exam = { id: string; title: string; parent_exam_id: string | null; course_id: string };
type Workshop = { id: string; title: string; course_id: string; max_score: number };
type Student = { id: string; full_name: string; institutional_email: string; personal_email: string | null };
type ExamSub = { id: string; exam_id: string; user_id: string; ai_grade: number | null; final_override_grade: number | null; status: string };
type WsSub = { id: string; workshop_id: string; user_id: string; ai_grade: number | null; final_grade: number | null; status: string };

/** A column in the grid — either an exam or a workshop */
type GradeColumn = {
  id: string;
  title: string;
  kind: "exam" | "workshop";
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
  const [edits, setEdits] = useState<EditMap>({});
  const [saving, setSaving] = useState(false);
  const isTeacher = roles.includes("Docente") || roles.includes("Admin");

  // Load courses
  useEffect(() => {
    supabase.from("courses").select("id, name").order("name").then(({ data }) => {
      setCourses(data ?? []);
      if (data?.[0]) setCourseId(data[0].id);
    });
  }, []);

  // Load data for selected course
  const loadCourse = useCallback(async () => {
    if (!courseId) return;

    // Exams
    const { data: exams } = await supabase
      .from("exams")
      .select("id, title, parent_exam_id, course_id")
      .eq("course_id", courseId)
      .order("start_time");

    // Workshops
    const { data: workshops } = await supabase
      .from("workshops")
      .select("id, title, course_id, max_score")
      .eq("course_id", courseId)
      .order("created_at");

    setAllExams((exams ?? []) as Exam[]);

    // Build columns: original exams (no parent) + workshops
    const examCols: GradeColumn[] = ((exams ?? []) as Exam[])
      .filter(e => !e.parent_exam_id)
      .map(e => ({ id: e.id, title: e.title, kind: "exam" as const, parentExamId: null }));

    const wsCols: GradeColumn[] = ((workshops ?? []) as Workshop[])
      .map(w => ({ id: w.id, title: w.title, kind: "workshop" as const, maxScore: w.max_score }));

    setColumns([...examCols, ...wsCols]);

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
        .select("id, exam_id, user_id, ai_grade, final_override_grade, status")
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

    setEdits({});
  }, [courseId]);

  useEffect(() => { loadCourse(); }, [loadCourse]);

  // Get the effective grade for a student + column
  const getGrade = (studentId: string, col: GradeColumn): {
    grade: number | null; isMakeup: boolean; status?: string; subId?: string;
  } => {
    if (col.kind === "exam") {
      // Check direct submission
      const own = examSubs.find(s => s.user_id === studentId && s.exam_id === col.id);
      if (own) return {
        grade: own.final_override_grade ?? own.ai_grade,
        isMakeup: false,
        status: own.status,
        subId: own.id,
      };
      // Check makeup exams
      const makeups = allExams.filter(e => e.parent_exam_id === col.id);
      for (const m of makeups) {
        const sub = examSubs.find(s => s.user_id === studentId && s.exam_id === m.id);
        if (sub) return {
          grade: sub.final_override_grade ?? sub.ai_grade,
          isMakeup: true,
          status: sub.status,
          subId: sub.id,
        };
      }
      return { grade: null, isMakeup: false };
    } else {
      const sub = wsSubs.find(s => s.user_id === studentId && s.workshop_id === col.id);
      if (sub) return {
        grade: sub.final_grade ?? sub.ai_grade,
        isMakeup: false,
        status: sub.status,
        subId: sub.id,
      };
      return { grade: null, isMakeup: false };
    }
  };

  // Edit handler
  const cellKey = (studentId: string, colId: string) => `${studentId}::${colId}`;

  const handleEdit = (studentId: string, colId: string, value: string) => {
    setEdits(prev => ({ ...prev, [cellKey(studentId, colId)]: value }));
  };

  // Save all edits
  const saveAll = async () => {
    const entries = Object.entries(edits).filter(([, v]) => v !== "");
    if (!entries.length) { toast.info("No hay cambios para guardar"); return; }

    setSaving(true);
    let saved = 0;
    let errors = 0;

    for (const [key, value] of entries) {
      const [studentId, colId] = key.split("::");
      const col = columns.find(c => c.id === colId);
      if (!col) continue;

      const numValue = Number(value);
      if (isNaN(numValue)) { errors++; continue; }

      if (col.kind === "exam") {
        const g = getGrade(studentId, col);
        if (g.subId) {
          const { error } = await supabase
            .from("submissions")
            .update({ final_override_grade: numValue })
            .eq("id", g.subId);
          if (error) errors++; else saved++;
        } else {
          errors++; // No submission to update
        }
      } else {
        const g = getGrade(studentId, col);
        if (g.subId) {
          const { error } = await supabase
            .from("workshop_submissions")
            .update({ final_grade: numValue, status: "calificado" })
            .eq("id", g.subId);
          if (error) errors++; else saved++;
        } else {
          errors++; // No submission to update
        }
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
    if (!students.length || !columns.length) { toast.info("No hay datos para exportar"); return; }

    const csvRows = students.map(s => {
      const row: Record<string, string> = {
        nombre: s.full_name,
        email_institucional: s.institutional_email,
        email_personal: s.personal_email ?? "",
      };
      columns.forEach(col => {
        const g = getGrade(s.id, col);
        const prefix = col.kind === "workshop" ? "[T] " : "";
        const label = `${prefix}${col.title}`;
        if (g.grade != null) {
          row[label] = `${g.grade}${g.isMakeup ? " (S)" : ""}`;
        } else {
          row[label] = "";
        }
      });
      return row;
    });

    const courseName = courses.find(c => c.id === courseId)?.name ?? "curso";
    downloadCSV(`calificaciones-${courseName.replace(/\s+/g, "_")}-${Date.now()}.csv`, toCSV(csvRows));
    toast.success("Archivo exportado correctamente");
  };

  const hasEdits = Object.values(edits).some(v => v !== "");

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
        <div className="flex flex-wrap gap-2">
          <Select value={courseId} onValueChange={setCourseId}>
            <SelectTrigger className="w-56"><SelectValue placeholder="Curso" /></SelectTrigger>
            <SelectContent>{courses.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
          </Select>
          {hasEdits && (
            <Button size="sm" onClick={saveAll} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
              Guardar cambios
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={exportCourse}>
            <Download className="h-4 w-4 mr-1" />CSV
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 bg-card min-w-48">Estudiante</TableHead>
                {columns.map(col => (
                  <TableHead key={col.id} className="text-center min-w-28">
                    <div className="flex flex-col items-center gap-0.5">
                      <div className="flex items-center gap-1">
                        {col.kind === "exam"
                          ? <FileText className="h-3 w-3 text-primary shrink-0" />
                          : <Hammer className="h-3 w-3 text-amber-500 dark:text-amber-400 shrink-0" />
                        }
                        <span className="truncate max-w-24" title={col.title}>{col.title}</span>
                      </div>
                      <Badge variant="outline" className="text-[9px] py-0 h-3.5">
                        {col.kind === "exam" ? "Examen" : "Taller"}
                      </Badge>
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {students.length === 0 && (
                <TableRow>
                  <TableCell colSpan={columns.length + 1} className="text-center text-muted-foreground py-8">
                    No hay estudiantes matriculados en este curso.
                  </TableCell>
                </TableRow>
              )}
              {students.map(s => (
                <TableRow key={s.id}>
                  <TableCell className="sticky left-0 z-10 bg-card">
                    <div className="font-medium text-sm">{s.full_name}</div>
                    <div className="text-xs text-muted-foreground">{s.institutional_email}</div>
                  </TableCell>
                  {columns.map(col => {
                    const g = getGrade(s.id, col);
                    const key = cellKey(s.id, col.id);
                    const isEditing = key in edits;
                    const displayGrade = isEditing ? edits[key] : (g.grade != null ? String(g.grade) : "");

                    return (
                      <TableCell key={col.id} className="text-center p-1">
                        {g.subId ? (
                          <div className="relative">
                            <Input
                              type="number"
                              value={displayGrade}
                              onChange={e => handleEdit(s.id, col.id, e.target.value)}
                              className="h-8 w-20 mx-auto text-center text-sm tabular-nums"
                              placeholder="—"
                            />
                            <div className="flex items-center justify-center gap-0.5 mt-0.5">
                              {g.isMakeup && (
                                <Badge variant="outline" className="text-[8px] py-0 h-3">
                                  <GitBranch className="h-2 w-2 mr-0.5" />S
                                </Badge>
                              )}
                              {g.status === "sospechoso" && (
                                <Badge variant="destructive" className="text-[8px] py-0 h-3">!</Badge>
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
      </Card>
    </div>
  );
}
