-- ══════════════════════════════════════════════════════════════════════
-- Reto en vivo: REVISIÓN read-only de preguntas anteriores.
--
-- Permite "volver" a una pregunta YA jugada para verla (enunciado + opciones +
-- cuál era la correcta + la propia respuesta), SIN poder responderla de nuevo ni
-- tocar el estado del juego. La imposibilidad de re-responder ya está enforzada
-- server-side (kahoot_submit_answer valida status='question' + current_question_id
-- + UNIQUE) — estos RPCs son SOLO LECTURA.
--
-- No se toca el enorme kahoot_get_state (riesgoso): se agregan RPCs separados.
-- El "índice" de una pregunta es su rank en ORDER BY position, created_at (NO el
-- campo position), igual que el OFFSET current_index que usa kahoot_advance_game.
-- "Jugada" = rank <= current_index. Guards de acceso idénticos a kahoot_get_state.
-- ══════════════════════════════════════════════════════════════════════

-- ── 1) Lista de preguntas ya jugadas (para el pager) — jugador autenticado ──
CREATE OR REPLACE FUNCTION public.kahoot_list_played_questions(_game_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_game public.kahoot_games;
  v_list JSONB;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_game FROM public.kahoot_games WHERE id = _game_id;
  IF v_game.id IS NULL THEN RAISE EXCEPTION 'Juego no encontrado' USING ERRCODE = '22023'; END IF;
  IF NOT (public._poll_has_member(v_game.poll_id, v_uid) OR public._poll_admin_in_tenant(v_game.poll_id, v_uid)) THEN
    RAISE EXCEPTION 'Sin acceso a este juego' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'index', q.idx, 'text', q.text) ORDER BY q.idx), '[]'::jsonb)
    INTO v_list
  FROM (
    SELECT id, text, (row_number() OVER (ORDER BY position, created_at) - 1) AS idx
    FROM public.kahoot_questions WHERE poll_id = v_game.poll_id
  ) q
  WHERE q.idx <= v_game.current_index;

  RETURN v_list;
END $$;
GRANT EXECUTE ON FUNCTION public.kahoot_list_played_questions(UUID) TO authenticated;

-- ── 2) Revisión de UNA pregunta ya jugada — jugador autenticado ──
CREATE OR REPLACE FUNCTION public.kahoot_get_question_review(_game_id UUID, _question_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_game public.kahoot_games;
  v_q public.kahoot_questions;
  v_idx INT;
  v_options JSONB;
  v_player public.kahoot_players;
  v_my public.kahoot_answers;
  v_me JSONB := NULL;
  v_is_host BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_game FROM public.kahoot_games WHERE id = _game_id;
  IF v_game.id IS NULL THEN RAISE EXCEPTION 'Juego no encontrado' USING ERRCODE = '22023'; END IF;
  IF NOT (public._poll_has_member(v_game.poll_id, v_uid) OR public._poll_admin_in_tenant(v_game.poll_id, v_uid)) THEN
    RAISE EXCEPTION 'Sin acceso a este juego' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_q FROM public.kahoot_questions WHERE id = _question_id AND poll_id = v_game.poll_id;
  IF v_q.id IS NULL THEN RAISE EXCEPTION 'Pregunta no encontrada' USING ERRCODE = '22023'; END IF;

  -- Solo preguntas YA jugadas (rank <= current_index) — nunca filtrar una futura.
  SELECT idx INTO v_idx FROM (
    SELECT id, (row_number() OVER (ORDER BY position, created_at) - 1) AS idx
    FROM public.kahoot_questions WHERE poll_id = v_game.poll_id
  ) q WHERE q.id = _question_id;
  IF v_idx IS NULL OR v_idx > v_game.current_index THEN
    RAISE EXCEPTION 'Esa pregunta todavía no se jugó' USING ERRCODE = '42501';
  END IF;

  -- Opciones con la correcta SIEMPRE revelada (es una pregunta pasada).
  SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', o.id, 'label', o.label, 'position', o.position, 'is_correct', o.is_correct
          ) ORDER BY o.position), '[]'::jsonb)
    INTO v_options FROM public.kahoot_question_options o WHERE o.question_id = v_q.id;

  -- Respuesta del propio jugador (si jugó).
  SELECT * INTO v_player FROM public.kahoot_players WHERE game_id = _game_id AND user_id = v_uid;
  IF v_player.id IS NOT NULL THEN
    SELECT * INTO v_my FROM public.kahoot_answers
      WHERE game_id = _game_id AND question_id = v_q.id AND player_id = v_player.id;
    v_me := jsonb_build_object(
      'answered', (v_my.id IS NOT NULL),
      'my_option_ids', coalesce(to_jsonb(v_my.option_ids), 'null'::jsonb),
      'my_is_correct', CASE WHEN v_my.id IS NOT NULL THEN v_my.is_correct ELSE NULL END,
      'my_points', coalesce(v_my.points, 0)
    );
  END IF;

  RETURN jsonb_build_object(
    'question', jsonb_build_object(
      'id', v_q.id, 'index', v_idx, 'text', v_q.text, 'image_url', v_q.image_url,
      'multi_select', v_q.multi_select, 'points', v_q.points, 'options', v_options
    ),
    'me', v_me
  );
