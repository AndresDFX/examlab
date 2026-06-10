-- ──────────────────────────────────────────────────────────────────────
-- Kahoot: preguntas de ÚNICA respuesta vs MÚLTIPLES respuestas.
--
-- Antes toda pregunta era single-select (el alumno tocaba UNA forma y
-- kahoot_submit_answer recibía UN option_id; el editor forzaba exactamente
-- 1 correcta). Ahora cada pregunta tiene `multi_select`:
--   - false (single): el alumno elige 1 opción; correcta si esa opción lo es.
--   - true  (multiple): el alumno elige un SET; correcta SOLO si el set marcado
--     coincide EXACTO con el set de opciones correctas (todas las correctas y
--     ninguna incorrecta) — estilo Kahoot all-or-nothing. El puntaje sigue
--     escalando por tiempo con la misma fórmula.
--
-- Cambios:
--   A. kahoot_questions.multi_select BOOLEAN (default false → back-compat).
--   B. kahoot_answers.option_ids UUID[] (el set elegido) + option_id nullable
--      (se conserva para single = option_ids[0], y por compat de filas viejas).
--   C. kahoot_submit_answer(_game_id, _option_ids UUID[]) — set-based. Se DROPea
--      la firma vieja (_option_id UUID) para que PostgREST no tenga overload
--      ambiguo.
--   D. kahoot_get_state expone question.multi_select y me.my_option_ids.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.kahoot_questions') IS NOT NULL THEN
    ALTER TABLE public.kahoot_questions
      ADD COLUMN IF NOT EXISTS multi_select BOOLEAN NOT NULL DEFAULT false;
  END IF;
  IF to_regclass('public.kahoot_answers') IS NOT NULL THEN
    ALTER TABLE public.kahoot_answers
      ADD COLUMN IF NOT EXISTS option_ids UUID[];
    -- option_id pasa a NULLABLE: en multiple no hay "una" opción elegida.
    ALTER TABLE public.kahoot_answers ALTER COLUMN option_id DROP NOT NULL;
  END IF;
END $$;

-- ── C) kahoot_submit_answer set-based ──────────────────────────────────
DROP FUNCTION IF EXISTS public.kahoot_submit_answer(UUID, UUID);

