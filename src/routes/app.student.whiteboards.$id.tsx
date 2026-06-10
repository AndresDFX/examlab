/**
 * Visor de pizarra (estudiante) — `/app/student/whiteboards/$id`
 *
 * Carga una pizarra compartida por id y la embebe a pantalla completa
 * en modo SOLO LECTURA. A diferencia del editor del docente
 * (`/app/teacher/whiteboards/$id`), acá NO hay Card de meta
 * (nombre/compartir/guardar), NI query a course_teachers, NI saveMeta.
 *
 * La RLS de `whiteboards` ya filtra: el alumno solo ve las pizarras
 * compartidas (`is_shared_with_course=true`) de los cursos donde está
 * matriculado. Si no hay fila / error → ErrorState.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { PageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { friendlyError } from "@/shared/lib/db-errors";
import { MultiPageWhiteboard } from "@/modules/whiteboard/MultiPageWhiteboard";
import { Palette } from "lucide-react";

export const Route = createFileRoute("/app/student/whiteboards/$id")({
  component: StudentWhiteboardViewer,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Whiteboard {
  id: string;
  name: string;
  description: string | null;
}

function StudentWhiteboardViewer() {
  const { t } = useTranslation();
  const { id } = Route.useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [wb, setWb] = useState<Whiteboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      try {
        setLoading(true);
        setLoadError(null);
        const { data, error } = await db
          .from("whiteboards")
          .select("id, name, description")
          .eq("id", id)
          .is("deleted_at", null)
          .maybeSingle();
        if (cancelled) return;
        if (error || !data) {
          setLoadError(friendlyError(error, t("studentWhiteboards.loadError")));
          setLoading(false);
          return;
        }
        setWb(data as Whiteboard);
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
    <div className="flex flex-col h-[calc(100dvh-7rem)] gap-3">
      <PageHeader
        icon={<Palette className="h-6 w-6 text-violet-500" />}
        backTo="/app/student/whiteboards"
        title={wb.name}
        subtitle={t("studentWhiteboards.viewerSubtitle")}
      />
      <div className="flex-1 min-h-0 rounded-md border overflow-hidden bg-background">
        <MultiPageWhiteboard whiteboardId={id} readOnly className="w-full h-full" />
      </div>
    </div>
  );
}
