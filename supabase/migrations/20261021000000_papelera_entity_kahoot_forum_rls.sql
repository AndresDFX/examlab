-- ══════════════════════════════════════════════════════════════════════
-- Auditoría papelera (pase 5, loop-until-dry) — cerrar el resto de lecturas/
-- escrituras no-staff que servían/aceptaban contenido de un PADRE en papelera.
--
-- El pase 4 (20261020) gateó whiteboards/polls/attendance_sessions a NIVEL
-- ENTIDAD + las hijas, pero dejó SIN gatear las otras entidades raíz y kahoot/
-- foros. El completeness-critic + lente kahoot encontraron:
--   A. ENTIDAD: exams/workshops/projects/courses `*_select_in_tenant` no filtran
--      deleted_at → un alumno del tenant lee por REST el HEADER (title/description/
--      INSTRUCTIONS/external_link/fechas) de un examen/taller/proyecto/curso en
--      papelera. (workshops/projects exponen el enunciado completo → MED-HIGH.)
--   B. KAHOOT: kahoot_get_state (RPC, ANSWER KEY is_correct en reveal/ended),
--      kahoot_games_select, kahoot_players_select → sin guard de polls.deleted_at;
--      un alumno de un juego cuya encuesta se mandó a la papelera sigue leyendo
--      preguntas/clave/roster por REST/RPC.
--   C. FOROS: forums/forum_threads/forum_replies SELECT + forum_threads/replies
--      INSERT → un alumno LEE y ESCRIBE en el foro de un curso en papelera
--      (is_forum_open no mira courses.deleted_at; la matrícula sobrevive al borrado).
--
-- PRINCIPIO (igual que pases previos): gatear SOLO la rama no-staff con el
-- estado de papelera del padre; el staff (owner/Docente/Admin/SA) conserva
-- acceso para la Papelera/restore. Se usa ALTER POLICY (preserva cmd/roles/
-- permissive). Para foros se introduce `_course_in_papelera` (SECURITY DEFINER,
-- RLS-inmune, espejo de _poll_in_papelera) — así NO hay que tocar is_forum_open
-- (que tiene espejos en JS, invariante cross-file) ni caer en el patrón frágil
-- `NOT EXISTS(courses ...)` bajo RLS.
-- ══════════════════════════════════════════════════════════════════════

-- Helper RLS-inmune: ¿el curso está en la papelera?
CREATE OR REPLACE FUNCTION public._course_in_papelera(_course_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.courses WHERE id = _course_id AND deleted_at IS NOT NULL);
$fn$;
REVOKE ALL ON FUNCTION public._course_in_papelera(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._course_in_papelera(uuid) TO authenticated;

-- ── A) Entidades raíz: gate no-staff con deleted_at (staff ve trashed → Papelera) ──
ALTER POLICY courses_select_in_tenant ON public.courses
  USING (
    public.is_super_admin()
    OR (
      tenant_id = public.current_tenant_id()
      AND (deleted_at IS NULL OR public.has_role(auth.uid(), 'Docente'::public.app_role) OR public.has_role(auth.uid(), 'Admin'::public.app_role))
    )
  );

ALTER POLICY exams_select_in_tenant ON public.exams
  USING (
    public.is_super_admin()
    OR (
      public.course_in_my_tenant(course_id)
      AND (deleted_at IS NULL OR public.has_role(auth.uid(), 'Docente'::public.app_role) OR public.has_role(auth.uid(), 'Admin'::public.app_role))
    )
  );

ALTER POLICY workshops_select_in_tenant ON public.workshops
  USING (
    public.is_super_admin()
    OR (
      public.course_in_my_tenant(course_id)
      AND (deleted_at IS NULL OR public.has_role(auth.uid(), 'Docente'::public.app_role) OR public.has_role(auth.uid(), 'Admin'::public.app_role))
    )
  );

ALTER POLICY projects_select_in_tenant ON public.projects
  USING (
    public.is_super_admin()
    OR (
      public.course_in_my_tenant(course_id)
      AND (deleted_at IS NULL OR public.has_role(auth.uid(), 'Docente'::public.app_role) OR public.has_role(auth.uid(), 'Admin'::public.app_role))
    )
  );

-- ── B) Kahoot: gate la rama miembro con _poll_in_papelera (helper RLS-inmune) ──
ALTER POLICY kahoot_games_select ON public.kahoot_games
  USING (
    (public._poll_has_member(poll_id, auth.uid()) AND NOT public._poll_in_papelera(poll_id))
    OR public._poll_admin_in_tenant(poll_id, auth.uid())
  );

ALTER POLICY kahoot_players_select ON public.kahoot_players
  USING (EXISTS (
    SELECT 1 FROM public.kahoot_games g
    WHERE g.id = kahoot_players.game_id
      AND (
        (public._poll_has_member(g.poll_id, auth.uid()) AND NOT public._poll_in_papelera(g.poll_id))
        OR public._poll_admin_in_tenant(g.poll_id, auth.uid())
      )
  ));

