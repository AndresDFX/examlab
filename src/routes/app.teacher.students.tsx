import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchInput } from "@/components/ui/search-input";
import { ModuleGuard } from "@/shared/components/ModuleGuard";
import { friendlyError } from "@/shared/lib/db-errors";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { Eye, Users } from "lucide-react";
import { startImpersonate } from "@/modules/admin/impersonation";
import { useConfirm } from "@/shared/components/ConfirmDialog";

export const Route = createFileRoute("/app/teacher/students")({ component: TeacherStudents });

type Student = {
  id: string;
  full_name: string;
  institutional_email: string;
  courses: string[];
};

type Course = { id: string; name: string };

function TeacherStudents() {
  return (
    <ModuleGuard module="teacher_students">
      <TeacherStudentsInner />
    </ModuleGuard>
  );
}

function TeacherStudentsInner() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [students, setStudents] = useState<Student[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [search, setSearch] = useState("");
  const [courseFilter, setCourseFilter] = useState<string>("all");
  const [impersonating, setImpersonating] = useState<string | null>(null);

  const load = async () => {
    if (!user) return;
    setLoading(true);
    setLoadError(null);

    // 1. Cursos del docente
    const { data: teacherCourses, error: tcErr } = await supabase
      .from("course_teachers")
      .select("course_id, courses(id, name)")
      .eq("user_id", user.id);
    if (tcErr) {
      setLoadError(friendlyError(tcErr, "No pudimos cargar tus cursos."));
      setLoading(false);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const myCourses: Course[] = (teacherCourses ?? []).map((r: any) => ({
      id: r.courses?.id ?? r.course_id,
      name: r.courses?.name ?? r.course_id,
    }));
    setCourses(myCourses);
    const courseIds = myCourses.map((c) => c.id);
    if (courseIds.length === 0) {
      setStudents([]);
      setLoading(false);
      return;
    }

    // 2. Matriculados en esos cursos (con perfil)
    const { data: enrollments, error: enrErr } = await supabase
      .from("course_enrollments")
      .select("user_id, course_id")
      .in("course_id", courseIds);
    if (enrErr) {
      setLoadError(friendlyError(enrErr, "No pudimos cargar los estudiantes."));
      setLoading(false);
      return;
    }
    const userIds = [...new Set((enrollments ?? []).map((e: any) => e.user_id))];
    if (userIds.length === 0) {
      setStudents([]);
      setLoading(false);
      return;
    }

    // 3. Perfiles
    const { data: profiles, error: profErr } = await supabase
      .from("profiles")
      .select("id, full_name, institutional_email")
      .in("id", userIds)
      .order("full_name");
    if (profErr) {
      setLoadError(friendlyError(profErr, "No pudimos cargar los perfiles."));
      setLoading(false);
      return;
    }

    // 4. Agrupar cursos por estudiante
    const courseNameById = new Map(myCourses.map((c) => [c.id, c.name]));
    const coursesByStudent = new Map<string, string[]>();
    for (const e of enrollments ?? []) {
      const existing = coursesByStudent.get(e.user_id) ?? [];
      const cName = courseNameById.get(e.course_id);
      if (cName) existing.push(cName);
      coursesByStudent.set(e.user_id, existing);
    }

    setStudents(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (profiles ?? []).map((p: any) => ({
        id: p.id,
        full_name: p.full_name ?? p.institutional_email,
        institutional_email: p.institutional_email,
        courses: coursesByStudent.get(p.id) ?? [],
      })),
    );
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, retryNonce]);

  const filtered = useMemo(() => {
    let result = students;
    if (courseFilter !== "all") {
      const courseName = courses.find((c) => c.id === courseFilter)?.name;
      if (courseName) result = result.filter((s) => s.courses.includes(courseName));
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (s) =>
          s.full_name.toLowerCase().includes(q) ||
          s.institutional_email.toLowerCase().includes(q),
      );
    }
    return result;
  }, [students, search, courseFilter, courses]);

  const handleImpersonate = async (s: Student) => {
    const ok = await confirm({
      title: `¿Ver la plataforma como ${s.full_name}?`,
      description:
        "Entrarás a la plataforma con la cuenta de este estudiante. Verás exactamente lo que él ve. " +
        "Aparecerá un banner amarillo arriba con el botón 'Volver a mi cuenta'. " +
        "La acción queda registrada en el log de auditoría.",
      confirmLabel: "Ver como",
      tone: "warning",
    });
    if (!ok) return;
    setImpersonating(s.id);
    try {
      await startImpersonate(s.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error al iniciar la impersonación");
      setImpersonating(null);
    }
  };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader
        title="Usuarios"
        subtitle={loading ? undefined : `${students.length} estudiante(s) en tus cursos`}
        icon={<Users className="h-5 w-5 text-violet-500" />}
      />

      <Card>
        <CardContent className="p-4 space-y-3">
          {/* Filtros */}
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex-1 min-w-[160px] sm:min-w-48">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Buscar por nombre o correo…"
              />
            </div>
            {courses.length > 1 && (
              <Select value={courseFilter} onValueChange={setCourseFilter}>
                <SelectTrigger className="w-full sm:w-56">
                  <SelectValue placeholder="Todos los cursos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos los cursos</SelectItem>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Tabla */}
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            {loading ? (
              <TableSkeleton cols={3} rows={6} />
            ) : loadError ? (
              <ErrorState
                message="No pudimos cargar los estudiantes"
                hint={loadError}
                onRetry={() => setRetryNonce((n) => n + 1)}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Estudiante</TableHead>
                    <TableHead className="hidden sm:table-cell">Correo</TableHead>
                    <TableHead className="hidden md:table-cell">Cursos</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableEmpty colSpan={4} message="Sin estudiantes" />
                  ) : (
                    filtered.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell>
                          <div className="font-medium">{s.full_name}</div>
                          <div className="text-xs text-muted-foreground sm:hidden">
                            {s.institutional_email}
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">
                          {s.institutional_email}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <div className="flex flex-wrap gap-1">
                            {s.courses.map((c) => (
                              <Badge key={c} variant="outline" className="text-xs">
                                {c}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <RowActionsMenu
                            actions={[
                              {
                                label: "Ver como",
                                icon: Eye,
                                hint: `Ver la plataforma como ${s.full_name}`,
                                onClick: () => void handleImpersonate(s),
                                disabled: impersonating === s.id,
                              },
                            ]}
                          />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
