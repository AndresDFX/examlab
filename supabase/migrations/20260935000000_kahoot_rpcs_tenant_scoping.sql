-- ════════════════════════════════════════════════════════════════════
-- AISLAMIENTO MULTI-TENANT — cuerpos de RPCs de Kahoot (la RLS los bypassa).
--
-- 20260932000000 scopeó por tenant las RLS de polls/kahoot, pero los RPCs
-- SECURITY DEFINER conservaban el branch laxo `has_role(uid,'Admin')` — y como
-- bypassan RLS, un Admin del tenant B que obtenga un game_id/poll_id del tenant
-- A podía operar sobre su Kahoot (leer el estado completo + PIN + is_correct,
-- crear/controlar el juego, latir como host, inyectar preguntas). Una auditoría
-- adversarial confirmó 6 huecos.
--
-- Fix: reemplazar el branch laxo por el helper tenant-scopeado que ya usan las
-- RLS de las mismas tablas:
--   public.has_role(uid,'Admin') OR public.is_super_admin()
--     →  public._poll_admin_in_tenant(<poll_id>, uid)   (ya incluye is_super_admin)
-- y en la lectura del banco, is_admin_of_course_tenant(b.course_id).
-- (Cuerpos idénticos a sus migraciones de origen, solo cambia el branch Admin;
-- de paso bajamos el default de tiempo a 10s en el import del banco.)
-- ════════════════════════════════════════════════════════════════════

-- ── kahoot_create_game (origen 20260921000100) ──────────────────────
CREATE OR REPLACE FUNCTION public.kahoot_create_game(_poll_id UUID)
RETURNS public.kahoot_games
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
END $$;
GRANT EXECUTE ON FUNCTION public.kahoot_create_game(UUID) TO authenticated;

-- ── kahoot_advance_game (origen 20260921000100) ─────────────────────
CREATE OR REPLACE FUNCTION public.kahoot_advance_game(_game_id UUID, _action TEXT)
RETURNS public.kahoot_games
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_game public.kahoot_games;
  v_total INT;
  v_next_idx INT;
  v_next_q UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_game FROM public.kahoot_games WHERE id = _game_id FOR UPDATE;
  IF v_game.id IS NULL THEN RAISE EXCEPTION 'Juego no encontrado' USING ERRCODE = '22023'; END IF;
  IF NOT (v_game.host_id = v_uid OR public._poll_anchor_teacher(v_game.poll_id, v_uid) OR public._poll_admin_in_tenant(v_game.poll_id, v_uid)) THEN
    RAISE EXCEPTION 'Solo el host controla el juego' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_total FROM public.kahoot_questions WHERE poll_id = v_game.poll_id;

  IF _action = 'end' THEN
    UPDATE public.kahoot_games SET status = 'ended', question_locked = TRUE WHERE id = _game_id RETURNING * INTO v_game;
    RETURN v_game;
  ELSIF _action = 'lock' THEN
    UPDATE public.kahoot_games SET status = 'reveal', question_locked = TRUE WHERE id = _game_id RETURNING * INTO v_game;
    RETURN v_game;
  ELSIF _action = 'leaderboard' THEN
    UPDATE public.kahoot_games SET status = 'leaderboard' WHERE id = _game_id RETURNING * INTO v_game;
    RETURN v_game;
  ELSIF _action = 'start' OR _action = 'next' THEN
    v_next_idx := CASE WHEN _action = 'start' THEN 0 ELSE v_game.current_index + 1 END;
    IF v_next_idx >= v_total THEN
      UPDATE public.kahoot_games SET status = 'podium', question_locked = TRUE WHERE id = _game_id RETURNING * INTO v_game;
      RETURN v_game;
    END IF;
    SELECT id INTO v_next_q FROM public.kahoot_questions
      WHERE poll_id = v_game.poll_id ORDER BY position, created_at OFFSET v_next_idx LIMIT 1;
    UPDATE public.kahoot_games
      SET status = 'question', current_index = v_next_idx, current_question_id = v_next_q,
          question_started_at = now(), question_locked = FALSE
      WHERE id = _game_id RETURNING * INTO v_game;
    RETURN v_game;
  ELSE
    RAISE EXCEPTION 'Acción inválida: %', _action USING ERRCODE = 'P0001';
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.kahoot_advance_game(UUID, TEXT) TO authenticated;