-- ── C) Foros: gate la rama matrícula (alumno) de SELECT + INSERT con _course_in_papelera ──
ALTER POLICY forums_select ON public.forums
  USING (
    (public.has_role(auth.uid(), 'Admin'::public.app_role) AND public.course_in_my_tenant(course_id))
    OR (EXISTS (SELECT 1 FROM public.course_teachers WHERE course_teachers.course_id = forums.course_id AND course_teachers.user_id = auth.uid()))
    OR ((EXISTS (SELECT 1 FROM public.course_enrollments WHERE course_enrollments.course_id = forums.course_id AND course_enrollments.user_id = auth.uid())) AND NOT public._course_in_papelera(course_id))
    OR public.is_super_admin()
  );

ALTER POLICY forum_threads_select ON public.forum_threads
  USING (
    (public.has_role(auth.uid(), 'Admin'::public.app_role) AND public.course_in_my_tenant(course_id))
    OR (EXISTS (SELECT 1 FROM public.course_teachers WHERE course_teachers.course_id = forum_threads.course_id AND course_teachers.user_id = auth.uid()))
    OR ((EXISTS (SELECT 1 FROM public.course_enrollments WHERE course_enrollments.course_id = forum_threads.course_id AND course_enrollments.user_id = auth.uid())) AND NOT public._course_in_papelera(course_id))
    OR public.is_super_admin()
  );

ALTER POLICY forum_replies_select ON public.forum_replies
  USING (EXISTS (
    SELECT 1 FROM public.forum_threads t
    WHERE t.id = forum_replies.thread_id
      AND (
        public.has_role(auth.uid(), 'Admin'::public.app_role)
        OR (EXISTS (SELECT 1 FROM public.course_teachers WHERE course_teachers.course_id = t.course_id AND course_teachers.user_id = auth.uid()))
        OR ((EXISTS (SELECT 1 FROM public.course_enrollments WHERE course_enrollments.course_id = t.course_id AND course_enrollments.user_id = auth.uid())) AND NOT public._course_in_papelera(t.course_id))
      )
  ));

ALTER POLICY forum_threads_insert ON public.forum_threads
  WITH CHECK (
    (author_id = auth.uid())
    AND (
      public.has_role(auth.uid(), 'Admin'::public.app_role)
      OR (EXISTS (SELECT 1 FROM public.course_teachers WHERE course_teachers.course_id = forum_threads.course_id AND course_teachers.user_id = auth.uid()))
      OR (
        (EXISTS (SELECT 1 FROM public.course_enrollments WHERE course_enrollments.course_id = forum_threads.course_id AND course_enrollments.user_id = auth.uid()))
        AND public.is_forum_open(forum_id)
        AND NOT public._course_in_papelera(forum_threads.course_id)
      )
    )
  );

ALTER POLICY forum_replies_insert ON public.forum_replies
  WITH CHECK (
    (author_id = auth.uid())
    AND (EXISTS (
      SELECT 1 FROM public.forum_threads t
      WHERE t.id = forum_replies.thread_id
        AND t.is_locked = false
        AND (
          public.has_role(auth.uid(), 'Admin'::public.app_role)
          OR (EXISTS (SELECT 1 FROM public.course_teachers WHERE course_teachers.course_id = t.course_id AND course_teachers.user_id = auth.uid()))
          OR (
            (EXISTS (SELECT 1 FROM public.course_enrollments WHERE course_enrollments.course_id = t.course_id AND course_enrollments.user_id = auth.uid()))
            AND public.is_forum_open(t.forum_id)
            AND NOT public._course_in_papelera(t.course_id)
          )
        )
    ))
  );

