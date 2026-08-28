/**
 * Pizarra del estudiante — `/app/student/whiteboards/$id`
 *
 * La misma ruta sirve dos casos, y lo que los separa es la PROPIEDAD:
 *
 *  - **Propia** (`owner_id` = el usuario): editor completo. Puede dibujar, agregar
 *    hojas, renombrar y cambiar el curso al que la asocia.
 *  - **Compartida por el docente**: solo lectura, sin la tarjeta de datos.
 *
 * No se decide por rol sino por dueño a propósito: un usuario multi-rol
 * (Docente + Estudiante) que entra como estudiante a una pizarra que él creó
 * dictando la sigue pudiendo editar, y no ve un visor muerto de su propio trabajo.
 *
 * Lo que el estudiante NO puede hacer —compartir con todo el curso, atarla a una
 * sesión de clase, o asociarla a un curso donde no está matriculado— lo bloquea
 * el trigger `trg_whiteboard_student_guard` (mig 20261910000000). Acá no se
 * ofrece, pero la interfaz no es la frontera.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { friendlyError } from "@/shared/lib/db-errors";
import { MultiPageWhiteboard } from "@/modules/whiteboard/MultiPageWhiteboard";
import { Palette, Save } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/app/student/whiteboards/$id")({
  component: StudentWhiteboard,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const SIN_CURSO = "none";

interface Pizarra {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  course_id: string | null;
}

function StudentWhiteboard() {
  const { t } = useTranslation();
  const { id } = Route.useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [wb, setWb] = useState<Pizarra | null>(null);
  const [courses, setCourses] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Borradores de la tarjeta de datos (solo se montan si es propia).
  const [nombre, setNombre] = useState("");
  const [cursoId, setCursoId] = useState<string>(SIN_CURSO);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      try {
        setLoading(true);
        setLoadError(null);
        const [{ data, error }, { data: enrollments }] = await Promise.all([
          db
            .from("whiteboards")
            .select("id, name, description, owner_id, course_id")
            .eq("id", id)
            .is("deleted_at", null)
            .maybeSingle(),
          db
            .from("course_enrollments")
            .select("courses(id, name, deleted_at)")
            .eq("user_id", user.id),
        ]);
        if (cancelled) return;
        if (error || !data) {
          setLoadError(friendlyError(error, t("studentWhiteboards.loadError")));
          setLoading(false);
          return;
        }
        const fila = data as Pizarra;
        setWb(fila);
        setNombre(fila.name);
        setCursoId(fila.course_id ?? SIN_CURSO);
        setCourses(
          (
            (enrollments ?? []) as Array<{
              courses: { id: string; name: string; deleted_at: string | null } | null;
            }>
          )
            .map((r) => r.courses)
            .filter(
              (c): c is { id: string; name: string; deleted_at: string | null } =>
                !!c && !c.deleted_at,
            )
            .map((c) => ({ id: c.id, name: c.name })),
        );
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setLoadError(friendlyError(e, t("studentWhiteboards.loadError")));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, user, t]);

  const esPropia = !!wb && !!user && wb.owner_id === user.id;

  const guardarDatos = async () => {
    if (!wb) return;
    if (!nombre.trim()) {
      toast.error(t("studentWhiteboards.createNameRequired"));
      return;
    }
    setGuardando(true);
    try {
      const { error } = await db
        .from("whiteboards")
        .update({
          name: nombre.trim(),
          course_id: cursoId === SIN_CURSO ? null : cursoId,
        })
        .eq("id", wb.id);
      if (error) {
        toast.error(friendlyError(error, t("studentWhiteboards.saveError")));
        return;
      }
      setWb({ ...wb, name: nombre.trim(), course_id: cursoId === SIN_CURSO ? null : cursoId });
      toast.success(t("studentWhiteboards.saved"));
    } catch (e) {
      toast.error(friendlyError(e, t("studentWhiteboards.saveError")));
    } finally {
      setGuardando(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground p-4 sm:p-8">
        <Spinner size="sm" /> {t("studentWhiteboards.loading")}
      </div>
    );
  }
  if (loadError || !wb) {
    return (
      <ErrorState
        message={t("studentWhiteboards.loadError")}
        hint={loadError ?? undefined}
        onRetry={() => navigate({ to: "/app/student/whiteboards" })}
      />
    );
  }

  return (
    <div className="flex flex-col md:h-[calc(100dvh-7rem)] gap-3">
      <PageHeader
        icon={<Palette className="h-6 w-6" />}
        backTo="/app/student/whiteboards"
        title={wb.name}
        subtitle={
          esPropia ? t("studentWhiteboards.ownSubtitle") : t("studentWhiteboards.viewerSubtitle")
        }
      />

      {esPropia && (
        <Card className="shrink-0">
          <CardContent className="p-3 flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="flex-1 min-w-[160px] sm:min-w-48">
              <Label htmlFor="wb-nombre">{t("studentWhiteboards.fieldName")}</Label>
              <Input
                id="wb-nombre"
                className="mt-1"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                maxLength={200}
              />
            </div>
            <div className="flex-1 min-w-[160px] sm:min-w-48">
              <Label htmlFor="wb-curso">{t("studentWhiteboards.fieldCourse")}</Label>
              <Select value={cursoId} onValueChange={setCursoId}>
                <SelectTrigger id="wb-curso" className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SIN_CURSO}>{t("studentWhiteboards.noCourse")}</SelectItem>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => void guardarDatos()} disabled={guardando}>
              {guardando ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Save className="h-4 w-4 mr-1" />
              )}
              {t("common.save")}
            </Button>
          </CardContent>
        </Card>
      )}
      {esPropia && (
        <p className="text-xs text-muted-foreground shrink-0">
          {wb.course_id
            ? t("studentWhiteboards.courseHintTeacherSees")
            : t("studentWhiteboards.courseHintNone")}
        </p>
      )}

      <div className="flex-1 min-h-[65dvh] md:min-h-0 rounded-md border overflow-hidden bg-background">
        <MultiPageWhiteboard
          whiteboardId={id}
          readOnly={!esPropia}
          courseId={wb.course_id}
          className="w-full h-full"
        />
      </div>
    </div>
  );
}