CREATE OR REPLACE FUNCTION public.kahoot_submit_answer(_game_id UUID, _option_ids UUID[])
RETURNS public.kahoot_answers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_game public.kahoot_games;
  v_player public.kahoot_players;
  v_q public.kahoot_questions;
  v_opts UUID[];
  v_sel_total INT;
  v_sel_correct INT;
  v_total_correct INT;
  v_is_correct BOOLEAN;
  v_limit_ms NUMERIC;
  v_elapsed_ms NUMERIC;
  v_points INT;
  v_ans public.kahoot_answers;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_game FROM public.kahoot_games WHERE id = _game_id;
  IF v_game.id IS NULL THEN RAISE EXCEPTION 'Juego no encontrado' USING ERRCODE = '22023'; END IF;
  IF v_game.status <> 'question' OR v_game.question_locked THEN
    RAISE EXCEPTION 'La pregunta no está abierta para responder' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_player FROM public.kahoot_players WHERE game_id = _game_id AND user_id = v_uid;
  IF v_player.id IS NULL THEN RAISE EXCEPTION 'No estás en este juego' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_q FROM public.kahoot_questions WHERE id = v_game.current_question_id;
  IF v_q.id IS NULL THEN RAISE EXCEPTION 'No hay pregunta activa' USING ERRCODE = 'P0001'; END IF;

  -- Set de opciones elegidas, deduplicado y limpio de nulls.
  SELECT array_agg(DISTINCT x) INTO v_opts FROM unnest(coalesce(_option_ids, '{}'::uuid[])) x WHERE x IS NOT NULL;
  IF v_opts IS NULL OR array_length(v_opts, 1) IS NULL THEN
    RAISE EXCEPTION 'Debes seleccionar al menos una opción' USING ERRCODE = 'P0001';
  END IF;

  -- Todas las opciones elegidas deben pertenecer a la pregunta actual.
  IF EXISTS (
    SELECT 1 FROM unnest(v_opts) oid
     WHERE NOT EXISTS (SELECT 1 FROM public.kahoot_question_options WHERE id = oid AND question_id = v_q.id)
  ) THEN
    RAISE EXCEPTION 'Una opción no pertenece a la pregunta actual' USING ERRCODE = '22023';
  END IF;

  -- Single: exactamente 1 opción.
  IF NOT v_q.multi_select AND array_length(v_opts, 1) <> 1 THEN
    RAISE EXCEPTION 'Esta pregunta admite una sola opción' USING ERRCODE = 'P0001';
  END IF;

  -- Una respuesta por (juego, pregunta, jugador).
  IF EXISTS (SELECT 1 FROM public.kahoot_answers WHERE game_id = _game_id AND question_id = v_q.id AND player_id = v_player.id) THEN
    RAISE EXCEPTION 'Ya respondiste esta pregunta' USING ERRCODE = 'P0001';
  END IF;

  -- Correctitud: cuántas elegidas son correctas, cuántas elegidas en total,
  -- y cuántas correctas tiene la pregunta.
  SELECT count(*) FILTER (WHERE o.is_correct), count(*)
    INTO v_sel_correct, v_sel_total
    FROM public.kahoot_question_options o
   WHERE o.question_id = v_q.id AND o.id = ANY(v_opts);
  SELECT count(*) INTO v_total_correct
    FROM public.kahoot_question_options WHERE question_id = v_q.id AND is_correct;

  IF v_q.multi_select THEN
    -- All-or-nothing: marcó TODAS las correctas y NINGUNA incorrecta.
    v_is_correct := (v_total_correct > 0 AND v_sel_correct = v_total_correct AND v_sel_total = v_total_correct);
  ELSE
    v_is_correct := (v_sel_total = 1 AND v_sel_correct = 1);
  END IF;

  v_limit_ms := v_q.time_limit_seconds * 1000.0;
  v_elapsed_ms := GREATEST(0, LEAST(v_limit_ms,
    EXTRACT(EPOCH FROM (now() - coalesce(v_game.question_started_at, now()))) * 1000.0));
  IF v_is_correct THEN
    v_points := round(v_q.points * (1 - (v_elapsed_ms / v_limit_ms) / 2.0));
  ELSE
    v_points := 0;
  END IF;

  INSERT INTO public.kahoot_answers (game_id, question_id, player_id, option_id, option_ids, is_correct, points, response_ms)
  VALUES (
    _game_id, v_q.id, v_player.id,
    CASE WHEN v_q.multi_select THEN NULL ELSE v_opts[1] END,
    v_opts, v_is_correct, v_points, round(v_elapsed_ms)::int
  )
  RETURNING * INTO v_ans;

  UPDATE public.kahoot_players SET score = score + v_points WHERE id = v_player.id;
  RETURN v_ans;
END $$;
GRANT EXECUTE ON FUNCTION public.kahoot_submit_answer(UUID, UUID[]) TO authenticated;

-- ── D) kahoot_get_state expone multi_select + my_option_ids ────────────
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
  IF NOT (public._poll_has_member(v_game.poll_id, v_uid) OR public.has_role(v_uid, 'Admin') OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Sin acceso a este juego' USING ERRCODE = '42501';
  END IF;

  v_is_host := (v_game.host_id = v_uid OR public._poll_anchor_teacher(v_game.poll_id, v_uid) OR public.has_role(v_uid, 'Admin') OR public.is_super_admin());
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
      'id', v_game.id, 'pin', v_game.pin, 'status', v_game.status,
      'current_index', v_game.current_index, 'total_questions', v_total,
      'question_started_at', v_game.question_started_at, 'question_locked', v_game.question_locked
    ),
    'is_host', v_is_host,
    'question', v_question,
    'answer_count', v_answer_count,
    'players', v_players,
    'me', v_me
  );
END $$;
GRANT EXECUTE ON FUNCTION public.kahoot_get_state(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