-- ── kahoot_host_heartbeat (origen 20260931000000) ───────────────────
CREATE OR REPLACE FUNCTION public.kahoot_host_heartbeat(_game_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_game public.kahoot_games;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_game FROM public.kahoot_games WHERE id = _game_id;
  IF v_game.id IS NULL THEN RAISE EXCEPTION 'Juego no encontrado' USING ERRCODE = '22023'; END IF;
  IF NOT (v_game.host_id = v_uid OR public._poll_anchor_teacher(v_game.poll_id, v_uid) OR public._poll_admin_in_tenant(v_game.poll_id, v_uid)) THEN
    RAISE EXCEPTION 'Solo el host puede latir' USING ERRCODE = '42501';
  END IF;
  UPDATE public.kahoot_games SET host_last_seen_at = now() WHERE id = _game_id;
END $$;
GRANT EXECUTE ON FUNCTION public.kahoot_host_heartbeat(UUID) TO authenticated;

-- ── kahoot_get_state (origen 20260931000000) — gate de acceso + v_is_host ──
CREATE OR REPLACE FUNCTION public.kahoot_get_state(_game_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
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
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_game FROM public.kahoot_games WHERE id = _game_id;
  IF v_game.id IS NULL THEN RAISE EXCEPTION 'Juego no encontrado' USING ERRCODE = '22023'; END IF;
  IF NOT (public._poll_has_member(v_game.poll_id, v_uid) OR public._poll_admin_in_tenant(v_game.poll_id, v_uid)) THEN
    RAISE EXCEPTION 'Sin acceso a este juego' USING ERRCODE = '42501';
  END IF;

  v_is_host := (v_game.host_id = v_uid OR public._poll_anchor_teacher(v_game.poll_id, v_uid) OR public._poll_admin_in_tenant(v_game.poll_id, v_uid));
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
    'me', v_me
  );
END $$;
GRANT EXECUTE ON FUNCTION public.kahoot_get_state(UUID) TO authenticated;

-- ── add_questions_from_bank_to_kahoot (origen 20260927000000) ───────
-- Auth + lectura del banco scopeadas por tenant; default de tiempo 20→10.
CREATE OR REPLACE FUNCTION public.add_questions_from_bank_to_kahoot(
  _bank_ids UUID[],
  _poll_id UUID,
  _points_override JSONB DEFAULT '{}'::jsonb
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _max_pos INT;
  _inserted INT := 0;
  _bank RECORD;
  _points INT;
  _multi BOOLEAN;
  _qid UUID;
  _choices JSONB;
  _label TEXT;
  _idx INT;
  _is_correct BOOLEAN;
BEGIN
  IF NOT (
    public._poll_admin_in_tenant(_poll_id, auth.uid()) OR EXISTS (
      SELECT 1 FROM public.polls p
      JOIN public.course_teachers ct ON ct.course_id = p.course_id
      WHERE p.id = _poll_id AND p.poll_type = 'kahoot' AND ct.user_id = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para modificar este Kahoot';
  END IF;

  SELECT COALESCE(MAX(position), -1) INTO _max_pos
    FROM public.kahoot_questions WHERE poll_id = _poll_id;

  FOR _bank IN
    SELECT b.* FROM public.question_bank b
    WHERE b.id = ANY(_bank_ids)
      AND b.type IN ('cerrada', 'cerrada_multi')
      AND b.options IS NOT NULL
      AND (
        public.is_admin_of_course_tenant(b.course_id) OR EXISTS (
          SELECT 1 FROM public.course_teachers ct
          WHERE ct.course_id = b.course_id AND ct.user_id = auth.uid()
        )
      )
  LOOP
    _choices := _bank.options->'choices';
    IF _choices IS NULL OR jsonb_typeof(_choices) <> 'array' OR jsonb_array_length(_choices) < 2 THEN
      CONTINUE;
    END IF;

    _multi := (_bank.type = 'cerrada_multi');
    _points := LEAST(2000, GREATEST(0, COALESCE(
      (_points_override->>(_bank.id::text))::int,
      1000
    )));
    _max_pos := _max_pos + 1;

    INSERT INTO public.kahoot_questions (poll_id, text, time_limit_seconds, points, multi_select, position)
    VALUES (_poll_id, left(_bank.content, 500), 10, _points, _multi, _max_pos)
    RETURNING id INTO _qid;

    _idx := 0;
    FOR _label IN
      SELECT value FROM jsonb_array_elements_text(_choices) LIMIT 4
    LOOP
      IF _multi THEN
        _is_correct := COALESCE((_bank.options->'correct_indices') @> to_jsonb(_idx), false);
      ELSE
        _is_correct := ((_bank.options->>'correct_index')::int = _idx);
      END IF;
      INSERT INTO public.kahoot_question_options (question_id, label, is_correct, position)
      VALUES (_qid, left(_label, 200), COALESCE(_is_correct, false), _idx);
      _idx := _idx + 1;
    END LOOP;

    IF NOT EXISTS (
      SELECT 1 FROM public.kahoot_question_options WHERE question_id = _qid AND is_correct
    ) THEN
      UPDATE public.kahoot_question_options SET is_correct = true
        WHERE question_id = _qid AND position = 0;
    END IF;

    UPDATE public.question_bank
      SET times_used = times_used + 1, last_used_at = now()
      WHERE id = _bank.id;
    _inserted := _inserted + 1;
  END LOOP;

  RETURN _inserted;
END $$;
REVOKE ALL ON FUNCTION public.add_questions_from_bank_to_kahoot(UUID[], UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_questions_from_bank_to_kahoot(UUID[], UUID, JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
