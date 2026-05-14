-- ──────────────────────────────────────────────────────────────────────
-- Notificaciones para el docente — dos jobs nuevos:
--
-- 1) `notify_teachers_pending_exam_notes_before_exam(_hours)` — si un
--    examen arranca en <_hours> y hay notas de apoyo pendientes por
--    aprobar, le manda al docente del curso una notif con el conteo y
--    el link al examen. Mismo patrón que `notify_students_exam_starting_soon`
--    (idempotencia 12h, kind='exam' → dispara correo).
--
-- 2) `notify_teachers_daily_summary()` — agrupa el estado pendiente del
--    día (notas por aprobar, conversaciones de feedback esperando
--    respuesta, mensajes sin responder, entregas por calificar) en UNA
--    notificación por docente. Se ejecuta a las 23:00 hora local
--    (04:00 UTC) y solo si hay ≥1 item pendiente — no spammea con
--    "resumen: 0 pendientes".
-- ──────────────────────────────────────────────────────────────────────

-- 1) ───────────────────── Recordatorio 1h antes — para el docente

CREATE OR REPLACE FUNCTION public.notify_teachers_pending_exam_notes_before_exam(
  _hours INTEGER DEFAULT 1
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _count INTEGER := 0;
  rec RECORD;
BEGIN
  IF _hours IS NULL OR _hours < 1 OR _hours > 24 THEN
    RETURN 0;
  END IF;

  -- Para cada combinación (examen que arranca pronto × docente del
  -- curso), si hay notas pendientes y aún no se notificó, insertamos.
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
      -- Cuenta notas de apoyo pendientes para alumnos asignados a este
      -- examen específico. Solo cuenta notas de alumnos que realmente
      -- van a presentar el examen (vía exam_assignments).
      SELECT COUNT(*)::int AS cnt
      FROM public.exam_notes en
      JOIN public.exam_assignments ea
        ON ea.user_id = en.user_id AND ea.exam_id = en.exam_id
      WHERE en.exam_id = e.id
        AND en.status = 'pendiente'
    ) pending ON pending.cnt > 0
    WHERE e.start_time > NOW()
      AND e.start_time <= NOW() + make_interval(hours => _hours)
      -- Idempotencia: no notificar dos veces al mismo docente para el
      -- mismo examen en 12h.
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
      'exam',
      '/app/teacher/exams/' || rec.exam_id::text
    );
    _count := _count + 1;
  END LOOP;

  RETURN _count;
END
$$;

REVOKE ALL ON FUNCTION public.notify_teachers_pending_exam_notes_before_exam(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_teachers_pending_exam_notes_before_exam(INTEGER) TO service_role;


-- 2) ───────────────────── Resumen diario a las 23:00

CREATE OR REPLACE FUNCTION public.notify_teachers_daily_summary()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _count INTEGER := 0;
  rec RECORD;
  _body TEXT;
  _total INTEGER;
