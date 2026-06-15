-- ══════════════════════════════════════════════════════════════════════
-- RPC para el TABLERO del estudiante: desglose de evaluación POR COHORTE.
--
-- Un curso con cohortes puede asignar actividades DISTINTAS a cada cohorte
-- (via *_assignments). El estudiante quiere ver, en el tablero, qué
-- actividades y qué % aplican a CADA cohorte. Eso requiere leer asignaciones
-- y cohortes de OTROS estudiantes → un alumno NO tiene RLS para eso, así que
-- lo resolvemos con un RPC SECURITY DEFINER que valida pertenencia al curso.
--
-- Devuelve una fila por (cohorte, actividad) cuando esa cohorte tiene AL
-- MENOS un estudiante asignado a la actividad (misma noción que el
-- diagnóstico). El cliente agrupa por cohorte y suma los pesos.
--
-- Pesos POR CURSO: exámenes (exams.weight, 1:N), talleres
-- (workshop_courses.weight, fallback workshops.weight), proyectos
-- (project_courses.weight, fallback projects.weight). cut por curso.
-- Items en papelera excluidos.
-- ══════════════════════════════════════════════════════════════════════

DO $mig$
BEGIN
  IF to_regclass('public.courses') IS NULL
     OR to_regclass('public.course_enrollments') IS NULL
     OR to_regclass('public.profiles') IS NULL
     OR to_regclass('public.exams') IS NULL
     OR to_regclass('public.workshops') IS NULL
     OR to_regclass('public.workshop_courses') IS NULL
     OR to_regclass('public.projects') IS NULL
     OR to_regclass('public.project_courses') IS NULL
     OR to_regclass('public.exam_assignments') IS NULL
     OR to_regclass('public.workshop_assignments') IS NULL
     OR to_regclass('public.project_assignments') IS NULL THEN
    RAISE NOTICE 'skip get_course_cohort_weights: tabla(s) ausente(s)';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.get_course_cohort_weights(_course_id uuid)
  RETURNS TABLE (
    cohorte text,
    kind text,
    item_id uuid,
    title text,
    weight numeric,
    cut_name text,
    cut_position integer
  )
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
  STABLE
  AS $fn$
    WITH authz AS (
      -- Acceso: matriculado o docente del curso, o Admin/SuperAdmin del tenant.
      SELECT 1
       WHERE EXISTS (SELECT 1 FROM public.course_enrollments ce
                      WHERE ce.course_id = _course_id AND ce.user_id = auth.uid())
          OR EXISTS (SELECT 1 FROM public.course_teachers ct
                      WHERE ct.course_id = _course_id AND ct.user_id = auth.uid())
          OR public.is_super_admin()
          OR (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(_course_id))
    ),
    cohorts AS (
      SELECT DISTINCT btrim(p.cohorte) AS cohorte
        FROM public.course_enrollments ce
        JOIN public.profiles p ON p.id = ce.user_id
       WHERE ce.course_id = _course_id
         AND p.cohorte IS NOT NULL AND btrim(p.cohorte) <> ''
    ),
    items AS (
      SELECT 'exam'::text AS kind, e.id AS item_id, e.title,
             COALESCE(e.weight, 0)::numeric AS weight, e.cut_id
        FROM public.exams e
       WHERE e.course_id = _course_id AND e.deleted_at IS NULL AND e.parent_exam_id IS NULL
      UNION ALL
      SELECT 'workshop'::text, w.id, w.title,
             COALESCE(wc.weight, w.weight, 0)::numeric, wc.cut_id
        FROM public.workshop_courses wc
        JOIN public.workshops w ON w.id = wc.workshop_id
       WHERE wc.course_id = _course_id AND w.deleted_at IS NULL
      UNION ALL
      SELECT 'project'::text, pr.id, pr.title,
             COALESCE(pc.weight, pr.weight, 0)::numeric, pc.cut_id
        FROM public.project_courses pc
        JOIN public.projects pr ON pr.id = pc.project_id
       WHERE pc.course_id = _course_id AND pr.deleted_at IS NULL
    )
    SELECT co.cohorte, i.kind, i.item_id, i.title, i.weight,
           gc.name AS cut_name, gc.position AS cut_position
      FROM authz
      CROSS JOIN cohorts co
      CROSS JOIN items i
      LEFT JOIN public.grade_cuts gc ON gc.id = i.cut_id
     WHERE EXISTS (
       SELECT 1
         FROM public.course_enrollments ce
         JOIN public.profiles p ON p.id = ce.user_id
        WHERE ce.course_id = _course_id
          AND btrim(p.cohorte) = co.cohorte
          AND (
            (i.kind = 'exam'     AND EXISTS (SELECT 1 FROM public.exam_assignments ea     WHERE ea.exam_id = i.item_id     AND ea.user_id = ce.user_id))
            OR (i.kind = 'workshop' AND EXISTS (SELECT 1 FROM public.workshop_assignments wa WHERE wa.workshop_id = i.item_id AND wa.user_id = ce.user_id))
            OR (i.kind = 'project'  AND EXISTS (SELECT 1 FROM public.project_assignments pa  WHERE pa.project_id = i.item_id  AND pa.user_id = ce.user_id))
          )
     )
     ORDER BY co.cohorte, gc.position NULLS LAST, i.title
  $fn$;

  GRANT EXECUTE ON FUNCTION public.get_course_cohort_weights(uuid) TO authenticated;
END
$mig$;

NOTIFY pgrst, 'reload schema';
