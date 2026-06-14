-- ══════════════════════════════════════════════════════════════════════
-- Guards de PAPELERA (soft-delete) en RPCs/funciones SECURITY DEFINER que
-- aún leían entidades soft-deletables (exams / workshops / projects / polls)
-- SIN filtrar `deleted_at IS NULL`.
--
-- REGLA UNIVERSAL (CLAUDE.md): cuando algo se elimina y va a la PAPELERA
-- deja de ser visualizable Y usable en CUALQUIER flujo y rol hasta que se
-- restaure. Estas funciones corren por pg_cron / service_role (notifs y
-- digest) o como RPC del docente (kahoot_create_game); todas omitían el
-- filtro, así que un examen/taller/proyecto/encuesta en papelera seguía
-- notificando, inflando el resumen diario, o pudiendo hospedar un Kahoot.
--
-- Las migraciones ya deployadas son INMUTABLES → se recrean acá con
-- CREATE OR REPLACE (misma firma → no cambia el RETURNS) agregando el guard.
-- Cuerpos idénticos a la última versión de cada función; el ÚNICO cambio
-- es el `AND <alias>.deleted_at IS NULL` (o el guard en el RPC de kahoot).
--
-- Fuentes recreadas:
--   notify_students_exam_window_opens     ← 20260516110000
--   notify_students_exam_starting_soon    ← 20260523000006
--   notify_students_workshop_due_soon     ← 20260523000007
--   notify_students_project_due_soon      ← 20260523000007
--   notify_teachers_daily_summary         ← 20260712000000 (última)
--   kahoot_create_game                    ← 20260935000000 (última)
--
-- Guard defensivo `to_regclass`: si alguna tabla no existe en este entorno,
-- saltamos su CREATE OR REPLACE para no abortar el deploy (patrón Lovable).
-- ══════════════════════════════════════════════════════════════════════

-- ── A) notify_students_exam_window_opens ────────────────────────────────
DO $mig$
BEGIN
  IF to_regclass('public.exams') IS NULL
     OR to_regclass('public.exam_assignments') IS NULL THEN
    RAISE NOTICE 'skip notify_students_exam_window_opens: tabla(s) ausente(s)';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.notify_students_exam_window_opens(
    _lookback_minutes INTEGER DEFAULT 30
  )
  RETURNS INTEGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $fn$
  DECLARE
    _count INTEGER;
  BEGIN
    IF _lookback_minutes IS NULL OR _lookback_minutes < 1 OR _lookback_minutes > 360 THEN
      RETURN 0;
    END IF;

    INSERT INTO public.notifications (user_id, title, body, kind, link)
    SELECT
      ea.user_id,
      'Tu examen "' || e.title || '" ya está disponible',
      'La ventana de presentación se abrió. Tienes hasta ' ||
        to_char(e.end_time AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI') ||
        ' para presentarlo.',
      'exam',
      '/app/student/take/' || e.id::text
    FROM public.exams e
    JOIN public.exam_assignments ea ON ea.exam_id = e.id
    WHERE e.start_time <= NOW()
      AND e.start_time > NOW() - make_interval(mins => _lookback_minutes)
      AND e.end_time > NOW()
      -- Papelera: un examen soft-deleted no debe notificar "ya disponible"
      -- ni dar deep-link a /app/student/take/<exam_id>.
      AND e.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.submissions s
         WHERE s.exam_id = e.id
           AND s.user_id = ea.user_id
           AND s.status IN ('completado', 'sospechoso')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.notifications n
         WHERE n.user_id = ea.user_id
           AND n.title = 'Tu examen "' || e.title || '" ya está disponible'
           AND n.created_at > NOW() - INTERVAL '12 hours'
      );

    GET DIAGNOSTICS _count = ROW_COUNT;
    RETURN _count;
  END
  $fn$;

  REVOKE ALL ON FUNCTION public.notify_students_exam_window_opens(INTEGER) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.notify_students_exam_window_opens(INTEGER) TO service_role;
END
$mig$;

-- ── B) notify_students_exam_starting_soon ───────────────────────────────
DO $mig$
BEGIN
  IF to_regclass('public.exams') IS NULL
     OR to_regclass('public.exam_assignments') IS NULL THEN
    RAISE NOTICE 'skip notify_students_exam_starting_soon: tabla(s) ausente(s)';
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
      'exam',
      '/app/student/exams'
    FROM public.exams e
    LEFT JOIN public.courses c ON c.id = e.course_id
    JOIN public.exam_assignments ea ON ea.exam_id = e.id
    WHERE e.start_time > NOW()
      AND e.start_time <= NOW() + make_interval(hours => _hours)
      -- Papelera: un examen soft-deleted no debe recordar "inicia pronto".
      AND e.deleted_at IS NULL
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

  REVOKE ALL ON FUNCTION public.notify_students_exam_starting_soon(INTEGER) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.notify_students_exam_starting_soon(INTEGER) TO service_role;
