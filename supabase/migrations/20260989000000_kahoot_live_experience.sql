-- ════════════════════════════════════════════════════════════════════
-- KAHOOT — mejoras de experiencia en vivo:
--   (1) Tiempo por defecto 20s (revierte el 20→10 de 20260936000000).
--   (2) "Prepárate" / cuenta regresiva: al avanzar a una pregunta,
--       question_started_at se fija 3s EN EL FUTURO. Durante esos 3s el
--       cliente muestra un splash animado de cuenta regresiva (sin opciones)
--       y el cronómetro arranca recién cuando llega el momento — así la espera
--       NO le come tiempo a nadie (secondsLeft devuelve el límite completo
--       mientras now < started; el server computa elapsed=GREATEST(0,…) → 0).
--   (3) kahoot_join_game_by_id — "login directo": un alumno YA autenticado
--       (su cuenta institucional ES la credencial) entra a un juego activo de
--       SU curso con un click desde la notificación global, sin teclear el PIN.
--       Mismos guards que kahoot_join_game (tenant, matrícula, host presente +
--       lobby para nuevos, papelera, ended). El PIN sigue para el QR / manual.
--   (4) kahoot_get_state: responders_by_option (SOLO host) — por cada opción de
--       la pregunta actual, QUIÉNES la respondieron (nickname). Permite al
--       docente ver en vivo/al revelar quién eligió cada opción.
--
-- Cuerpos de kahoot_advance_game / kahoot_get_state tomados de su última
-- versión (20260935000000) con los cambios mínimos marcados.
-- ════════════════════════════════════════════════════════════════════

-- ── (1) Tiempo por defecto 20s ──────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.kahoot_questions') IS NOT NULL THEN
    ALTER TABLE public.kahoot_questions ALTER COLUMN time_limit_seconds SET DEFAULT 20;
  END IF;
END $$;

-- ── (2) kahoot_advance_game con cuenta regresiva de inicio ──────────
-- INVARIANTE CROSS-FILE: el lead de inicio (v_intro_lead) lo consume el cliente
-- (host + player) mostrando el splash "¡Prepárate!" mientras now < started.
-- Si cambia acá, ajustar la UI; pero el cronómetro y la ventana del server se
-- derivan SOLOS de question_started_at, así que es seguro variarlo.
CREATE OR REPLACE FUNCTION public.kahoot_advance_game(_game_id UUID, _action TEXT)
RETURNS public.kahoot_games
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_game public.kahoot_games;
  v_total INT;
  v_next_idx INT;
  v_next_q UUID;
  v_intro_lead CONSTANT INTERVAL := interval '3 seconds';
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
    -- question_started_at = now() + lead → "¡Prepárate!" antes de abrir. El
    -- cronómetro y la ventana de respuesta arrancan recién en ese instante.
    UPDATE public.kahoot_games
      SET status = 'question', current_index = v_next_idx, current_question_id = v_next_q,
          question_started_at = now() + v_intro_lead, question_locked = FALSE
      WHERE id = _game_id RETURNING * INTO v_game;
    RETURN v_game;
  ELSE
    RAISE EXCEPTION 'Acción inválida: %', _action USING ERRCODE = 'P0001';
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.kahoot_advance_game(UUID, TEXT) TO authenticated;

-- ── (3) kahoot_join_game_by_id — "login directo" sin PIN ────────────
-- Une al caller a un juego por su ID (la notificación global lo conoce vía
-- RLS). Mismos guards que kahoot_join_game salvo que NO valida el PIN — la
-- credencial de acceso es la MATRÍCULA del alumno (cuenta institucional), que
-- _poll_has_member enforza. Nuevos ingresos exigen host presente + lobby.
CREATE OR REPLACE FUNCTION public.kahoot_join_game_by_id(_game_id UUID, _nickname TEXT DEFAULT NULL)
RETURNS public.kahoot_players
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_game public.kahoot_games;
  v_nick TEXT := nullif(btrim(_nickname), '');
  v_player public.kahoot_players;
  v_is_existing BOOLEAN;
  v_game_tenant UUID;
  v_user_tenant UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_game FROM public.kahoot_games WHERE id = _game_id AND status <> 'ended';
  IF v_game.id IS NULL THEN RAISE EXCEPTION 'El juego no está disponible o ya terminó' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM public.polls WHERE id = v_game.poll_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'El juego no está disponible o ya terminó' USING ERRCODE = 'P0001';
  END IF;

  -- AISLAMIENTO DE TENANT (igual que kahoot_join_game).
  IF NOT public.is_super_admin() THEN
    SELECT c.tenant_id INTO v_game_tenant
      FROM public.polls p JOIN public.courses c ON c.id = p.course_id
     WHERE p.id = v_game.poll_id;
    SELECT tenant_id INTO v_user_tenant FROM public.profiles WHERE id = v_uid;
    IF v_game_tenant IS DISTINCT FROM v_user_tenant THEN
      RAISE EXCEPTION 'El juego no está disponible o ya terminó' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NOT public._poll_has_member(v_game.poll_id, v_uid) THEN
    RAISE EXCEPTION 'No estás matriculado en el curso de este Kahoot' USING ERRCODE = '42501';
  END IF;

  v_is_existing := EXISTS (SELECT 1 FROM public.kahoot_players WHERE game_id = v_game.id AND user_id = v_uid);
  IF NOT v_is_existing THEN
    IF v_game.host_last_seen_at < now() - interval '25 seconds' THEN
      RAISE EXCEPTION 'El docente no está presente en la sala. Espera a que reanude la sesión.' USING ERRCODE = 'P0001';
    END IF;
    IF v_game.status <> 'lobby' THEN
      RAISE EXCEPTION 'El juego ya arrancó — no se admiten nuevos jugadores' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF v_nick IS NULL THEN
    SELECT coalesce(nullif(btrim(full_name), ''), 'Jugador') INTO v_nick FROM public.profiles WHERE id = v_uid;
  END IF;

  INSERT INTO public.kahoot_players (game_id, user_id, nickname)
  VALUES (v_game.id, v_uid, left(v_nick, 40))
  ON CONFLICT (game_id, user_id) DO UPDATE SET nickname = EXCLUDED.nickname
  RETURNING * INTO v_player;
  RETURN v_player;
END $$;
GRANT EXECUTE ON FUNCTION public.kahoot_join_game_by_id(UUID, TEXT) TO authenticated;

-- ── (4) kahoot_get_state + responders_by_option (host-only) ─────────
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
  v_responders JSONB := NULL;
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

      -- responders_by_option: SOLO el host ve quién eligió cada opción (los
      -- alumnos NO — sería filtrar respuestas ajenas). Clave = option_id; valor
      -- = lista de {player_id, nickname, is_correct}. Se atribuye por option_ids
      -- (cubre single y multi); blanco (option_ids NULL) no cuenta para ninguna.
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
END $$;
GRANT EXECUTE ON FUNCTION public.kahoot_get_state(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
