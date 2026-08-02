/**
 * Aviso accionable cuando el docente no tiene NINGÚN curso asignado.
 *
 * Es la contraparte honesta del scoping de [course-scope.ts](./course-scope.ts):
 * si el docente no figura en `course_teachers` de ningún curso, estas pantallas
 * quedan vacías, y sin explicación eso se lee como "la app está rota" en vez de
 * "falta que me asignen". Peor: el botón "Nuevo …" sigue habilitado y su Select
 * de curso abre vacío — una acción a medias enseña que la pantalla no sirve.
 *
 * La condición vive ACÁ y no en cada pantalla a propósito: son seis, y repetir
 * `courses.length === 0 && needsTeacherScope(...)` en cada una es justo el tipo
 * de regla duplicada que se desincroniza (fue la causa raíz del bug que originó
 * todo esto). El call site queda en una línea.
 *
 * No se muestra al Admin: para él una institución sin cursos es un estado
 * legítimo que su propio empty state ya explica.
 */

import { useTranslation } from "react-i18next";
import { GraduationCap } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { needsTeacherScope } from "@/modules/courses/course-scope";

export function NoAssignedCoursesNotice({
  courseCount,
  loading = false,
}: {
  /** Cursos ya acotados que la pantalla cargó. */
  courseCount: number;
  /** Mientras carga NO se muestra: si no, aparece un frame y desaparece. */
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const { roles } = useAuth();
  const activeRole = useActiveRole();
  if (loading || courseCount > 0) return null;
  if (!needsTeacherScope(activeRole, roles)) return null;
  return (
    <Alert>
      <GraduationCap className="h-4 w-4" />
      <AlertTitle>{t("courses.noAssignedTitle")}</AlertTitle>
      <AlertDescription>{t("courses.noAssignedHint")}</AlertDescription>
    </Alert>
  );
}
