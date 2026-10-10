-- El recordatorio «Tu examen … inicia pronto» llevaba a /app/student/exams sin
-- decir CUÁL examen. Tocado después del cierre, la lista (que esconde lo cerrado
-- por defecto) quedaba vacía, sin rastro del examen (caso real 2026-10-10, UNIAJ).
-- Ahora el enlace lleva el id y la lista lo muestra aunque el filtro lo deje
-- afuera. Solo cambia el enlace; el resto es el cuerpo de 20262630000000.
DO $mig$
BEGIN
  IF to_regclass('public.exams') IS NULL OR to_regclass('public.exam_assignments') IS NULL
     OR to_regclass('public.notifications') IS NULL THEN
    RAISE NOTICE 'skip exam_reminder: tabla(s) ausente(s)';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.notify_students_exam_starting_soon(
    _hours INTEGER DEFAULT 1
  )
  RETURNS INTEGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $fn$
  DECLARE
    _count INTEGER;
  BEGIN
    IF _hours IS NULL OR _hours < 1 OR _hours > 24 THEN
      RETURN 0;
    END IF;

    INSERT INTO public.notifications (user_id, title, body, kind, link)
    SELECT
      ea.user_id,
      'Tu examen "' || e.title || '" inicia pronto',
      'El examen del curso "' || COALESCE(c.name, 'sin curso') ||
        '" inicia en menos de ' || _hours || ' hora(s). Prepárate.',
      'exam_reminder',
      '/app/student/exams?exam=' || e.id::text
    FROM public.exams e
    LEFT JOIN public.courses c ON c.id = e.course_id
    JOIN public.exam_assignments ea ON ea.exam_id = e.id
    WHERE e.start_time > NOW()
      AND e.start_time <= NOW() + make_interval(hours => _hours)
      -- Papelera: un examen soft-deleted no debe recordar "inicia pronto".
      AND e.deleted_at IS NULL
      -- Solo exámenes PUBLICADOS: un borrador puede tener estudiantes asignados
      -- y no debe avisarles de un examen que todavía no existe para ellos.
      AND e.status = 'published'
      AND COALESCE(e.is_external, false) = false
      AND NOT EXISTS (
        SELECT 1 FROM public.submissions s
         WHERE s.exam_id = e.id
           AND s.user_id = ea.user_id
           AND s.status IN ('completado', 'sospechoso')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.notifications n
         WHERE n.user_id = ea.user_id
           AND n.title = 'Tu examen "' || e.title || '" inicia pronto'
           AND n.created_at > NOW() - INTERVAL '2 hours'
      );

    GET DIAGNOSTICS _count = ROW_COUNT;
    RETURN _count;
  END
  $fn$;

  REVOKE ALL ON FUNCTION public.notify_students_exam_starting_soon(INTEGER) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.notify_students_exam_starting_soon(INTEGER) TO service_role;
END
$mig$;
