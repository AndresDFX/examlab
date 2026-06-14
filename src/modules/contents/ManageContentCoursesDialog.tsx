/**
 * ManageContentCoursesDialog — gestiona en qué CURSOS aparece un contenido
 * a nivel de tablero (tabla N-N `content_course_assignments`).
 *
 * Hasta ahora la asociación multi-curso solo se podía hacer al SUBIR el
 * contenido (UploadExternalContentDialog) o al DUPLICARLO. Este dialog
 * permite agregar/quitar cursos de un contenido YA existente sin re-subirlo,
 * que es lo que pide el goal #16 ("el contenido se puede usar en más de un
 * curso a nivel de tablero").
 *
 * Mecánica:
 *   - Al abrir, carga las filas de cca del contenido → cursos ya asignados.
 *   - Lista TODOS los cursos visibles (el caller los pasa) con checkbox
 *     precargado al estado actual.
 *   - Al guardar calcula el DIFF: INSERT por cada curso nuevo marcado,
 *     DELETE por cada curso desmarcado. El curso ANCLA
 *     (`generated_contents.course_id`) NO se puede desmarcar — desasociarlo
 *     dejaría el contenido sin su curso de origen; queda fijado.
 *   - La RLS (`cca_insert`/`cca_delete`) permite la operación al docente del
 *     curso (vía course_teachers) o Admin/SuperAdmin.
 *
 * NOTA de scope (CLAUDE.md "has_role sin tenant"): las ramas Admin/SuperAdmin
 * de la RLS de cca NO están acotadas al tenant del curso — leak documentado en
 * la migración 20260826000000, fuera del alcance de este cambio. La rama
 * Docente sí está acotada por course_teachers.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { SectionLoader } from "@/components/ui/loaders";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Layers } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export interface ManageCoursesTarget {
  id: string;
  /** Nombre visible del contenido (display_name con fallback a topic). */
  label: string;
  /** Curso ancla — `generated_contents.course_id`. Siempre marcado y no
   *  desmarcable. null = contenido genérico sin ancla. */
  anchorCourseId: string | null;
}

interface Props {
  /** Contenido a gestionar. null = dialog cerrado. */
  target: ManageCoursesTarget | null;
  courses: Array<{ id: string; name: string }>;
  onClose: () => void;
  /** Se llama tras guardar OK (para que el caller recargue). */
  onSaved?: () => void;
}

export function ManageContentCoursesDialog({ target, courses, onClose, onSaved }: Props) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Cursos marcados (incluye siempre el ancla). Set de course_id.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Estado inicial (cursos ya asignados al abrir) — para calcular el diff.
  const [initial, setInitial] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const { data } = await db
        .from("content_course_assignments")
        .select("course_id")
        .eq("content_id", target.id);
      if (cancelled) return;
      const ids = new Set(
        ((data ?? []) as Array<{ course_id: string }>).map((r) => r.course_id),
      );
      // El ancla SIEMPRE cuenta como asignado aunque no tenga fila cca
      // (compat con contenidos viejos creados antes de la junction).
      if (target.anchorCourseId) ids.add(target.anchorCourseId);
      setInitial(new Set(ids));
      setSelected(new Set(ids));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  if (!target) return null;

  const toggle = (courseId: string) => {
    // El ancla no se puede desmarcar.
    if (courseId === target.anchorCourseId) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(courseId)) next.delete(courseId);
      else next.add(courseId);
      return next;
    });
  };

  const save = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const toAdd = [...selected].filter((id) => !initial.has(id));
      // Nunca quitamos el ancla del diff (no aparece marcable para quitar).
      const toRemove = [...initial].filter(
        (id) => !selected.has(id) && id !== target.anchorCourseId,
      );

      if (toAdd.length > 0) {
        const { error } = await db.from("content_course_assignments").insert(
          toAdd.map((courseId) => ({
            content_id: target.id,
            course_id: courseId,
            created_by: user.id,
          })),
        );
        if (error) {
          toast.error(friendlyError(error));
          return;
        }
      }
      if (toRemove.length > 0) {
        const { error } = await db
          .from("content_course_assignments")
          .delete()
          .eq("content_id", target.id)
          .in("course_id", toRemove);
        if (error) {
          toast.error(friendlyError(error));
          return;
        }
      }

      if (toAdd.length === 0 && toRemove.length === 0) {
        toast.info(t("manageCourses.noChanges", { defaultValue: "No hubo cambios" }));
      } else {
        toast.success(
          t("manageCourses.saved", {
            defaultValue: "Cursos actualizados ({{added}} agregado(s), {{removed}} quitado(s))",
            added: toAdd.length,
            removed: toRemove.length,
          }),
        );
      }
      onSaved?.();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    [...selected].some((id) => !initial.has(id)) ||
    [...initial].some((id) => !selected.has(id));

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !saving && !o && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-primary" />
            {t("manageCourses.title", { defaultValue: "Asignar a cursos" })}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("manageCourses.desc", {
              defaultValue:
                'Elige en qué cursos aparece "{{name}}" en el tablero. Se comparte el mismo material entre los cursos seleccionados.',
              name: target.label,
            })}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <SectionLoader text={t("common.loading", { defaultValue: "Cargando…" })} />
        ) : courses.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4">
            {t("manageCourses.noCourses", {
              defaultValue: "No tienes cursos disponibles para asignar.",
            })}
          </p>
        ) : (
          <div className="border rounded-md max-h-60 overflow-y-auto divide-y">
            {courses.map((c) => {
              const isAnchor = c.id === target.anchorCourseId;
              const checked = selected.has(c.id);
              return (
                <label
                  key={c.id}
                  className={`flex items-center gap-2 px-3 py-2 transition-colors ${
                    isAnchor ? "opacity-90" : "cursor-pointer hover:bg-accent/50"
                  }`}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggle(c.id)}
                    disabled={saving || isAnchor}
                  />
                  <span className="text-sm truncate flex-1 min-w-0">{c.name}</span>
                  {isAnchor && (
                    <Badge variant="outline" className="text-[9px] shrink-0">
                      {t("manageCourses.anchorBadge", { defaultValue: "Curso original" })}
                    </Badge>
                  )}
                </label>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving || loading || !dirty}>
            {saving ? <Spinner size="sm" className="mr-1" /> : <Layers className="h-4 w-4 mr-1" />}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
