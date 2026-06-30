-- ══════════════════════════════════════════════════════════════════════
-- Auditoría papelera (2º pase) — notify_teachers_pending_exam_notes_before_exam.
--
-- El cron `teacher-exam-prep-1h` (cada 10 min) recordaba al docente aprobar las
-- notas de apoyo antes de un examen que estaba EN LA PAPELERA: la query
-- `FROM public.exams e WHERE e.start_time ...` no tenía `e.deleted_at IS NULL`.
-- El resto de recordatorios (exam_starting_soon, window_opens, project/workshop
-- due_soon, teacher_daily_summary) SÍ filtran papelera — esta era la única que
-- faltaba. Un examen borrado no debe disparar NINGUNA notificación.
--
-- Se recrea la función VERBATIM (pg_get_functiondef de prod) + el conjunto
-- `AND e.deleted_at IS NULL` en el WHERE. Idempotente.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.notify_teachers_pending_exam_notes_before_exam(_hours integer DEFAULT 1)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _count INTEGER := 0;
  rec RECORD;
BEGIN
  IF _hours IS NULL OR _hours < 1 OR _hours > 24 THEN
    RETURN 0;
  END IF;

  FOR rec IN
    SELECT
      ct.user_id    AS teacher_id,
      e.id          AS exam_id,
      e.title       AS exam_title,
      COALESCE(c.name, 'sin curso') AS course_name,
      pending.cnt   AS pending_count
    FROM public.exams e
    LEFT JOIN public.courses c ON c.id = e.course_id
    JOIN public.course_teachers ct ON ct.course_id = e.course_id
    JOIN LATERAL (
      SELECT COUNT(*)::int AS cnt
      FROM public.exam_notes en
      JOIN public.exam_assignments ea
        ON ea.user_id = en.user_id AND ea.exam_id = en.exam_id
      WHERE en.exam_id = e.id
        AND en.status = 'pendiente'
    ) pending ON pending.cnt > 0
    WHERE e.start_time > NOW()
      AND e.start_time <= NOW() + make_interval(hours => _hours)
      AND e.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.notifications n
         WHERE n.user_id = ct.user_id
           AND n.link = '/app/teacher/exams/' || e.id::text
           AND n.title LIKE 'Notas de apoyo pendientes antes del examen%'
           AND n.created_at > NOW() - INTERVAL '12 hours'
      )
  LOOP
    INSERT INTO public.notifications (user_id, title, body, kind, link)
    VALUES (
      rec.teacher_id,
      'Notas de apoyo pendientes antes del examen "' || rec.exam_title || '"',
      'El examen "' || rec.exam_title || '" del curso "' || rec.course_name ||
        '" inicia en menos de ' || _hours || ' hora(s) y tienes ' || rec.pending_count ||
        ' nota(s) de apoyo pendiente(s) por aprobar. Revísalas antes del inicio para ' ||
        'que los alumnos puedan usarlas durante el examen.',
      'system',  -- antes 'exam' (CRITICAL → email). Solo bell.
      '/app/teacher/exams/' || rec.exam_id::text
    );
    _count := _count + 1;
  END LOOP;

  RETURN _count;
END
$function$;

NOTIFY pgrst, 'reload schema';
