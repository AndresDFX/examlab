/**
 * Tutor IA — selector de curso.
 *
 * El tutor IA es per-curso (cada curso tiene su propio system prompt
 * + contenidos indexados). Esta ruta lista los cursos donde el alumno
 * está matriculado y le permite entrar al tutor del que elija.
 *
 * Antes solo existía `/app/student/tutor/$courseId`, lo que dejaba al
 * estudiante sin punto de entrada desde el sidebar — el item del nav
 * no podía apuntar a una URL con parámetro variable.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { friendlyError } from "@/shared/lib/db-errors";
import { Sparkles, ChevronRight, BookOpen } from "lucide-react";

export const Route = createFileRoute("/app/student/tutor/")({ component: TutorIndex });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface CourseRow {
  id: string;
  name: string;
  period: string | null;
  description: string | null;
}

function TutorIndex() {
  const { user } = useAuth();
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      const { data: enroll, error } = await db
        .from("course_enrollments")
        .select("course:courses(id, name, period, description)")
        .eq("user_id", user.id);
      if (cancelled) return;
      if (error) {
        setLoadError(friendlyError(error, "No pudimos cargar tus cursos."));
        setLoading(false);
        return;
      }
      const list = ((enroll ?? []) as Array<{ course: CourseRow | null }>)
        .map((r) => r.course)
        .filter((c): c is CourseRow => c != null);
      list.sort((a, b) => a.name.localeCompare(b.name));
      setCourses(list);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, retryNonce]);

  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      <PageHeader
        title="Tutor IA"
        subtitle="Elige un curso para iniciar (o continuar) una conversación con el tutor IA."
        icon={<Sparkles className="h-6 w-6 text-indigo-500" />}
      />

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
          <Spinner size="sm" /> Cargando cursos…
        </div>
      ) : loadError ? (
        <ErrorState
          message="No pudimos cargar tus cursos"
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      ) : courses.length === 0 ? (
        <TableEmpty
          icon={BookOpen}
          title="No estás matriculado en ningún curso"
          description="El tutor IA se entrena con el contexto de cada curso. Cuando te matriculen, podrás iniciar una conversación aquí."
        />
      ) : (
        <div className="space-y-2">
          {courses.map((c) => (
            <Link
              key={c.id}
              to="/app/student/tutor/$courseId"
              params={{ courseId: c.id }}
              className="block"
            >
              <Card className="hover:border-primary/40 hover:bg-muted/30 transition-colors cursor-pointer">
                <CardContent className="p-4 flex items-center gap-3">
                  <div className="h-10 w-10 rounded-md bg-indigo-500/10 flex items-center justify-center shrink-0">
                    <Sparkles className="h-5 w-5 text-indigo-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{c.name}</div>
                    {c.period && (
                      <p className="text-[11px] text-muted-foreground">{c.period}</p>
                    )}
                    {c.description && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {c.description}
                      </p>
                    )}
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