BEGIN
  FOR rec IN
    SELECT
      teacher_id,
      pending_notes,
      pending_responses,
      unanswered_msgs,
      ungraded_subs
    FROM (
      SELECT
        ct.user_id AS teacher_id,

        -- A) Notas de apoyo pendientes de aprobar en sus cursos
        (
          SELECT COUNT(*)::int
          FROM public.exam_notes en
          JOIN public.exams e ON e.id = en.exam_id
          WHERE en.status = 'pendiente'
            AND e.course_id IN (
              SELECT course_id FROM public.course_teachers WHERE user_id = ct.user_id
            )
        ) AS pending_notes,

        -- B) Conversaciones de feedback ABIERTAS donde el ÚLTIMO
        --    comment no fue del docente (= esperan respuesta del docente).
        --    Resolvemos course_id por el parent_kind del thread.
        (
          WITH my_courses AS (
            SELECT course_id FROM public.course_teachers WHERE user_id = ct.user_id
          ),
          open_in_my_courses AS (
            SELECT ft.id AS thread_id
            FROM public.feedback_threads ft
            WHERE NOT ft.closed
              AND (
                (ft.parent_kind = 'exam' AND EXISTS (
                  SELECT 1 FROM public.submissions s
                  JOIN public.exams e2 ON e2.id = s.exam_id
                  WHERE s.id = ft.submission_id
                    AND e2.course_id IN (SELECT course_id FROM my_courses)
                ))
                OR (ft.parent_kind = 'workshop' AND EXISTS (
                  SELECT 1 FROM public.workshop_submissions ws
                  JOIN public.workshops w ON w.id = ws.workshop_id
                  WHERE ws.id = ft.submission_id
                    AND w.course_id IN (SELECT course_id FROM my_courses)
                ))
                OR (ft.parent_kind = 'project' AND EXISTS (
                  SELECT 1 FROM public.project_submissions ps
                  JOIN public.projects p ON p.id = ps.project_id
                  WHERE ps.id = ft.submission_id
                    AND p.course_id IN (SELECT course_id FROM my_courses)
                ))
              )
          ),
          last_per_thread AS (
            SELECT DISTINCT ON (thread_id)
                   thread_id,
                   author_role
            FROM public.feedback_comments
            WHERE thread_id IN (SELECT thread_id FROM open_in_my_courses)
            ORDER BY thread_id, created_at DESC
          )
          SELECT COUNT(*)::int
          FROM last_per_thread
          -- `author_role = 'teacher'` significa que el docente ya respondió
          -- último — no es pending. Cualquier otro rol (o NULL) sí.
          WHERE author_role IS DISTINCT FROM 'teacher'
        ) AS pending_responses,

        -- C) Mensajes 1-a-1 sin responder. Reusa la lógica de
        --    count_unanswered_conversations pero parametrizada por
        --    teacher_id en vez de auth.uid().
        (
          SELECT COUNT(*)::int FROM (
            SELECT DISTINCT ON (m.conversation_id)
                   m.conversation_id,
                   m.sender_id
            FROM public.messages m
            JOIN public.conversations c ON c.id = m.conversation_id
            WHERE (c.user_a = ct.user_id OR c.user_b = ct.user_id)
              AND (
                (c.user_a = ct.user_id
                 AND (c.user_a_cleared_at IS NULL OR m.created_at > c.user_a_cleared_at))
                OR (c.user_b = ct.user_id
                 AND (c.user_b_cleared_at IS NULL OR m.created_at > c.user_b_cleared_at))
              )
            ORDER BY m.conversation_id, m.created_at DESC
          ) latest
          WHERE latest.sender_id <> ct.user_id
        ) AS unanswered_msgs,

        -- D) Entregas por calificar (talleres + proyectos en sus cursos).
        --    Excluye exámenes porque la IA + auto-grade los cubre.
        (
          (
            SELECT COUNT(*)::int
            FROM public.workshop_submissions ws
            JOIN public.workshops w ON w.id = ws.workshop_id
            WHERE ws.status IN ('entregado', 'ai_revisado')
              AND w.course_id IN (
                SELECT course_id FROM public.course_teachers WHERE user_id = ct.user_id
              )
          )
          +
          (
            SELECT COUNT(*)::int
            FROM public.project_submissions ps
            JOIN public.projects p ON p.id = ps.project_id
            WHERE ps.status IN ('entregado', 'ai_revisado')
              AND p.course_id IN (
                SELECT course_id FROM public.course_teachers WHERE user_id = ct.user_id
              )
          )
        ) AS ungraded_subs

      FROM (SELECT DISTINCT user_id FROM public.course_teachers) ct
    ) tally
    WHERE pending_notes + pending_responses + unanswered_msgs + ungraded_subs > 0
  LOOP
    _total := rec.pending_notes + rec.pending_responses + rec.unanswered_msgs + rec.ungraded_subs;

    _body := 'Tienes ' || _total || ' item(s) pendiente(s) en la plataforma:';
    IF rec.pending_notes > 0 THEN
      _body := _body || E'\n• ' || rec.pending_notes || ' nota(s) de apoyo por aprobar';
    END IF;
    IF rec.pending_responses > 0 THEN
      _body := _body || E'\n• ' || rec.pending_responses || ' conversación(es) de retroalimentación esperando tu respuesta';
    END IF;
    IF rec.unanswered_msgs > 0 THEN
      _body := _body || E'\n• ' || rec.unanswered_msgs || ' mensaje(s) directo(s) sin responder';
    END IF;
    IF rec.ungraded_subs > 0 THEN
      _body := _body || E'\n• ' || rec.ungraded_subs || ' entrega(s) (taller/proyecto) por calificar';
    END IF;
    _body := _body || E'\n\nEntra a la plataforma para revisarlos.';

    -- Idempotencia: una sola notif "Resumen del día" por docente por día.
    IF NOT EXISTS (
      SELECT 1 FROM public.notifications n
       WHERE n.user_id = rec.teacher_id
         AND n.title = 'Resumen del día'
         AND n.created_at::date = CURRENT_DATE
    ) THEN
      INSERT INTO public.notifications (user_id, title, body, kind, link)
      VALUES (
        rec.teacher_id,
        'Resumen del día',
        _body,
        'feedback',  -- CRITICAL_KIND → dispara correo
        '/app'
      );
      _count := _count + 1;
    END IF;
  END LOOP;

  RETURN _count;
END
$$;

REVOKE ALL ON FUNCTION public.notify_teachers_daily_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_teachers_daily_summary() TO service_role;

NOTIFY pgrst, 'reload schema';

-- ─────────────────────────────────────────────── Programación
-- Ejecutá una sola vez en SQL Editor después de aplicar la migración:
--
--   -- Cada 10 min: chequea exámenes que arrancan en próx 1h y avisa
--   -- al docente si quedan notas por aprobar.
--   SELECT cron.schedule(
--     'teacher-exam-prep-1h',
--     '*/10 * * * *',
--     $$ SELECT public.notify_teachers_pending_exam_notes_before_exam(1); $$
--   );
--
--   -- Diario a las 23:00 hora Colombia = 04:00 UTC. pg_cron interpreta
--   -- el schedule en UTC por default.
--   SELECT cron.schedule(
--     'teacher-daily-summary',
--     '0 4 * * *',
--     $$ SELECT public.notify_teachers_daily_summary(); $$
--   );
