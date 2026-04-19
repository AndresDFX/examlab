import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, GitBranch } from "lucide-react";
import { downloadCSV, toCSV } from "@/lib/csv";

export const Route = createFileRoute("/app/teacher/gradebook")({ component: Gradebook });

type Course = { id: string; name: string };
type Exam = { id: string; title: string; parent_exam_id: string | null; course_id: string };
type Student = { id: string; full_name: string; institutional_email: string; personal_email: string | null };
type Sub = { exam_id: string; user_id: string; ai_grade: number | null; final_override_grade: number | null; status: string };

function Gradebook() {
  const { roles } = useAuth();
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState<string>("");
  const [exams, setExams] = useState<Exam[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [subs, setSubs] = useState<Sub[]>([]);
  const isTeacher = roles.includes("Docente") || roles.includes("Admin");

  useEffect(() => {
    supabase.from("courses").select("id, name").order("name").then(({ data }) => {
      setCourses(data ?? []);
      if (data?.[0]) setCourseId(data[0].id);
    });
  }, []);

  useEffect(() => {
    if (!courseId) return;
    (async () => {
      const { data: es } = await supabase.from("exams").select("id, title, parent_exam_id, course_id").eq("course_id", courseId);
      setExams(es ?? []);
      const { data: enr } = await supabase.from("course_enrollments")
        .select("user_id")
        .eq("course_id", courseId);
      const userIds = (enr ?? []).map((r: any) => r.user_id);
      if (userIds.length) {
        const { data: profs } = await supabase.from("profiles").select("id, full_name, institutional_email, personal_email").in("id", userIds);
        setStudents((profs ?? []) as Student[]);
      } else {
        setStudents([]);
      }
      const examIds = (es ?? []).map(e => e.id);
      if (examIds.length) {
        const { data: ss } = await supabase.from("submissions").select("exam_id, user_id, ai_grade, final_override_grade, status").in("exam_id", examIds);
        setSubs(ss ?? []);
      } else setSubs([]);
    })();
  }, [courseId]);

  const originalExams = exams.filter(e => !e.parent_exam_id);
  const getGrade = (studentId: string, originalExamId: string) => {
    const own = subs.find(s => s.user_id === studentId && s.exam_id === originalExamId);
    if (own) return { grade: own.final_override_grade ?? own.ai_grade, isMakeup: false, status: own.status };
    const makeups = exams.filter(e => e.parent_exam_id === originalExamId);
    for (const m of makeups) {
      const sub = subs.find(s => s.user_id === studentId && s.exam_id === m.id);
      if (sub) return { grade: sub.final_override_grade ?? sub.ai_grade, isMakeup: true, status: sub.status };
    }
    return { grade: null as number | null, isMakeup: false, status: undefined as string | undefined };
  };

  const exportCourse = () => {
    const rows = students.map(s => {
      const row: any = { nombre: s.full_name, email_institucional: s.institutional_email, email_personal: s.personal_email ?? "" };
      originalExams.forEach(e => {
        const { grade, isMakeup } = getGrade(s.id, e.id);
        row[e.title] = grade != null ? `${grade}${isMakeup ? " (S)" : ""}` : "";
      });
      return row;
    });
    downloadCSV(`notas-curso-${Date.now()}.csv`, toCSV(rows));
  };

  if (!isTeacher) return <p className="text-muted-foreground">Necesitas rol Docente.</p>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Calificaciones</h1>
          <p className="text-sm text-muted-foreground">Las notas de supletorios reemplazan al examen original</p>
        </div>
        <div className="flex gap-2">
          <Select value={courseId} onValueChange={setCourseId}>
            <SelectTrigger className="w-56"><SelectValue placeholder="Curso" /></SelectTrigger>
            <SelectContent>{courses.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button size="sm" onClick={exportCourse}><Download className="h-4 w-4 mr-1" />Exportar CSV</Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-card">Estudiante</TableHead>
                {originalExams.map(e => <TableHead key={e.id} className="text-center min-w-32">{e.title}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {students.map(s => (
                <TableRow key={s.id}>
                  <TableCell className="sticky left-0 bg-card">
                    <div className="font-medium">{s.full_name}</div>
                    <div className="text-xs text-muted-foreground">{s.institutional_email}</div>
                  </TableCell>
                  {originalExams.map(e => {
                    const g = getGrade(s.id, e.id);
                    return (
                      <TableCell key={e.id} className="text-center">
                        {g.grade != null ? (
                          <div className="inline-flex items-center gap-1">
                            <span className={`font-semibold ${g.grade >= 6 ? "text-success" : "text-destructive"}`}>{g.grade}</span>
                            {g.isMakeup && <Badge variant="outline" className="text-[9px]"><GitBranch className="h-2.5 w-2.5 mr-0.5" />S</Badge>}
                            {g.status === "sospechoso" && <Badge variant="destructive" className="text-[9px]">!</Badge>}
                          </div>
                        ) : <span className="text-muted-foreground">—</span>}
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
