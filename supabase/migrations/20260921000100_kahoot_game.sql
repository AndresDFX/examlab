-- ════════════════════════════════════════════════════════════════════
-- KAHOOT — quiz en vivo gamificado como nuevo tipo de encuesta.
--
-- Una encuesta con poll_type='kahoot' es un QUIZ (varias preguntas, a
-- diferencia de los otros tipos que son 1 pregunta). El docente la
-- hospeda en vivo: los alumnos entran con un PIN, ven cada pregunta con
-- temporizador, responden tocando una de hasta 4 formas de color, y
-- ganan puntos por acertar + por velocidad. Entre preguntas se muestra
-- el leaderboard; al final, el podio.
--
-- Modelo:
--   kahoot_questions          — preguntas del quiz (FK poll)
--   kahoot_question_options   — opciones por pregunta (is_correct)
--   kahoot_games              — instancia de juego en vivo (PIN, estado)
--   kahoot_players            — jugadores que entraron a un juego
--   kahoot_answers            — respuestas (1 por jugador/pregunta) + pts
--
-- ANTI-TRAMPA: kahoot_question_options NO es legible por estudiantes vía
-- RLS (verían is_correct). El estado del juego se sirve por el RPC
-- SECURITY DEFINER `kahoot_get_state`, que oculta is_correct hasta el
-- reveal. El scoring se calcula SERVER-SIDE en `kahoot_submit_answer`
-- (el cliente no puede inflar puntos).
--
-- Depende de: 20260921000000 (agrega 'kahoot' al enum poll_type) +
-- helpers de polls `_poll_has_member` / `_poll_anchor_teacher`
-- (20260915000000) + `has_role` / `is_super_admin`.
-- ════════════════════════════════════════════════════════════════════

-- ── kahoot_questions ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kahoot_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id UUID NOT NULL REFERENCES public.polls(id) ON DELETE CASCADE,
  position INT NOT NULL DEFAULT 0,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  image_url TEXT,
  time_limit_seconds INT NOT NULL DEFAULT 20 CHECK (time_limit_seconds BETWEEN 5 AND 240),
  points INT NOT NULL DEFAULT 1000 CHECK (points BETWEEN 0 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kahoot_questions_poll ON public.kahoot_questions(poll_id, position);

-- ── kahoot_question_options ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kahoot_question_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID NOT NULL REFERENCES public.kahoot_questions(id) ON DELETE CASCADE,
  position INT NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 3),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  is_correct BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kahoot_q_options_question ON public.kahoot_question_options(question_id, position);

