/**
 * Editor de pizarra (docente) — `/app/teacher/whiteboards/$id`
 *
 * Carga una pizarra standalone por id, embebe el `WhiteboardEditor`
 * a pantalla completa, persiste cambios con debounce. Incluye
 * controles para renombrar y para compartir con un curso.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { HelpHint } from "@/components/ui/help-hint";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { WhiteboardEditor, type WhiteboardScene } from "@/modules/whiteboard/WhiteboardEditor";
import { Palette, Save, Share2 } from "lucide-react";

export const Route = createFileRoute("/app/teacher/whiteboards/$id")({
  component: WhiteboardEditorPage,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Whiteboard {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  scene_json: WhiteboardScene;
  course_id: string | null;
  is_shared_with_course: boolean;
}

function WhiteboardEditorPage() {
  const { id } = Route.useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [wb, setWb] = useState<Whiteboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingMeta, setSavingMeta] = useState(false);
  // Cursos del docente para el selector de "compartir con curso".
  const [courses, setCourses] = useState<Array<{ id: string; name: string }>>([]);
  // Indicador "guardando…" visible cuando el auto-save está en vuelo.
  const [autoSaving, setAutoSaving] = useState(false);
  // Form local de meta — controlled inputs para nombre, curso, share.
  const [metaName, setMetaName] = useState("");
  const [metaCourse, setMetaCourse] = useState<string>("none");
  const [metaShared, setMetaShared] = useState(false);
  // Latest scene en ref para "Guardar manual" sin depender de re-render.
  const latestSceneRef = useRef<WhiteboardScene | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      try {
        setLoading(true);
        setLoadError(null);
        const [{ data: wbData, error: wbErr }, { data: courseRows }] = await Promise.all([
          db
            .from("whiteboards")
            .select("id, owner_id, name, description, scene_json, course_id, is_shared_with_course")
            .eq("id", id)
            .maybeSingle(),
          db.from("course_teachers").select("course_id, courses(id, name)").eq("user_id", user.id),
        ]);
        if (cancelled) return;
        if (wbErr || !wbData) {
          setLoadError(friendlyError(wbErr, "No pudimos cargar la pizarra."));
          setLoading(false);
          return;
        }
        const row = wbData as Whiteboard;
        setWb(row);
        setMetaName(row.name);
        setMetaCourse(row.course_id ?? "none");
        setMetaShared(row.is_shared_with_course);
        const myCourses: Array<{ id: string; name: string }> = (courseRows ?? [])
          .map((r: { courses: { id: string; name: string } | null }) => r.courses)
          .filter((c: { id: string; name: string } | null): c is { id: string; name: string } =>
            Boolean(c),
          );
        setCourses(myCourses);
        setLoading(false);
      } catch (e) {
        // El IIFE async sin try/catch perdía rejections del Promise.all
        // (network throw, RLS panic) → unhandled rejection en el
        // handler global. Con `void (async () => ...)`, el rejection
        // burbujea fuera del effect y no hay nada que lo agarre.
        // Acá: setear loadError → render del <ErrorState> + reset
        // loading para no dejar el spinner colgado.
        if (cancelled) return;
        setLoadError(friendlyError(e, "No pudimos cargar la pizarra."));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, user]);

  const persistScene = async (next: WhiteboardScene) => {
    latestSceneRef.current = next;
    setAutoSaving(true);
    try {
      const { error } = await db.from("whiteboards").update({ scene_json: next }).eq("id", id);
      if (error) {
        toast.error(friendlyError(error, "No se pudo guardar la pizarra"));
        return;
      }
    } catch (e) {
      // Cerrar el contrato con WhiteboardEditor: si el await rechaza
      // (network throw, AbortError), absorber acá con toast amigable.
      // Sin esto el .catch del editor solo loguea a consola y el usuario
      // ve "Guardando…" colgado sin saber que falló.
      toast.error(friendlyError(e, "No se pudo guardar la pizarra"));
    } finally {
      // Pequeño delay para que el badge "Guardando" sea visible incluso
      // en redes rápidas — si desaparece al instante, el usuario no ve
      // feedback de que su trabajo está seguro.
      setTimeout(() => setAutoSaving(false), 400);
    }
  };

  const saveMeta = async () => {
    if (!wb) return;
    if (!metaName.trim()) {
      toast.error("La pizarra necesita un nombre");
      return;
    }
    setSavingMeta(true);
    try {
      const { error } = await db
        .from("whiteboards")
        .update({
          name: metaName.trim(),
          course_id: metaCourse === "none" ? null : metaCourse,
          is_shared_with_course: metaCourse !== "none" && metaShared,
        })
        .eq("id", wb.id);
      if (error) {
        toast.error(friendlyError(error, "No se pudo guardar"));
        return;
      }
      toast.success("Cambios guardados");
      setWb({
        ...wb,
        name: metaName.trim(),
        course_id: metaCourse === "none" ? null : metaCourse,
        is_shared_with_course: metaCourse !== "none" && metaShared,
      });
    } catch (e) {
      // Caller: `() => void saveMeta()` desde onClick. Sin catch
      // explícito, una rejection del update burbujea como unhandled
      // rejection. Mostramos toast amigable usando friendlyError.
      toast.error(friendlyError(e, "No se pudo guardar"));
    } finally {
      setSavingMeta(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground p-8">
        <Spinner size="sm" /> Cargando pizarra…
      </div>
    );
  }
  if (loadError || !wb) {
    return (
      <ErrorState
        message="No pudimos abrir la pizarra"
        hint={loadError ?? "La pizarra fue eliminada o no tienes acceso."}
        onRetry={() => navigate({ to: "/app/teacher/whiteboards" })}
      />
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] gap-3">
      <PageHeader
        icon={<Palette className="h-6 w-6 text-primary" />}
        backTo="/app/teacher/whiteboards"
        title={wb.name}
        subtitle="Los cambios se guardan automáticamente mientras dibujas."
        actions={
          autoSaving ? (
            <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
              <Spinner size="xs" />
              Guardando…
            </span>
          ) : undefined
        }
      />

      {/* Meta: renombrar + compartir con curso. Compacto en una sola fila. */}
      <Card>
        <CardContent className="p-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div>
              <Label>Nombre</Label>
              <Input
                value={metaName}
                onChange={(e) => setMetaName(e.target.value)}
                placeholder="Nombre de la pizarra"
              />
            </div>
            <div>
              <Label>
                Compartir con curso{" "}
                <HelpHint>
                  Si elegís un curso y activás "Compartir", los alumnos matriculados podrán ver esta
                  pizarra en solo-lectura desde su sección de cursos. Sin curso, la pizarra es
                  privada — solo vos la ves.
                </HelpHint>
              </Label>
              <Select value={metaCourse} onValueChange={setMetaCourse}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Solo yo (privada)</SelectItem>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-3 justify-between md:justify-start flex-wrap">
              <div className="flex items-center gap-2 text-sm">
                <Share2 className="h-4 w-4 text-muted-foreground" />
                <Label htmlFor="wb-share-switch" className="cursor-pointer mb-0 font-normal">
                  Compartir con alumnos
                </Label>
                <Switch
                  id="wb-share-switch"
                  checked={metaShared}
                  onCheckedChange={setMetaShared}
                  disabled={metaCourse === "none"}
                />
              </div>
              <Button size="sm" onClick={() => void saveMeta()} disabled={savingMeta}>
                {savingMeta ? (
                  <Spinner size="xs" className="mr-1" />
                ) : (
                  <Save className="h-3.5 w-3.5 mr-1" />
                )}
                Guardar
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Editor — toma el espacio restante del viewport. */}
      <div className="flex-1 min-h-0 rounded-md border overflow-hidden bg-background">
        <WhiteboardEditor
          scene={wb.scene_json}
          onPersist={persistScene}
          className="w-full h-full"
        />
      </div>
    </div>
  );
}
