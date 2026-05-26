-- ──────────────────────────────────────────────────────────────────────
-- Daily summary del docente: dejar de mandar email.
--
-- La función `notify_teachers_daily_summary()` (mig 20260523000008) crea
-- una notification "Resumen del día" cada 23:00 Colombia con todo lo
-- pendiente del docente (notas, conversaciones, mensajes, entregas).
--
-- Versión vieja emitía con `kind='feedback'`, que es CRITICAL_KIND y
-- dispara correo automáticamente (predicado `_notification_kind_emails`
-- + edge `send-email` + helper TS `shouldSendEmail`).
--
-- Decisión: el docente quiere recibir email SOLO cuando haya algo que
-- requiera su respuesta inmediata (comentarios pendientes en
-- conversaciones de retroalimentación, mensajes directos). Los
-- resúmenes diarios son "ruido" porque agregan info que el docente ya
-- ve en el dashboard cuando entra a la plataforma; no debería recibir
-- un email por cada día de trabajo.
--
-- Cambio mínimo: emitir la misma notification, pero con `kind='system'`
-- y `link='/app'`. Esa combinación NO matchea ninguna excepción del
-- predicado de email (system solo emaila para `/auth/reset-password`
-- o `/app/admin/system*`), así que la notif en el bell se preserva
-- pero NO viaja por correo.
--
-- Los emails individuales por comentario nuevo (`notify_feedback_event`
-- con `kind='feedback'`) y por mensaje nuevo (`tg_notify_new_message`
-- con `kind='info'` + link `/app/messages%`) SIGUEN iguales — esos son
-- exactamente los casos de "pendiente de respuesta" que el docente sí
-- quiere recibir por correo.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notify_teachers_daily_summary()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec RECORD;
  _count INTEGER := 0;
  _total INTEGER;
  _body TEXT;
BEGIN
  FOR rec IN
    SELECT
      tally.teacher_id,
      tally.pending_notes,
      tally.pending_responses,
      tally.unanswered_msgs,
      tally.ungraded_subs
    FROM (
      SELECT
        ct.user_id AS teacher_id,

        -- (A) Notas de apoyo pendientes en sus cursos
        (
          SELECT COUNT(*)
            FROM public.support_notes sn
            JOIN public.course_teachers ct2
              ON ct2.course_id = sn.course_id
             AND ct2.user_id  = ct.user_id
           WHERE sn.status = 'pending'
        ) AS pending_notes,

        -- (B) Conversaciones de feedback ABIERTAS esperando al docente
        (
          SELECT COUNT(*)
            FROM public.feedback_threads ft
            JOIN public.course_teachers ct2
              ON ct2.course_id = ft.course_id
             AND ct2.user_id  = ct.user_id
           WHERE ft.status = 'open'
             AND ft.last_actor_role = 'student'
        ) AS pending_responses,

        -- (C) Mensajes 1-a-1 sin responder dirigidos al docente
        (
          SELECT COUNT(DISTINCT mc.id)
            FROM public.message_conversations mc
            JOIN public.messages m
              ON m.conversation_id = mc.id
             AND m.created_at = (
               SELECT MAX(m2.created_at)
                 FROM public.messages m2
                 WHERE m2.conversation_id = mc.id
             )
           WHERE (mc.user_a = ct.user_id OR mc.user_b = ct.user_id)
             AND m.sender_id <> ct.user_id
             AND m.read_at IS NULL
        ) AS unanswered_msgs,

        -- (D) Entregas por calificar (taller + proyecto)
        (
          SELECT
            (
              SELECT COUNT(*)
                FROM public.workshop_submissions ws
                JOIN public.workshops w ON w.id = ws.workshop_id
                JOIN public.course_teachers ct2
                  ON ct2.course_id = w.course_id
                 AND ct2.user_id  = ct.user_id
               WHERE ws.status IN ('submitted', 'in_progress')
                 AND ws.final_grade IS NULL
            ) + (
              SELECT COUNT(*)
                FROM public.project_submissions ps
                JOIN public.projects pr ON pr.id = ps.project_id
                JOIN public.course_teachers ct2
                  ON ct2.course_id = pr.course_id
                 AND ct2.user_id  = ct.user_id
               WHERE ps.status IN ('submitted', 'in_progress')
                 AND ps.final_grade IS NULL
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
        -- CAMBIO 20260705: 'feedback' (CRITICAL → email) → 'system'
        -- (NO emaila para link='/app'). La notif sigue en el bell del
        -- docente; el correo de resumen queda eliminado.
        'system',
        '/app'
      );
      _count := _count + 1;
    END IF;
  END LOOP;

  RETURN _count;
END
$$;

-- ─── Otros digests dirigidos al docente — mismo tratamiento ──────────
-- Estas funciones también generaban email porque emitían con kinds
-- CRITICAL (workshop / exam). El docente solo debe recibir email para
-- comentarios o mensajes pendientes de respuesta. Estos son reminders
-- de tareas pendientes — útiles in-app, pero no deberían generar
-- correos ni resúmenes nocturnos en su bandeja.

-- (A) Talleres que vencen mañana — `kind='workshop'` → email. Flip a system.
CREATE OR REPLACE FUNCTION public.notify_teachers_workshop_due_tomorrow()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _count INTEGER;
BEGIN
  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT
    ct.user_id,
    'Talleres vencen mañana',
    COUNT(*)::text || ' taller(es) del curso ' || c.name || ' vencen mañana.',
    'system',  -- antes 'workshop' (CRITICAL → email). Solo bell.
    '/app/teacher/workshops'
  FROM public.workshops w
  JOIN public.courses c ON c.id = w.course_id
  JOIN public.course_teachers ct ON ct.course_id = c.id
  WHERE w.due_date::date = (CURRENT_DATE + 1)
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
      WHERE n.user_id = ct.user_id
        AND n.title = 'Talleres vencen mañana'
        AND n.link = '/app/teacher/workshops'
        AND n.created_at::date = CURRENT_DATE
    )
  GROUP BY ct.user_id, c.id, c.name;
  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END $$;

-- (B) Entregas pendientes por calificar — `kind='workshop'` → email. Flip a system.
CREATE OR REPLACE FUNCTION public.notify_teachers_pending_grading()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _count INTEGER;
BEGIN
  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT
    ct.user_id,
    'Entregas pendientes por calificar',
    'Tienes ' || COUNT(*)::text || ' entrega(s) en el curso ' || c.name ||
      ' pendientes después de su fecha de cierre.',
    'system',  -- antes 'workshop' (CRITICAL → email). Solo bell.
    '/app/teacher/workshops'
  FROM public.workshop_submissions ws
  JOIN public.workshops w ON w.id = ws.workshop_id
  JOIN public.courses c ON c.id = w.course_id
  JOIN public.course_teachers ct ON ct.course_id = c.id
  WHERE w.due_date < now()
    AND ws.status IN ('entregado', 'ai_revisado')
  GROUP BY ct.user_id, c.id, c.name
  HAVING COUNT(*) > 0;
  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END $$;

-- (C) Notas de apoyo pendientes antes del examen — `kind='exam'` → email.
-- Flip a system. Es un recordatorio operativo, no un "pending reply".
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
$$;

NOTIFY pgrst, 'reload schema';
