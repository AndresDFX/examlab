-- ──────────────────────────────────────────────────────────────────────
-- Fix: notify_teachers_daily_summary() referenciaba tablas/columnas que
-- NO existen → el cron crasheaba con "relation public.support_notes does
-- not exist".
--
-- Errores en la versión previa (mig 20260523000008 / 20260705100000):
--   - `support_notes`            → la tabla real es `exam_notes`
--     (y se enlaza al curso por exam_id → exams.course_id, NO tiene
--      course_id propio; el status pendiente es 'pendiente', no 'pending').
--   - `message_conversations`    → la tabla real es `conversations`.
--   - `messages.read_at`         → no existe (el "leído" vive en
--                                   conversations.user_*_last_read_at).
--   - `feedback_threads.status` / `last_actor_role` → no existen
--                                   (la tabla usa `closed` boolean).
--
-- Decisión: el resumen diario conserva los DOS tallies que se computan de
-- forma confiable y barata contra el esquema real:
--   (A) notas de examen pendientes por aprobar, y
--   (B) entregas (taller/proyecto) por calificar.
-- Se QUITAN del digest los conteos de "conversaciones de feedback" y
-- "mensajes sin responder": su cómputo correcto depende de lógica de
-- último-actor / last_read_at que ya dispara notificaciones POR EVENTO
-- (`notify_feedback_event` con kind='feedback' → email, y
-- `tg_notify_new_message` con kind='info' → email). O sea, el docente ya
-- se entera de esos pendientes en el momento; no aportaban al resumen
-- nocturno y eran justo las ramas rotas.
--
-- kind='system' + link='/app' se mantiene (no dispara correo; solo bell).
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
      tally.ungraded_subs
    FROM (
      SELECT
        ct.user_id AS teacher_id,

        -- (A) Notas de apoyo (exam_notes) pendientes de aprobar en los
        --     cursos del docente. exam_notes → exams → course_teachers.
        (
          SELECT COUNT(*)
            FROM public.exam_notes en
            JOIN public.exams e        ON e.id = en.exam_id
            JOIN public.course_teachers ct2
              ON ct2.course_id = e.course_id
             AND ct2.user_id   = ct.user_id
           WHERE en.status = 'pendiente'
        ) AS pending_notes,

        -- (B) Entregas (taller + proyecto) por calificar.
        (
          (
            SELECT COUNT(*)
              FROM public.workshop_submissions ws
              JOIN public.workshops w ON w.id = ws.workshop_id
              JOIN public.course_teachers ct2
                ON ct2.course_id = w.course_id
               AND ct2.user_id   = ct.user_id
             WHERE ws.status IN ('submitted', 'in_progress')
               AND ws.final_grade IS NULL
          ) + (
            SELECT COUNT(*)
              FROM public.project_submissions ps
              JOIN public.projects pr ON pr.id = ps.project_id
              JOIN public.course_teachers ct2
                ON ct2.course_id = pr.course_id
               AND ct2.user_id   = ct.user_id
             WHERE ps.status IN ('submitted', 'in_progress')
               AND ps.final_grade IS NULL
          )
        ) AS ungraded_subs

      FROM (SELECT DISTINCT user_id FROM public.course_teachers) ct
    ) tally
    WHERE tally.pending_notes + tally.ungraded_subs > 0
  LOOP
    _total := rec.pending_notes + rec.ungraded_subs;
    _body := 'Tienes ' || _total || ' item(s) pendiente(s) en la plataforma:';
    IF rec.pending_notes > 0 THEN
      _body := _body || E'\n• ' || rec.pending_notes || ' nota(s) de apoyo por aprobar';
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
      VALUES (rec.teacher_id, 'Resumen del día', _body, 'system', '/app');
      _count := _count + 1;
    END IF;
  END LOOP;

  RETURN _count;
END
$$;

NOTIFY pgrst, 'reload schema';
