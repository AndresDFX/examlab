import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Calendar, BookOpen, Clock } from "lucide-react";

export const Route = createFileRoute("/app/student/courses")({ component: StudentCourses });

type CourseRow = {
  id: string;
  name: string;
  description: string | null;
  period: string | null;
  start_date: string | null;
  end_date: string | null;
};

function StudentCourses() {
  const { user } = useAuth();
  const [courses, setCourses] = useState<CourseRow[]>([]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: enr } = await supabase
        .from("course_enrollments")
        .select("course_id")
        .eq("user_id", user.id);

      const courseIds = (enr ?? []).map((e: any) => e.course_id);
      if (!courseIds.length) { setCourses([]); return; }

      const { data } = await supabase
        .from("courses")
        .select("id, name, description, period, start_date, end_date")
        .in("id", courseIds)
        .order("period", { ascending: false, nullsFirst: false })
        .order("name");

      setCourses((data ?? []) as CourseRow[]);
    })();
  }, [user]);

  const now = new Date();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cursos</h1>
        <p className="text-sm text-muted-foreground">{courses.length} cursos matriculados</p>
      </div>

      {courses.length === 0 ? (
        <p className="text-muted-foreground text-sm">No estás matriculado en ningún curso.</p>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {courses.map(c => {
            const isActive = c.start_date && c.end_date
              ? now >= new Date(c.start_date + "T00:00") && now <= new Date(c.end_date + "T23:59")
              : true;
            const isPast = c.end_date ? now > new Date(c.end_date + "T23:59") : false;

            return (
              <Card key={c.id} className={isPast ? "opacity-60" : ""}>
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                        <BookOpen className="h-4.5 w-4.5 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="font-semibold truncate">{c.name}</h3>
                        {c.period && (
                          <Badge variant="outline" className="text-[10px] mt-0.5">{c.period}</Badge>
                        )}
                      </div>
                    </div>
                    {isPast ? (
                      <Badge variant="secondary" className="text-[10px] shrink-0">Finalizado</Badge>
                    ) : isActive ? (
                      <Badge className="bg-success text-success-foreground text-[10px] shrink-0">Activo</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] shrink-0">Próximo</Badge>
                    )}
                  </div>

                  {c.description && (
                    <p className="text-sm text-muted-foreground">{c.description}</p>
                  )}

                  {(c.start_date || c.end_date) && (
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      {c.start_date && (
                        <div className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          Inicio: {new Date(c.start_date + "T00:00").toLocaleDateString()}
                        </div>
                      )}
                      {c.end_date && (
                        <div className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          Fin: {new Date(c.end_date + "T00:00").toLocaleDateString()}
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
    </div>
  );
}
