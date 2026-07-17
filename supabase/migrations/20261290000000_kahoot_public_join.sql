-- ──────────────────────────────────────────────────────────────────────
-- Reto en vivo PÚBLICO: unirse escaneando el QR SIN loguearse, solo con el
-- correo institucional. Reglas (pedido explícito):
--   1) El correo debe estar MATRICULADO en el curso del juego (si no, se rechaza).
--   2) Si ya alguien se unió con ese correo, se rechaza (un jugador por correo).
-- El correo se resuelve al user_id del estudiante matriculado (profiles), así el
-- jugador público queda ligado al alumno real (leaderboard + posible bonus). El
-- anon opera con un TOKEN = kahoot_players.id (UUID) para pedir estado y responder.
--
-- 3 RPCs SECURITY DEFINER con GRANT a anon+authenticated:
--   kahoot_join_public(pin,email) → {player_id, game_id, nickname}
--   kahoot_state_public(game_id, player_id) → vista jugador (sin is_correct hasta reveal)
--   kahoot_answer_public(player_id, option_ids) → califica (espejo de kahoot_submit_answer)
-- ──────────────────────────────────────────────────────────────────────

-- ── Unirse público por correo institucional ──
CREATE OR REPLACE FUNCTION public.kahoot_join_public(_pin text, _email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_game public.kahoot_games;
  v_email TEXT := lower(btrim(coalesce(_email, '')));
  v_uid UUID;
  v_nick TEXT;
  v_player public.kahoot_players;
BEGIN
  IF v_email = '' OR position('@' in v_email) = 0 THEN
    RAISE EXCEPTION 'Ingresa un correo institucional válido' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_game FROM public.kahoot_games WHERE pin = _pin AND status <> 'ended' ORDER BY created_at DESC LIMIT 1;
  IF v_game.id IS NULL THEN RAISE EXCEPTION 'PIN inválido o el juego ya terminó' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM public.polls WHERE id = v_game.poll_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'PIN inválido o el juego ya terminó' USING ERRCODE = 'P0001';
  END IF;

  -- Resolver el correo → estudiante matriculado en el curso del juego. Si el
  -- correo no existe o no está matriculado, se rechaza (regla 1). _poll_has_member
  -- implica mismo tenant (poll_courses no cruza tenants).
  SELECT p.id INTO v_uid
    FROM public.profiles p
   WHERE lower(p.institutional_email) = v_email
     AND public._poll_has_member(v_game.poll_id, p.id)
   LIMIT 1;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Ese correo no está matriculado en el curso de este reto en vivo' USING ERRCODE = 'P0001';
  END IF;

  -- Regla 2: un jugador por correo. Si ya se unió, se rechaza.
  IF EXISTS (SELECT 1 FROM public.kahoot_players WHERE game_id = v_game.id AND user_id = v_uid) THEN
    RAISE EXCEPTION 'Ya alguien se unió con ese correo' USING ERRCODE = 'P0001';
  END IF;

  -- Sala atendida + no arrancada para nuevos ingresos.
  IF v_game.host_last_seen_at < now() - interval '25 seconds' THEN
    RAISE EXCEPTION 'El docente no está presente en la sala. Espera a que inicie la sesión.' USING ERRCODE = 'P0001';
  END IF;
  IF v_game.status <> 'lobby' THEN
    RAISE EXCEPTION 'El juego ya arrancó — no se admiten nuevos jugadores' USING ERRCODE = 'P0001';
  END IF;

  SELECT coalesce(nullif(btrim(full_name), ''), split_part(v_email, '@', 1)) INTO v_nick
    FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.kahoot_players (game_id, user_id, nickname)
  VALUES (v_game.id, v_uid, left(v_nick, 40))
  RETURNING * INTO v_player;

  RETURN jsonb_build_object('player_id', v_player.id, 'game_id', v_game.id, 'nickname', v_player.nickname);
END $function$;

-- ── Estado del juego para un jugador público (por token = player_id) ──
CREATE OR REPLACE FUNCTION public.kahoot_state_public(_game_id uuid, _player_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_game public.kahoot_games;
  v_player public.kahoot_players;
  v_reveal BOOLEAN;
  v_total INT;
  v_q public.kahoot_questions;
  v_options JSONB;
  v_players JSONB;
  v_question JSONB := NULL;
  v_me JSONB := NULL;
  v_answer_count INT := 0;
  v_my_ans public.kahoot_answers;
  v_rank INT;
BEGIN
  SELECT * INTO v_player FROM public.kahoot_players WHERE id = _player_id AND game_id = _game_id;
  IF v_player.id IS NULL THEN RAISE EXCEPTION 'Jugador no encontrado en este juego' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_game FROM public.kahoot_games WHERE id = _game_id;
  IF v_game.id IS NULL THEN RAISE EXCEPTION 'Juego no encontrado' USING ERRCODE = '22023'; END IF;

  v_reveal := v_game.status IN ('reveal', 'leaderboard', 'podium', 'ended');
  SELECT count(*) INTO v_total FROM public.kahoot_questions WHERE poll_id = v_game.poll_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'nickname', p.nickname, 'score', p.score)
                  ORDER BY p.score DESC, p.joined_at), '[]'::jsonb)
    INTO v_players FROM public.kahoot_players p WHERE p.game_id = _game_id;

  IF v_game.current_question_id IS NOT NULL THEN
    SELECT * INTO v_q FROM public.kahoot_questions WHERE id = v_game.current_question_id;
    IF v_q.id IS NOT NULL THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object(
                'id', o.id, 'label', o.label, 'position', o.position,
                'is_correct', CASE WHEN v_reveal THEN o.is_correct ELSE NULL END
              ) ORDER BY o.position), '[]'::jsonb)
        INTO v_options FROM public.kahoot_question_options o WHERE o.question_id = v_q.id;
      SELECT count(*) INTO v_answer_count FROM public.kahoot_answers WHERE game_id = _game_id AND question_id = v_q.id;
      v_question := jsonb_build_object(
        'id', v_q.id, 'text', v_q.text, 'image_url', v_q.image_url,
        'time_limit_seconds', v_q.time_limit_seconds, 'points', v_q.points,
        'multi_select', v_q.multi_select, 'options', v_options
      );
      SELECT * INTO v_my_ans FROM public.kahoot_answers
        WHERE game_id = _game_id AND question_id = v_q.id AND player_id = v_player.id;
    END IF;
  END IF;

  SELECT count(*) + 1 INTO v_rank FROM public.kahoot_players
    WHERE game_id = _game_id AND (score > v_player.score OR (score = v_player.score AND joined_at < v_player.joined_at));

  v_me := jsonb_build_object(
    'player_id', v_player.id, 'nickname', v_player.nickname, 'score', v_player.score, 'rank', v_rank,
    'answered', (v_my_ans.id IS NOT NULL),
    'my_option_id', v_my_ans.option_id,
    'my_option_ids', coalesce(to_jsonb(v_my_ans.option_ids), 'null'::jsonb),
    'my_is_correct', CASE WHEN v_my_ans.id IS NOT NULL THEN v_my_ans.is_correct ELSE NULL END,
    'my_points', coalesce(v_my_ans.points, 0)
  );

  RETURN jsonb_build_object(
    'game', jsonb_build_object(
      'id', v_game.id, 'pin', NULL, 'status', v_game.status,
      'current_index', v_game.current_index, 'total_questions', v_total,
      'question_started_at', v_game.question_started_at, 'question_locked', v_game.question_locked,
      'host_present', (v_game.host_last_seen_at > now() - interval '25 seconds')
    ),
    'is_host', false,
    'question', v_question,
    'answer_count', v_answer_count,
    'players', v_players,
    'me', v_me,
    'responders_by_option', NULL
  );