END
$mig$;

-- ── C) notify_students_workshop_due_soon ────────────────────────────────
DO $mig$
BEGIN
  IF to_regclass('public.workshops') IS NULL
     OR to_regclass('public.workshop_assignments') IS NULL THEN
    RAISE NOTICE 'skip notify_students_workshop_due_soon: tabla(s) ausente(s)';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.notify_students_workshop_due_soon(
    _hours INTEGER DEFAULT 24
  )
  RETURNS INTEGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $fn$
  DECLARE
    _count INTEGER;
  BEGIN
    IF _hours IS NULL OR _hours < 1 OR _hours > 168 THEN
      RETURN 0;
    END IF;

    INSERT INTO public.notifications (user_id, title, body, kind, link)
    SELECT
      wa.user_id,
      'Tu taller "' || w.title || '" vence pronto',
      'El taller del curso "' || COALESCE(c.name, 'sin curso') ||
        '" vence en menos de ' || _hours || ' hora(s). Entrega antes del cierre.',
      'workshop',
      '/app/student/workshops'
    FROM public.workshops w
    LEFT JOIN public.courses c ON c.id = w.course_id
    JOIN public.workshop_assignments wa ON wa.workshop_id = w.id
    WHERE w.due_date IS NOT NULL
      AND w.due_date > NOW()
      AND w.due_date <= NOW() + make_interval(hours => _hours)
      AND w.status = 'published'
      -- Papelera: un taller soft-deleted (puede seguir published + con
      -- due_date futuro) no debe recordar "vence pronto".
      AND w.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.workshop_submissions s
         WHERE s.workshop_id = w.id
           AND s.user_id = wa.user_id
           AND s.status IN ('entregado', 'calificado', 'ai_revisado')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.notifications n
         WHERE n.user_id = wa.user_id
           AND n.title = 'Tu taller "' || w.title || '" vence pronto'
           AND n.created_at > NOW() - INTERVAL '6 hours'
      );

    GET DIAGNOSTICS _count = ROW_COUNT;
    RETURN _count;
  END
  $fn$;

  REVOKE ALL ON FUNCTION public.notify_students_workshop_due_soon(INTEGER) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.notify_students_workshop_due_soon(INTEGER) TO service_role;
END
$mig$;

-- ── D) notify_students_project_due_soon ─────────────────────────────────
DO $mig$
BEGIN
  IF to_regclass('public.projects') IS NULL
     OR to_regclass('public.project_assignments') IS NULL
     OR to_regclass('public.project_courses') IS NULL THEN
    RAISE NOTICE 'skip notify_students_project_due_soon: tabla(s) ausente(s)';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.notify_students_project_due_soon(
    _hours INTEGER DEFAULT 24
  )
  RETURNS INTEGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $fn$
  DECLARE
    _count INTEGER;
  BEGIN
    IF _hours IS NULL OR _hours < 1 OR _hours > 168 THEN
      RETURN 0;
    END IF;

    INSERT INTO public.notifications (user_id, title, body, kind, link)
    SELECT DISTINCT
      target.user_id,
      'Tu proyecto "' || p.title || '" vence pronto',
      'El proyecto vence en menos de ' || _hours || ' hora(s). Entrega antes del cierre.',
      'project',
      '/app/student/projects'
    FROM public.projects p
    CROSS JOIN LATERAL (
      SELECT pa.user_id
        FROM public.project_assignments pa
       WHERE pa.project_id = p.id
      UNION
      SELECT ce.user_id
        FROM public.project_courses pc
        JOIN public.course_enrollments ce ON ce.course_id = pc.course_id
       WHERE pc.project_id = p.id
    ) target
    WHERE p.due_date IS NOT NULL
      AND p.due_date > NOW()
      AND p.due_date <= NOW() + make_interval(hours => _hours)
      AND p.status = 'published'
      -- Papelera: un proyecto soft-deleted no debe recordar "vence pronto".
      AND p.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.project_submissions s
         WHERE s.project_id = p.id
           AND s.user_id = target.user_id
           AND s.status IN ('entregado', 'calificado', 'ai_revisado')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.notifications n
         WHERE n.user_id = target.user_id
           AND n.title = 'Tu proyecto "' || p.title || '" vence pronto'
           AND n.created_at > NOW() - INTERVAL '6 hours'
      );

    GET DIAGNOSTICS _count = ROW_COUNT;
    RETURN _count;
  END
  $fn$;

  REVOKE ALL ON FUNCTION public.notify_students_project_due_soon(INTEGER) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.notify_students_project_due_soon(INTEGER) TO service_role;
END
$mig$;