-- ── B2) kahoot_get_state: bloquear estado (incl. answer key) de juego en papelera al no-staff ──
CREATE OR REPLACE FUNCTION public.kahoot_get_state(_game_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_game public.kahoot_games;
  v_is_host BOOLEAN;
  v_reveal BOOLEAN;
  v_total INT;
  v_q public.kahoot_questions;
  v_player public.kahoot_players;
  v_options JSONB;
  v_players JSONB;
  v_question JSONB;
  v_me JSONB;
  v_answer_count INT := 0;
  v_my_ans public.kahoot_answers;
  v_rank INT;
  v_responders JSONB := NULL;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_game FROM public.kahoot_games WHERE id = _game_id;
  IF v_game.id IS NULL THEN RAISE EXCEPTION 'Juego no encontrado' USING ERRCODE = '22023'; END IF;
  IF NOT (public._poll_has_member(v_game.poll_id, v_uid) OR public._poll_admin_in_tenant(v_game.poll_id, v_uid)) THEN
    RAISE EXCEPTION 'Sin acceso a este juego' USING ERRCODE = '42501';
  END IF;

  v_is_host := (v_game.host_id = v_uid OR public._poll_anchor_teacher(v_game.poll_id, v_uid) OR public._poll_admin_in_tenant(v_game.poll_id, v_uid));

  -- Papelera: si la encuesta está en papelera, el estado (incl. answer key) solo
  -- lo ve el staff (host/ancla/admin) para restaurar; al alumno se le oculta.
  IF public._poll_in_papelera(v_game.poll_id) AND NOT v_is_host THEN
    RAISE EXCEPTION 'Juego no encontrado' USING ERRCODE = '22023';
  END IF;

  v_reveal := v_game.status IN ('reveal', 'leaderboard', 'podium', 'ended');
  SELECT count(*) INTO v_total FROM public.kahoot_questions WHERE poll_id = v_game.poll_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', p.id, 'nickname', p.nickname, 'score', p.score, 'user_id', p.user_id
          ) ORDER BY p.score DESC, p.joined_at), '[]'::jsonb)
    INTO v_players FROM public.kahoot_players p WHERE p.game_id = _game_id;

  IF v_game.current_question_id IS NOT NULL THEN
    SELECT * INTO v_q FROM public.kahoot_questions WHERE id = v_game.current_question_id;
    IF v_q.id IS NOT NULL THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object(
                'id', o.id, 'label', o.label, 'position', o.position,
                'is_correct', CASE WHEN v_reveal OR v_is_host THEN o.is_correct ELSE NULL END
              ) ORDER BY o.position), '[]'::jsonb)
        INTO v_options FROM public.kahoot_question_options o WHERE o.question_id = v_q.id;

      SELECT count(*) INTO v_answer_count FROM public.kahoot_answers WHERE game_id = _game_id AND question_id = v_q.id;

      v_question := jsonb_build_object(
        'id', v_q.id, 'text', v_q.text, 'image_url', v_q.image_url,
        'time_limit_seconds', v_q.time_limit_seconds, 'points', v_q.points,
        'multi_select', v_q.multi_select,
        'options', v_options
      );

      IF v_is_host THEN
        SELECT coalesce(jsonb_object_agg(t.opt_id::text, t.responders), '{}'::jsonb)
          INTO v_responders
        FROM (
          SELECT o.id AS opt_id,
                 coalesce(
                   jsonb_agg(jsonb_build_object('player_id', pl.id, 'nickname', pl.nickname, 'is_correct', a.is_correct)
                             ORDER BY pl.nickname)
                   FILTER (WHERE pl.id IS NOT NULL),
                   '[]'::jsonb
                 ) AS responders
          FROM public.kahoot_question_options o
          LEFT JOIN public.kahoot_answers a
            ON a.game_id = _game_id AND a.question_id = v_q.id AND o.id = ANY(a.option_ids)
          LEFT JOIN public.kahoot_players pl ON pl.id = a.player_id
          WHERE o.question_id = v_q.id
          GROUP BY o.id
        ) t;
      END IF;
    END IF;
  END IF;

  SELECT * INTO v_player FROM public.kahoot_players WHERE game_id = _game_id AND user_id = v_uid;
  IF v_player.id IS NOT NULL THEN
    SELECT count(*) + 1 INTO v_rank FROM public.kahoot_players
      WHERE game_id = _game_id AND (score > v_player.score OR (score = v_player.score AND joined_at < v_player.joined_at));
    IF v_game.current_question_id IS NOT NULL THEN
      SELECT * INTO v_my_ans FROM public.kahoot_answers
        WHERE game_id = _game_id AND question_id = v_game.current_question_id AND player_id = v_player.id;
    END IF;
    v_me := jsonb_build_object(
      'player_id', v_player.id, 'nickname', v_player.nickname, 'score', v_player.score, 'rank', v_rank,
      'answered', (v_my_ans.id IS NOT NULL),
      'my_option_id', v_my_ans.option_id,
      'my_option_ids', coalesce(to_jsonb(v_my_ans.option_ids), 'null'::jsonb),
      'my_is_correct', CASE WHEN v_my_ans.id IS NOT NULL THEN v_my_ans.is_correct ELSE NULL END,
      'my_points', coalesce(v_my_ans.points, 0)
    );
  END IF;

  RETURN jsonb_build_object(
    'game', jsonb_build_object(
      'id', v_game.id,
      'pin', CASE WHEN v_is_host THEN v_game.pin ELSE NULL END,
      'status', v_game.status,
      'current_index', v_game.current_index, 'total_questions', v_total,
      'question_started_at', v_game.question_started_at, 'question_locked', v_game.question_locked,
      'host_present', (v_game.host_last_seen_at > now() - interval '25 seconds')
    ),
    'is_host', v_is_host,
    'question', v_question,
    'answer_count', v_answer_count,
    'players', v_players,
    'me', v_me,
    'responders_by_option', v_responders
  );
END $function$;

NOTIFY pgrst, 'reload schema';
