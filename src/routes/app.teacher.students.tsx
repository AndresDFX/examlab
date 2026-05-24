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
  codigo: string | null;
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

    // 3. Perfiles (incluye código estudiantil para mostrar en grid)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: profiles, error: profErr } = await (supabase as any)
      .from("profiles")
      .select("id, full_name, institutional_email, codigo")
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
        codigo: p.codigo ?? null,
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
          s.institutional_email.toLowerCase().includes(q) ||
          (s.codigo?.toLowerCase().includes(q) ?? false),
      );
    }
    return result;
  }, [students, search, courseFilter, courses]);

  const handleImpersonate = async (s: Student) => {
    const ok = await confirm({
      title: `¿Iniciar sesión como ${s.full_name}?`,
      description:
        "Vas a entrar a la plataforma con la cuenta de este usuario. Verás todo lo que él ve. " +
        "Mientras estés impersonando, aparecerá un banner amarillo arriba con el botón 'Volver a mi cuenta'. " +
        "La acción queda registrada en el log de auditoría.",
      confirmLabel: "Iniciar como",
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
    <div className="space-y-5">
      <PageHeader
        title="Usuarios"
        subtitle={loading ? undefined : `${students.length} usuario(s) en tus cursos`}
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
                message="No pudimos cargar los usuarios"
                hint={loadError}
                onRetry={() => setRetryNonce((n) => n + 1)}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="max-w-[260px]">Usuario</TableHead>
                    <TableHead className="hidden sm:table-cell w-32">Código</TableHead>
                    <TableHead className="hidden sm:table-cell max-w-[260px]">Correo</TableHead>
                    <TableHead className="hidden md:table-cell">Cursos</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableEmpty colSpan={5} text="Sin usuarios" />
                  ) : (
                    filtered.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell>
                          <div className="font-medium truncate" title={s.full_name}>
                            {s.full_name}
                          </div>
                          <div className="text-xs text-muted-foreground sm:hidden">
                            {s.codigo ? `${s.codigo} · ` : ""}
                            {s.institutional_email}
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-xs text-muted-foreground tabular-nums">
                          {s.codigo ?? "—"}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-sm text-muted-foreground truncate">
                          {s.institutional_email}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {s.courses.length === 0 ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : (
                            // Un solo badge (truncado a 160px) + chip '+N' cuando hay más
                            // cursos. Patrón compacto que mantiene la columna ~200px
                            // máx en lugar de expandirse con cada curso adicional.
                            // El tooltip del chip revela los nombres restantes.
                            <div className="flex items-center gap-1 max-w-[220px]">
                              <Badge
                                variant="outline"
                                className="text-xs max-w-[160px] truncate inline-block"
                                title={s.courses[0]}
                              >
                                {s.courses[0]}
                              </Badge>
                              {s.courses.length > 1 && (
                                <Badge
                                  variant="secondary"
                                  className="text-xs shrink-0"
                                  title={s.courses.slice(1).join(", ")}
                                >
                                  +{s.courses.length - 1}
                                </Badge>
                              )}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <RowActionsMenu
                            actions={[
                              {
                                label: "Iniciar como",
                                icon: Eye,
                                hint: `Acceder a la plataforma como ${s.full_name}`,
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