-- ── E) notify_teachers_daily_summary ────────────────────────────────────
-- El resumen nocturno cuenta entregas por calificar (taller + proyecto) y
-- notas de examen pendientes. Sin guard, incluía items en papelera y
-- inflaba el digest.
DO $mig$
BEGIN
  IF to_regclass('public.exam_notes') IS NULL
     OR to_regclass('public.exams') IS NULL
     OR to_regclass('public.workshops') IS NULL
     OR to_regclass('public.projects') IS NULL
     OR to_regclass('public.course_teachers') IS NULL THEN
    RAISE NOTICE 'skip notify_teachers_daily_summary: tabla(s) ausente(s)';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.notify_teachers_daily_summary()
  RETURNS INTEGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $fn$
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
          --     cursos del docente. Papelera: excluir notas de exámenes
          --     soft-deleted.
          (
            SELECT COUNT(*)
              FROM public.exam_notes en
              JOIN public.exams e        ON e.id = en.exam_id
              JOIN public.course_teachers ct2
                ON ct2.course_id = e.course_id
               AND ct2.user_id   = ct.user_id
             WHERE en.status = 'pendiente'
               AND e.deleted_at IS NULL
          ) AS pending_notes,

          -- (B) Entregas (taller + proyecto) por calificar. Papelera:
          --     excluir entregas de talleres/proyectos soft-deleted.
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
                 AND w.deleted_at IS NULL
            ) + (
              SELECT COUNT(*)
                FROM public.project_submissions ps
                JOIN public.projects pr ON pr.id = ps.project_id
                JOIN public.course_teachers ct2
                  ON ct2.course_id = pr.course_id
                 AND ct2.user_id   = ct.user_id
               WHERE ps.status IN ('submitted', 'in_progress')
                 AND ps.final_grade IS NULL
                 AND pr.deleted_at IS NULL
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
  $fn$;

  REVOKE ALL ON FUNCTION public.notify_teachers_daily_summary() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.notify_teachers_daily_summary() TO service_role;
END
$mig$;

-- ── F) kahoot_create_game ───────────────────────────────────────────────
-- Hermano de kahoot_join_game (que ya bloquea unirse a un Kahoot en
-- papelera). Acá agregamos el guard simétrico para que un docente con una
-- referencia stale (o invocando el RPC directo) NO pueda hospedar un juego
-- en vivo sobre un poll soft-deleted.
DO $mig$
BEGIN
  IF to_regclass('public.polls') IS NULL
     OR to_regclass('public.kahoot_games') IS NULL
     OR to_regclass('public.kahoot_questions') IS NULL THEN
    RAISE NOTICE 'skip kahoot_create_game: tabla(s) ausente(s)';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.kahoot_create_game(_poll_id UUID)
  RETURNS public.kahoot_games
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
  DECLARE
    v_uid UUID := auth.uid();
    v_type public.poll_type;
    v_pin TEXT;
    v_n INT;
    v_game public.kahoot_games;
  BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501'; END IF;
    SELECT poll_type INTO v_type FROM public.polls WHERE id = _poll_id;
    IF v_type IS NULL THEN RAISE EXCEPTION 'Encuesta no encontrada' USING ERRCODE = '22023'; END IF;
    -- Papelera: una encuesta soft-deleted se trata como inexistente; no se
    -- puede hospedar un Kahoot en vivo sobre algo que está en la papelera.
    IF EXISTS (SELECT 1 FROM public.polls WHERE id = _poll_id AND deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Encuesta no encontrada' USING ERRCODE = '22023';
    END IF;
    IF v_type <> 'kahoot' THEN RAISE EXCEPTION 'La encuesta no es de tipo Kahoot' USING ERRCODE = 'P0001'; END IF;
    IF NOT (public._poll_anchor_teacher(_poll_id, v_uid) OR public._poll_admin_in_tenant(_poll_id, v_uid)) THEN
      RAISE EXCEPTION 'Solo el docente puede hospedar este Kahoot' USING ERRCODE = '42501';
    END IF;
    SELECT count(*) INTO v_n FROM public.kahoot_questions WHERE poll_id = _poll_id;
    IF v_n = 0 THEN RAISE EXCEPTION 'El Kahoot no tiene preguntas' USING ERRCODE = 'P0001'; END IF;

    LOOP
      v_pin := lpad((floor(random() * 1000000))::int::text, 6, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.kahoot_games WHERE pin = v_pin AND status <> 'ended');
    END LOOP;

    INSERT INTO public.kahoot_games (poll_id, host_id, pin, status, current_index)
    VALUES (_poll_id, v_uid, v_pin, 'lobby', -1)
    RETURNING * INTO v_game;
    RETURN v_game;
  END $fn$;

  GRANT EXECUTE ON FUNCTION public.kahoot_create_game(UUID) TO authenticated;
END
$mig$;

NOTIFY pgrst, 'reload schema';