-- ── kahoot_games ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kahoot_games (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id UUID NOT NULL REFERENCES public.polls(id) ON DELETE CASCADE,
  host_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pin TEXT NOT NULL CHECK (pin ~ '^[0-9]{6}$'),
  -- lobby → question → reveal → leaderboard → (question…) → podium → ended
  status TEXT NOT NULL DEFAULT 'lobby'
    CHECK (status IN ('lobby', 'question', 'reveal', 'leaderboard', 'podium', 'ended')),
  current_question_id UUID REFERENCES public.kahoot_questions(id) ON DELETE SET NULL,
  current_index INT NOT NULL DEFAULT -1,
  question_started_at TIMESTAMPTZ,
  question_locked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kahoot_games_poll ON public.kahoot_games(poll_id);
-- Solo un juego "vivo" por PIN a la vez (los terminados liberan el PIN).
CREATE UNIQUE INDEX IF NOT EXISTS idx_kahoot_games_pin_active
  ON public.kahoot_games(pin) WHERE status <> 'ended';

DROP TRIGGER IF EXISTS trg_kahoot_games_updated_at ON public.kahoot_games;
CREATE TRIGGER trg_kahoot_games_updated_at
  BEFORE UPDATE ON public.kahoot_games
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── kahoot_players ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kahoot_players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID NOT NULL REFERENCES public.kahoot_games(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL CHECK (length(nickname) BETWEEN 1 AND 40),
  score INT NOT NULL DEFAULT 0 CHECK (score >= 0),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_kahoot_players_game ON public.kahoot_players(game_id, score DESC);

-- ── kahoot_answers ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kahoot_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID NOT NULL REFERENCES public.kahoot_games(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES public.kahoot_questions(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES public.kahoot_players(id) ON DELETE CASCADE,
  option_id UUID NOT NULL REFERENCES public.kahoot_question_options(id) ON DELETE CASCADE,
  is_correct BOOLEAN NOT NULL,
  points INT NOT NULL DEFAULT 0,
  response_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, question_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_kahoot_answers_game_q ON public.kahoot_answers(game_id, question_id);
CREATE INDEX IF NOT EXISTS idx_kahoot_answers_player ON public.kahoot_answers(player_id);

-- ════════════════════════════════════════════════════════════════════
-- RLS
-- ════════════════════════════════════════════════════════════════════
ALTER TABLE public.kahoot_questions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kahoot_question_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kahoot_games            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kahoot_players          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kahoot_answers          ENABLE ROW LEVEL SECURITY;

-- kahoot_questions: el texto de la pregunta lo gestiona el docente; los
-- alumnos lo reciben vía RPC (no por SELECT directo) para no filtrar el
-- set completo antes de tiempo. Docente del poll ancla / Admin / SA.
DROP POLICY IF EXISTS kahoot_questions_rw ON public.kahoot_questions;
CREATE POLICY kahoot_questions_rw ON public.kahoot_questions FOR ALL
  USING (public._poll_anchor_teacher(poll_id, auth.uid()) OR public.has_role(auth.uid(), 'Admin') OR public.is_super_admin())
  WITH CHECK (public._poll_anchor_teacher(poll_id, auth.uid()) OR public.has_role(auth.uid(), 'Admin') OR public.is_super_admin());

-- kahoot_question_options: IDÉNTICO — NUNCA legible por estudiantes
-- (verían is_correct). Solo docente/admin. Los alumnos las reciben sin
-- is_correct vía kahoot_get_state.
DROP POLICY IF EXISTS kahoot_q_options_rw ON public.kahoot_question_options;
CREATE POLICY kahoot_q_options_rw ON public.kahoot_question_options FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.kahoot_questions q
    WHERE q.id = question_id
      AND (public._poll_anchor_teacher(q.poll_id, auth.uid()) OR public.has_role(auth.uid(), 'Admin') OR public.is_super_admin())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.kahoot_questions q
    WHERE q.id = question_id
      AND (public._poll_anchor_teacher(q.poll_id, auth.uid()) OR public.has_role(auth.uid(), 'Admin') OR public.is_super_admin())
  ));

-- kahoot_games: visible a cualquier miembro del poll (docente o alumno
-- matriculado) para auto-descubrir juegos activos de su curso. Escritura
-- SOLO por RPC (INSERT/UPDATE = false).
DROP POLICY IF EXISTS kahoot_games_select ON public.kahoot_games;
CREATE POLICY kahoot_games_select ON public.kahoot_games FOR SELECT
  USING (public._poll_has_member(poll_id, auth.uid()) OR public.has_role(auth.uid(), 'Admin') OR public.is_super_admin());

-- kahoot_players: visible a miembros del poll (leaderboard público en el
-- juego). Escritura solo por RPC.
DROP POLICY IF EXISTS kahoot_players_select ON public.kahoot_players;
CREATE POLICY kahoot_players_select ON public.kahoot_players FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.kahoot_games g
    WHERE g.id = game_id
      AND (public._poll_has_member(g.poll_id, auth.uid()) OR public.has_role(auth.uid(), 'Admin') OR public.is_super_admin())
  ));

-- kahoot_answers: cada jugador ve SOLO las suyas; el docente/host ve
-- todas (para el contador en vivo). Escritura solo por RPC.
DROP POLICY IF EXISTS kahoot_answers_select ON public.kahoot_answers;
CREATE POLICY kahoot_answers_select ON public.kahoot_answers FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.kahoot_players p WHERE p.id = player_id AND p.user_id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.kahoot_games g
      WHERE g.id = game_id
        AND (public._poll_anchor_teacher(g.poll_id, auth.uid()) OR public.has_role(auth.uid(), 'Admin') OR public.is_super_admin())
    )
  );

