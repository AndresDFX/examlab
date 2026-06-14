-- ══════════════════════════════════════════════════════════════════════
-- Cerrar (finalizar) un curso EXIGE que NO haya pendientes de calificación.
--
-- - MANUAL (set_course_status → 'finalizado'): se RECHAZA si quedan entregas
--   sin calificar; el docente debe calificarlas primero (revisar el Diagnóstico).
-- - AUTOMÁTICO (auto_finalize_courses, cron diario): si el curso venció pero
--   tiene pendientes, NO se finaliza y se NOTIFICA a los docentes del curso
--   para que califiquen y finalicen manualmente.
--
-- "Pendiente de calificación" = misma lógica del Diagnóstico/dashboard:
--   examen   : submission status in (completado,sospechoso) + ai_grade NULL +
--              final_override_grade NULL  (excluye exámenes hijos/retry).
--   taller   : status='entregado' + final_grade NULL + ai_grade NULL.
--   proyecto : status='entregado' + final_grade NULL + submission_grade NULL +
--              ai_grade NULL.
--   Solo cuenta entregas de estudiantes MATRICULADOS (course_enrollments) y de
--   items NO en papelera (deleted_at IS NULL).
-- ══════════════════════════════════════════════════════════════════════

-- ── 1) Helper: conteo de pendientes de calificación de un curso ──
DO $mig$
BEGIN
  IF to_regclass('public.courses') IS NULL
     OR to_regclass('public.course_enrollments') IS NULL
     OR to_regclass('public.submissions') IS NULL
     OR to_regclass('public.exams') IS NULL
     OR to_regclass('public.workshop_submissions') IS NULL
     OR to_regclass('public.workshops') IS NULL
     OR to_regclass('public.workshop_courses') IS NULL
     OR to_regclass('public.project_submissions') IS NULL
     OR to_regclass('public.projects') IS NULL
     OR to_regclass('public.project_courses') IS NULL THEN
    RAISE NOTICE 'skip course_pending_grading_count: tabla(s) ausente(s)';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.course_pending_grading_count(_course_id uuid)
  RETURNS integer
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
  STABLE
  AS $fn$
    WITH enrolled AS (
      SELECT user_id FROM public.course_enrollments WHERE course_id = _course_id
    )
    SELECT
      (
        SELECT count(*)
          FROM public.submissions s
          JOIN public.exams e ON e.id = s.exam_id
         WHERE e.course_id = _course_id
           AND e.deleted_at IS NULL
           AND e.parent_exam_id IS NULL
           AND s.status IN ('completado', 'sospechoso')
           AND s.ai_grade IS NULL
           AND s.final_override_grade IS NULL
           AND s.user_id IN (SELECT user_id FROM enrolled)
      )
      +
      (
        SELECT count(*)
          FROM public.workshop_submissions ws
          JOIN public.workshops w ON w.id = ws.workshop_id
         WHERE w.deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM public.workshop_courses wc
              WHERE wc.workshop_id = w.id AND wc.course_id = _course_id
           )
           AND ws.status = 'entregado'
           AND ws.final_grade IS NULL
           AND ws.ai_grade IS NULL
           AND ws.user_id IN (SELECT user_id FROM enrolled)
      )
      +
      (
        SELECT count(*)
          FROM public.project_submissions ps
          JOIN public.projects p ON p.id = ps.project_id
         WHERE p.deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM public.project_courses pc
              WHERE pc.project_id = p.id AND pc.course_id = _course_id
           )
           AND ps.status = 'entregado'
           AND ps.final_grade IS NULL
           AND ps.submission_grade IS NULL
           AND ps.ai_grade IS NULL
           AND ps.user_id IN (SELECT user_id FROM enrolled)
      )
  $fn$;

  GRANT EXECUTE ON FUNCTION public.course_pending_grading_count(uuid) TO authenticated;
END
$mig$;

