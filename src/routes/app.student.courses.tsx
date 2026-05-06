import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Calendar, BookOpen, Clock, FileText, Hammer, UserCog, Scale } from "lucide-react";
import { formatDateOnly } from "@/lib/format";

export const Route = createFileRoute("/app/student/courses")({ component: StudentCourses });

type CourseRow = {
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
};

type CourseDetail = {
  examsCount: number;
  workshopsCount: number;
  teachers: { full_name: string; institutional_email: string }[];
  studentsCount: number;
};

function StudentCourses() {
  const { user } = useAuth();
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [selected, setSelected] = useState<CourseRow | null>(null);
  const [detail, setDetail] = useState<CourseDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: enr } = await supabase
        .from("course_enrollments")
        .select("course_id")
        .eq("user_id", user.id);

      const courseIds = (enr ?? []).map((e: any) => e.course_id);
      if (!courseIds.length) {
        setCourses([]);
        return;
      }

      const { data } = await supabase
        .from("courses")
        .select(
          "id, name, description, period, start_date, end_date, grade_scale_min, grade_scale_max, exam_weight, workshop_weight, attendance_weight, passing_grade",
        )
        .in("id", courseIds)
        .order("period", { ascending: false, nullsFirst: false })
        .order("name");

      setCourses((data ?? []) as CourseRow[]);
    })();
  }, [user]);

  const openCourse = async (c: CourseRow) => {
    setSelected(c);
    setLoadingDetail(true);
    setDetail(null);
    try {
      const [exRes, wsRes, ctRes, enrRes] = await Promise.all([
        supabase.from("exams").select("id", { count: "exact", head: true }).eq("course_id", c.id),
        supabase
          .from("workshops")
          .select("id", { count: "exact", head: true })
          .eq("course_id", c.id),
        supabase.from("course_teachers").select("user_id").eq("course_id", c.id),
        supabase
          .from("course_enrollments")
          .select("user_id", { count: "exact", head: true })
          .eq("course_id", c.id),
      ]);

      const teacherIds = (ctRes.data ?? []).map((t: any) => t.user_id);
      let teachers: CourseDetail["teachers"] = [];
      if (teacherIds.length) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("full_name, institutional_email")
          .in("id", teacherIds);
        teachers = (profs ?? []) as CourseDetail["teachers"];
      }

      setDetail({
        examsCount: exRes.count ?? 0,
        workshopsCount: wsRes.count ?? 0,
        teachers,
        studentsCount: enrRes.count ?? 0,
      });
    } finally {
      setLoadingDetail(false);
    }
  };

  const now = new Date();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cursos</h1>
        <p className="text-sm text-muted-foreground">
          {courses.length} cursos matriculados · clic para ver detalles
        </p>
      </div>

      {courses.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground text-sm">
            No estás matriculado en ningún curso.
          </CardContent>
        </Card>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {courses.map((c) => {
            const isActive =
              c.start_date && c.end_date
                ? now >= new Date(c.start_date + "T00:00") && now <= new Date(c.end_date + "T23:59")
                : true;
            const isPast = c.end_date ? now > new Date(c.end_date + "T23:59") : false;

            return (
              <Card
                key={c.id}
                className={`cursor-pointer transition hover:border-primary/50 hover:shadow-md ${isPast ? "opacity-60" : ""}`}
                onClick={() => openCourse(c)}
              >
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                        <BookOpen className="h-4.5 w-4.5 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="font-semibold truncate">{c.name}</h3>
                        {c.period && (
                          <Badge variant="outline" className="text-[10px] mt-0.5">
                            {c.period}
                          </Badge>
                        )}
                      </div>
                    </div>
                    {isPast ? (
                      <Badge variant="secondary" className="text-[10px] shrink-0">
                        Finalizado
                      </Badge>
                    ) : isActive ? (
                      <Badge className="bg-success text-success-foreground text-[10px] shrink-0">
                        Activo
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        Próximo
                      </Badge>
                    )}
                  </div>

                  {c.description && (
                    <p className="text-sm text-muted-foreground line-clamp-2">{c.description}</p>
                  )}

                  {(c.start_date || c.end_date) && (
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      {c.start_date && (
                        <div className="flex items-center gap-1 tabular-nums">
                          <Calendar className="h-3 w-3" />
                          {formatDateOnly(c.start_date)}
                        </div>
                      )}
                      {c.end_date && (
                        <div className="flex items-center gap-1 tabular-nums">
                          <Clock className="h-3 w-3" />
                          {formatDateOnly(c.end_date)}
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog
        open={!!selected}
        onOpenChange={(v) => {
          if (!v) {
            setSelected(null);
            setDetail(null);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-primary" />
              {selected?.name}
            </DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-1.5">
                {selected.period && <Badge variant="outline">{selected.period}</Badge>}
                {selected.start_date && selected.end_date && (
                  <Badge variant="secondary" className="text-[10px] tabular-nums">
                    {formatDateOnly(selected.start_date)} → {formatDateOnly(selected.end_date)}
                  </Badge>
                )}
              </div>

              {selected.description && (
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                  {selected.description}
                </p>
              )}

              <div className="rounded-md border p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Scale className="h-4 w-4 text-primary" /> Escala de calificación
                </div>
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div>
                    <div className="text-muted-foreground">Rango</div>
                    <div className="font-medium tabular-nums">
                      {selected.grade_scale_min} – {selected.grade_scale_max}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Aprobar</div>
                    <div className="font-medium tabular-nums">≥ {selected.passing_grade}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Pesos</div>
                    <div className="font-medium tabular-nums">
                      Exámenes {selected.exam_weight}% · Talleres {selected.workshop_weight}% ·
                      Asistencia {selected.attendance_weight}%
                    </div>
                  </div>
                </div>
              </div>

              {loadingDetail ? (
                <p className="text-sm text-muted-foreground">Cargando…</p>
              ) : (
                detail && (
                  <>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="rounded-md border p-3 text-center">
                        <FileText className="h-4 w-4 mx-auto text-primary mb-1" />
                        <div className="text-lg font-semibold tabular-nums">
                          {detail.examsCount}
                        </div>
                        <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                          Exámenes
                        </div>
                      </div>
                      <div className="rounded-md border p-3 text-center">
                        <Hammer className="h-4 w-4 mx-auto text-amber-500 dark:text-amber-400 mb-1" />
                        <div className="text-lg font-semibold tabular-nums">
                          {detail.workshopsCount}
                        </div>
                        <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                          Talleres
                        </div>
                      </div>
                      <div className="rounded-md border p-3 text-center">
                        <UserCog className="h-4 w-4 mx-auto text-emerald-500 dark:text-emerald-400 mb-1" />
                        <div className="text-lg font-semibold tabular-nums">
                          {detail.studentsCount}
                        </div>
                        <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                          Estudiantes
                        </div>
                      </div>
                    </div>

                    <div>
                      <div className="text-sm font-medium mb-1.5">Docentes</div>
                      {detail.teachers.length === 0 ? (
                        <p className="text-xs text-muted-foreground">Sin docentes asignados.</p>
                      ) : (
                        <ul className="space-y-1">
                          {detail.teachers.map((t, i) => (
                            <li
                              key={i}
                              className="text-sm flex justify-between gap-2 border-b last:border-b-0 pb-1"
                            >
                              <span className="font-medium truncate">{t.full_name}</span>
                              <span className="text-xs text-muted-foreground truncate">
                                {t.institutional_email}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                )
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