END $$;
GRANT EXECUTE ON FUNCTION public.kahoot_get_question_review(UUID, UUID) TO authenticated;

-- ── 3) Variante PÚBLICA (/reto, jugador anónimo por token = player_id) ──
-- El acceso se valida porque el player_id pertenece al juego (mismo criterio que
-- kahoot_state_public). NO usa auth.uid().
CREATE OR REPLACE FUNCTION public.kahoot_list_played_questions_public(_game_id UUID, _player_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  v_game public.kahoot_games;
  v_list JSONB;
BEGIN
  SELECT * INTO v_game FROM public.kahoot_games WHERE id = _game_id;
  IF v_game.id IS NULL THEN RAISE EXCEPTION 'Juego no encontrado' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.kahoot_players WHERE id = _player_id AND game_id = _game_id) THEN
    RAISE EXCEPTION 'Sin acceso a este juego' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'index', q.idx, 'text', q.text) ORDER BY q.idx), '[]'::jsonb)
    INTO v_list
  FROM (
    SELECT id, text, (row_number() OVER (ORDER BY position, created_at) - 1) AS idx
    FROM public.kahoot_questions WHERE poll_id = v_game.poll_id
  ) q
  WHERE q.idx <= v_game.current_index;

  RETURN v_list;
END $$;
GRANT EXECUTE ON FUNCTION public.kahoot_list_played_questions_public(UUID, UUID) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.kahoot_get_question_review_public(_game_id UUID, _player_id UUID, _question_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  v_game public.kahoot_games;
  v_q public.kahoot_questions;
  v_idx INT;
  v_options JSONB;
  v_my public.kahoot_answers;
  v_me JSONB := NULL;
BEGIN
  SELECT * INTO v_game FROM public.kahoot_games WHERE id = _game_id;
  IF v_game.id IS NULL THEN RAISE EXCEPTION 'Juego no encontrado' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.kahoot_players WHERE id = _player_id AND game_id = _game_id) THEN
    RAISE EXCEPTION 'Sin acceso a este juego' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_q FROM public.kahoot_questions WHERE id = _question_id AND poll_id = v_game.poll_id;
  IF v_q.id IS NULL THEN RAISE EXCEPTION 'Pregunta no encontrada' USING ERRCODE = '22023'; END IF;

  SELECT idx INTO v_idx FROM (
    SELECT id, (row_number() OVER (ORDER BY position, created_at) - 1) AS idx
    FROM public.kahoot_questions WHERE poll_id = v_game.poll_id
  ) q WHERE q.id = _question_id;
  IF v_idx IS NULL OR v_idx > v_game.current_index THEN
    RAISE EXCEPTION 'Esa pregunta todavía no se jugó' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', o.id, 'label', o.label, 'position', o.position, 'is_correct', o.is_correct
          ) ORDER BY o.position), '[]'::jsonb)
    INTO v_options FROM public.kahoot_question_options o WHERE o.question_id = v_q.id;

  SELECT * INTO v_my FROM public.kahoot_answers
    WHERE game_id = _game_id AND question_id = v_q.id AND player_id = _player_id;
  v_me := jsonb_build_object(
    'answered', (v_my.id IS NOT NULL),
    'my_option_ids', coalesce(to_jsonb(v_my.option_ids), 'null'::jsonb),
    'my_is_correct', CASE WHEN v_my.id IS NOT NULL THEN v_my.is_correct ELSE NULL END,
    'my_points', coalesce(v_my.points, 0)
  );

  RETURN jsonb_build_object(
    'question', jsonb_build_object(
      'id', v_q.id, 'index', v_idx, 'text', v_q.text, 'image_url', v_q.image_url,
      'multi_select', v_q.multi_select, 'points', v_q.points, 'options', v_options
    ),
    'me', v_me
  );
END $$;
GRANT EXECUTE ON FUNCTION public.kahoot_get_question_review_public(UUID, UUID, UUID) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