-- ── 2) set_course_status: bloquear finalizar con pendientes ──
DO $mig$
BEGIN
  IF to_regclass('public.courses') IS NULL THEN
    RAISE NOTICE 'skip set_course_status: courses ausente';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.set_course_status(_course_id UUID, _status TEXT)
  RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $fn$
  DECLARE
    v_pending integer;
  BEGIN
    IF _status NOT IN ('borrador', 'en_curso', 'finalizado') THEN
      RAISE EXCEPTION 'Estado de curso inválido: %', _status;
    END IF;

    IF NOT (
      public.is_super_admin()
      OR (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(_course_id))
      OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = _course_id AND ct.user_id = auth.uid()
      )
    ) THEN
      RAISE EXCEPTION 'No autorizado para cambiar el estado de este curso';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.courses WHERE id = _course_id AND deleted_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'No se puede cambiar el estado de un curso en la papelera';
    END IF;

    -- Finalizar EXIGE no tener pendientes de calificación.
    IF _status = 'finalizado' THEN
      v_pending := public.course_pending_grading_count(_course_id);
      IF v_pending > 0 THEN
        RAISE EXCEPTION 'No se puede finalizar el curso: hay % entrega(s) pendiente(s) de calificación. Califícalas (revisa el Diagnóstico del curso) antes de finalizar.', v_pending;
      END IF;
    END IF;

    UPDATE public.courses
      SET status = _status,
          finalized_at = CASE WHEN _status = 'finalizado' THEN now() ELSE NULL END,
          finalized_by = CASE WHEN _status = 'finalizado' THEN auth.uid() ELSE NULL END
      WHERE id = _course_id;
  END
  $fn$;

  GRANT EXECUTE ON FUNCTION public.set_course_status(UUID, TEXT) TO authenticated;
END
$mig$;

-- ── 3) auto_finalize_courses: finalizar solo si NO hay pendientes; si los hay, notificar ──
DO $mig$
BEGIN
  IF to_regclass('public.courses') IS NULL
     OR to_regclass('public.notifications') IS NULL
     OR to_regclass('public.course_teachers') IS NULL THEN
    RAISE NOTICE 'skip auto_finalize_courses: tabla(s) ausente(s)';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.auto_finalize_courses()
  RETURNS INT
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $fn$
  DECLARE
    rec RECORD;
    v_count INT := 0;
    v_pending INT;
    v_title TEXT;
  BEGIN
    FOR rec IN
      SELECT id, name FROM public.courses
       WHERE status = 'en_curso'
         AND end_date IS NOT NULL
         AND end_date < CURRENT_DATE
         AND deleted_at IS NULL
    LOOP
      v_pending := public.course_pending_grading_count(rec.id);

      IF v_pending = 0 THEN
        -- Sin pendientes → finalizar automáticamente.
        UPDATE public.courses
          SET status = 'finalizado', finalized_at = now(), finalized_by = NULL
          WHERE id = rec.id;
        v_count := v_count + 1;
      ELSE
        -- Con pendientes → NO finalizar; notificar a los docentes del curso
        -- para que califiquen (Diagnóstico) y finalicen manualmente.
        v_title := 'Curso por finalizar: "' || rec.name || '"';
        INSERT INTO public.notifications (user_id, title, body, kind, link)
        SELECT ct.user_id,
               v_title,
               'El curso ya pasó su fecha de fin pero tiene ' || v_pending ||
                 ' entrega(s) pendiente(s) de calificación. Califícalas (revisa el ' ||
                 'Diagnóstico del curso) y finalízalo manualmente.',
               'system',
               '/app/teacher/courses'
          FROM public.course_teachers ct
         WHERE ct.course_id = rec.id
           -- Anti-spam: máximo una notif por docente/curso por día (el cron es diario).
           AND NOT EXISTS (
             SELECT 1 FROM public.notifications n
              WHERE n.user_id = ct.user_id
                AND n.title = v_title
                AND n.created_at > now() - INTERVAL '20 hours'
           );
      END IF;
    END LOOP;

    RETURN v_count;
  END
  $fn$;

  GRANT EXECUTE ON FUNCTION public.auto_finalize_courses() TO authenticated;
END
$mig$;

NOTIFY pgrst, 'reload schema';
