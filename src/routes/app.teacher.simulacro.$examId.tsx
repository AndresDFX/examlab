/**
 * SIMULACRO de examen: el docente rinde su propio examen para ver cómo lo ve el
 * estudiante, y **nada se guarda ni se califica**.
 *
 * ── Por qué reusa la pantalla del alumno y no una copia ───────────────
 * Lo que se viene a probar es EXACTAMENTE esa pantalla: el temporizador, la
 * navegación secuencial, la mezcla de preguntas, el aviso de entrega en blanco,
 * el editor de código con su compilador, la consola de red, la hoja de SQL y el
 * proctoring. Una vista previa aparte se vería parecida y mentiría en el primer
 * detalle que alguien cambie de un lado y no del otro — que es justo el bug que
 * una vista previa debería atrapar. Se importa el componente, igual que
 * `app.teacher.courses` importa `AdminCourses`.
 *
 * ── Dónde vive la garantía de que no escribe ──────────────────────────
 * En `clienteDeSimulacro` (un cliente que lee igual y no sabe escribir) más
 * cuatro cortes explícitos en la pantalla, documentados ahí: no se lee ni se
 * crea la entrega, no se monta la cola offline, y terminar el ensayo no pasa
 * por el camino que encola la calificación con IA. No es un `if` repartido por
 * once escrituras.
 *
 * ── Por qué NO cuelga de `/app/teacher/exams/$examId` ─────────────────
 * Porque ahí sería una ruta HIJA de `app.teacher.exams.$examId.tsx`, que es la
 * pantalla de edición y no tiene `<Outlet/>`. Con TanStack, un hijo que su padre
 * no renderiza simplemente NO APARECE: la URL cambia y se sigue viendo el
 * formulario de editar, sin ningún error. Es el mismo bug que ya está
 * documentado en `app.teacher.whiteboards.index.tsx`. Como ruta hermana no
 * depende de que nadie la renderice.
 *
 * ── Quién entra ──────────────────────────────────────────────────────
 * El prefijo `/app/teacher/simulacro` se agrega a RBAC (Docente/Admin/
 * SuperAdmin) y a `PREFIX_TO_MODULE` apuntando al módulo `exams`, que es el que
 * gobierna su visibilidad. Lo que además agrega esta pantalla es el ALCANCE: un
 * docente solo simula exámenes de SUS cursos. Eso no lo puede dar la base —`courses_select_in_tenant` deja ver
 * todos los cursos de la institución a propósito— y lo decide el rol ACTIVO, no
 * los roles poseídos. Es la regla de `course-scope.ts`.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { Button } from "@/components/ui/button";
import { PageLoader } from "@/components/ui/loaders";
import { EmptyState } from "@/components/ui/empty-state";
import { needsTeacherScope, scopedCourseIds } from "@/modules/courses/course-scope";
import { TakeExam } from "@/modules/exams/TakeExamScreen";

export const Route = createFileRoute("/app/teacher/simulacro/$examId")({
  component: SimulacroDeExamen,
});

function SimulacroDeExamen() {
  const { examId } = Route.useParams();
  const { t } = useTranslation();
  const { user, roles } = useAuth();
  const activeRole = useActiveRole();
  const navigate = useNavigate();
  const [permitido, setPermitido] = useState<boolean | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      const { data: examen } = await supabase
        .from("exams")
        .select("course_id")
        .eq("id", examId)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (!examen?.course_id) {
        setPermitido(false);
        return;
      }
      // `null` = sin acotar (Admin / SuperAdmin). Un arreglo VACÍO es un docente
      // sin cursos, y ahí no se consulta nada: no tiene ninguno que simular.
      const mios = needsTeacherScope(activeRole, roles)
        ? await scopedCourseIds(activeRole, roles, user.id)
        : null;
      if (cancelled) return;
      setPermitido(mios === null || mios.includes(examen.course_id));
    })();
    return () => {
      cancelled = true;
    };
  }, [examId, user, activeRole, roles]);

  if (permitido === null) return <PageLoader />;
  if (!permitido) {
    return (
      <EmptyState
        title={t("simulacroExamen.sinAcceso")}
        description={t("simulacroExamen.sinAccesoDetalle")}
        action={
          <Button onClick={() => navigate({ to: "/app/teacher/exams" })}>
            {t("simulacroExamen.volverAExamenes")}
          </Button>
        }
      />
    );
  }
  return <TakeExam examId={examId} simulacro />;
}