END $function$;

-- ── Responder como jugador público (por token) — espejo de kahoot_submit_answer ──
CREATE OR REPLACE FUNCTION public.kahoot_answer_public(_player_id uuid, _option_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_grace_ms CONSTANT NUMERIC := 2000;
  v_player public.kahoot_players;
  v_game public.kahoot_games;
  v_q public.kahoot_questions;
  v_opts UUID[];
  v_empty BOOLEAN;
  v_sel_total INT;
  v_sel_correct INT;
  v_total_correct INT;
  v_is_correct BOOLEAN;
  v_limit_ms NUMERIC;
  v_elapsed_ms NUMERIC;
  v_clamped_ms NUMERIC;
  v_points INT;
  v_ans public.kahoot_answers;
BEGIN
  SELECT * INTO v_player FROM public.kahoot_players WHERE id = _player_id;
  IF v_player.id IS NULL THEN RAISE EXCEPTION 'Jugador no encontrado' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_game FROM public.kahoot_games WHERE id = v_player.game_id;
  IF v_game.id IS NULL THEN RAISE EXCEPTION 'Juego no encontrado' USING ERRCODE = '22023'; END IF;

  IF v_game.status <> 'question' THEN RAISE EXCEPTION 'La pregunta no está abierta para responder' USING ERRCODE = 'P0001'; END IF;
  IF v_game.question_started_at IS NULL THEN RAISE EXCEPTION 'La pregunta aún no ha iniciado' USING ERRCODE = 'P0001'; END IF;
  IF now() < v_game.question_started_at THEN RAISE EXCEPTION 'La pregunta aún no está abierta' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_q FROM public.kahoot_questions WHERE id = v_game.current_question_id;
  IF v_q.id IS NULL THEN RAISE EXCEPTION 'No hay pregunta activa' USING ERRCODE = 'P0001'; END IF;

  v_limit_ms := v_q.time_limit_seconds * 1000.0;
  v_elapsed_ms := GREATEST(0, EXTRACT(EPOCH FROM (now() - v_game.question_started_at)) * 1000.0);
  IF v_elapsed_ms > v_limit_ms + v_grace_ms THEN RAISE EXCEPTION 'El tiempo para responder ya cerró' USING ERRCODE = 'P0001'; END IF;

  SELECT array_agg(DISTINCT x) INTO v_opts FROM unnest(coalesce(_option_ids, '{}'::uuid[])) x WHERE x IS NOT NULL;
  v_empty := (v_opts IS NULL OR array_length(v_opts, 1) IS NULL);

  IF NOT v_empty THEN
    IF EXISTS (SELECT 1 FROM unnest(v_opts) oid WHERE NOT EXISTS (SELECT 1 FROM public.kahoot_question_options WHERE id = oid AND question_id = v_q.id)) THEN
      RAISE EXCEPTION 'Una opción no pertenece a la pregunta actual' USING ERRCODE = '22023';
    END IF;
    IF NOT v_q.multi_select AND array_length(v_opts, 1) > 1 THEN
      RAISE EXCEPTION 'Esta pregunta admite una sola opción' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.kahoot_answers WHERE game_id = v_game.id AND question_id = v_q.id AND player_id = v_player.id) THEN
    RAISE EXCEPTION 'Ya respondiste esta pregunta' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) FILTER (WHERE o.is_correct), count(*) INTO v_sel_correct, v_sel_total
    FROM public.kahoot_question_options o WHERE o.question_id = v_q.id AND v_opts IS NOT NULL AND o.id = ANY(v_opts);
  SELECT count(*) INTO v_total_correct FROM public.kahoot_question_options WHERE question_id = v_q.id AND is_correct;

  IF v_empty THEN v_is_correct := false;
  ELSIF v_q.multi_select THEN v_is_correct := (v_total_correct > 0 AND v_sel_correct = v_total_correct AND v_sel_total = v_total_correct);
  ELSE v_is_correct := (v_sel_total = 1 AND v_sel_correct = 1);
  END IF;

  v_clamped_ms := GREATEST(0, LEAST(v_elapsed_ms, v_limit_ms));
  IF v_is_correct THEN v_points := round(v_q.points * (1 - (v_clamped_ms / v_limit_ms) / 2.0));
  ELSE v_points := 0; END IF;

  INSERT INTO public.kahoot_answers (game_id, question_id, player_id, option_id, option_ids, is_correct, points, response_ms)
  VALUES (v_game.id, v_q.id, v_player.id,
    CASE WHEN v_empty OR v_q.multi_select THEN NULL ELSE v_opts[1] END,
    CASE WHEN v_empty THEN NULL ELSE v_opts END,
    v_is_correct, v_points, round(v_clamped_ms)::int)
  RETURNING * INTO v_ans;

  UPDATE public.kahoot_players SET score = score + v_points WHERE id = v_player.id;
  RETURN jsonb_build_object('is_correct', v_ans.is_correct, 'points', v_ans.points);
END $function$;

REVOKE ALL ON FUNCTION public.kahoot_join_public(text, text) FROM public;
REVOKE ALL ON FUNCTION public.kahoot_state_public(uuid, uuid) FROM public;
REVOKE ALL ON FUNCTION public.kahoot_answer_public(uuid, uuid[]) FROM public;
GRANT EXECUTE ON FUNCTION public.kahoot_join_public(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kahoot_state_public(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kahoot_answer_public(uuid, uuid[]) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