-- ════════════════════════════════════════════════════════════════════
-- Realtime: publicar games/players/answers para los dos clientes (host +
-- jugadores). REPLICA IDENTITY FULL para que los filtros por game_id
-- funcionen también en UPDATE/DELETE.
-- ════════════════════════════════════════════════════════════════════
ALTER TABLE public.kahoot_games   REPLICA IDENTITY FULL;
ALTER TABLE public.kahoot_players REPLICA IDENTITY FULL;
ALTER TABLE public.kahoot_answers REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.kahoot_games; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.kahoot_players; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.kahoot_answers; EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- RPC: kahoot_create_game(_poll_id) → crea un juego en lobby con PIN.
-- Solo el docente del poll ancla (o Admin/SA).
-- ════════════════════════════════════════════════════════════════════
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
  IF NOT (public._poll_anchor_teacher(_poll_id, v_uid) OR public.has_role(v_uid, 'Admin') OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Solo el docente puede hospedar este Kahoot' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_n FROM public.kahoot_questions WHERE poll_id = _poll_id;
  IF v_n = 0 THEN RAISE EXCEPTION 'El Kahoot no tiene preguntas' USING ERRCODE = 'P0001'; END IF;

  -- PIN de 6 dígitos único entre juegos no terminados.
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

-- ════════════════════════════════════════════════════════════════════
-- RPC: kahoot_join_game(_pin, _nickname) → entra al juego (solo lobby).
-- Cualquier alumno matriculado en un curso del poll. Re-entrar conserva
-- el jugador (upsert por (game, user)).
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.kahoot_join_game(_pin TEXT, _nickname TEXT)
RETURNS public.kahoot_players
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_game public.kahoot_games;
  v_nick TEXT := nullif(btrim(_nickname), '');
  v_player public.kahoot_players;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_game FROM public.kahoot_games WHERE pin = _pin AND status <> 'ended' ORDER BY created_at DESC LIMIT 1;
  IF v_game.id IS NULL THEN RAISE EXCEPTION 'PIN inválido o el juego ya terminó' USING ERRCODE = 'P0001'; END IF;
  IF NOT public._poll_has_member(v_game.poll_id, v_uid) THEN
    RAISE EXCEPTION 'No estás matriculado en el curso de este Kahoot' USING ERRCODE = '42501';
  END IF;
  -- Permitir re-entrar mientras siga vivo; bloquear NUEVOS ingresos una
  -- vez arrancado el juego (status <> lobby) salvo que ya seas jugador.
  IF v_game.status <> 'lobby' AND NOT EXISTS (
    SELECT 1 FROM public.kahoot_players WHERE game_id = v_game.id AND user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'El juego ya arrancó — no se admiten nuevos jugadores' USING ERRCODE = 'P0001';
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
GRANT EXECUTE ON FUNCTION public.kahoot_join_game(TEXT, TEXT) TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- RPC: kahoot_advance_game(_game_id, _action) → máquina de estados del
-- host. Acciones: start | lock | leaderboard | next | end.
-- ════════════════════════════════════════════════════════════════════
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
  IF NOT (v_game.host_id = v_uid OR public._poll_anchor_teacher(v_game.poll_id, v_uid) OR public.has_role(v_uid, 'Admin') OR public.is_super_admin()) THEN
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

-- ════════════════════════════════════════════════════════════════════
-- RPC: kahoot_submit_answer(_game_id, _option_id) → registra la
-- respuesta del jugador y calcula puntos SERVER-SIDE (acierto + rapidez).
-- Fórmula clásica Kahoot: correcto → points * (1 - (t/limite)/2), de modo
-- que responder al instante = puntos completos, al límite = mitad.
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.kahoot_submit_answer(_game_id UUID, _option_id UUID)
RETURNS public.kahoot_answers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_game public.kahoot_games;
  v_player public.kahoot_players;
  v_q public.kahoot_questions;
  v_opt public.kahoot_question_options;
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

  SELECT * INTO v_opt FROM public.kahoot_question_options WHERE id = _option_id AND question_id = v_q.id;
  IF v_opt.id IS NULL THEN RAISE EXCEPTION 'La opción no pertenece a la pregunta actual' USING ERRCODE = '22023'; END IF;

  -- Una respuesta por (juego, pregunta, jugador).
  IF EXISTS (SELECT 1 FROM public.kahoot_answers WHERE game_id = _game_id AND question_id = v_q.id AND player_id = v_player.id) THEN
    RAISE EXCEPTION 'Ya respondiste esta pregunta' USING ERRCODE = 'P0001';
  END IF;

  v_is_correct := v_opt.is_correct;
  v_limit_ms := v_q.time_limit_seconds * 1000.0;
  v_elapsed_ms := GREATEST(0, LEAST(v_limit_ms,
    EXTRACT(EPOCH FROM (now() - coalesce(v_game.question_started_at, now()))) * 1000.0));
  IF v_is_correct THEN
    v_points := round(v_q.points * (1 - (v_elapsed_ms / v_limit_ms) / 2.0));
  ELSE
    v_points := 0;
  END IF;

  INSERT INTO public.kahoot_answers (game_id, question_id, player_id, option_id, is_correct, points, response_ms)
  VALUES (_game_id, v_q.id, v_player.id, _option_id, v_is_correct, v_points, round(v_elapsed_ms)::int)
  RETURNING * INTO v_ans;

  UPDATE public.kahoot_players SET score = score + v_points WHERE id = v_player.id;
  RETURN v_ans;
END $$;
GRANT EXECUTE ON FUNCTION public.kahoot_submit_answer(UUID, UUID) TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- RPC: kahoot_get_state(_game_id) → snapshot JSON apto para el caller.
-- Oculta is_correct hasta el reveal (salvo al host). Powerea ambas vistas
-- (host + jugador) en cada tick de realtime.
-- ════════════════════════════════════════════════════════════════════
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

  -- Leaderboard (todos los jugadores, ordenados por score).
  SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', p.id, 'nickname', p.nickname, 'score', p.score, 'user_id', p.user_id
          ) ORDER BY p.score DESC, p.joined_at), '[]'::jsonb)
    INTO v_players FROM public.kahoot_players p WHERE p.game_id = _game_id;

  -- Pregunta actual (si hay) + opciones. is_correct solo si reveal o host.
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
        'options', v_options
      );
    END IF;
  END IF;

  -- "me" — info del jugador actual (null si es solo host/observador).
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
