-- ════════════════════════════════════════════════════════════════════
-- KAHOOT — endurecimiento de la sesión en vivo (seguridad + casos borde).
--
-- Este proyecto NO tiene un backend de sockets: el realtime es Supabase
-- Realtime (postgres_changes sobre kahoot_games/players/answers) y la
-- "sala" es la fila kahoot_games + sus RPCs SECURITY DEFINER. Por eso el
-- "disconnect del docente" se modela con un HEARTBEAT (host_last_seen_at):
-- el host late cada pocos segundos desde su vista; si deja de latir, se lo
-- considera AUSENTE y la sala se comporta como "pausada".
--
-- Bugs/casos cubiertos:
--  1. Fuga de validación de PIN: el docente abría "Presentar en vivo" y se
--     salía → la sala (lobby) quedaba huérfana y los alumnos entraban. Ahora
--     kahoot_join_game RECHAZA nuevos ingresos si el host está ausente
--     (heartbeat stale). Además el PIN deja de exponerse a los alumnos:
--     kahoot_get_state solo lo devuelve al host (el front ya no lo lee de la
--     tabla ni hace 1-click join).
--  2. Desconexión súbita del docente: kahoot_get_state expone host_present;
--     la vista del alumno muestra "Esperando al docente…" sin sacarlo.
--  3. Unión prematura / PIN expirado / sala destruida: guardas en el RPC de
--     ingreso (host ausente, juego ya arrancado, poll en papelera, ended).
--  4. Edición en vivo: trigger que bloquea editar preguntas/opciones del
--     Kahoot mientras hay un juego EN VIVO (question/reveal/leaderboard/podium).
--
-- Umbral de presencia: si el host no late en > 25s → ausente. El cliente
-- late cada ~8s, así que 2 latidos perdidos lo marcan ausente.
-- ════════════════════════════════════════════════════════════════════

-- ── A) Columna heartbeat ────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.kahoot_games') IS NOT NULL THEN
    ALTER TABLE public.kahoot_games
      ADD COLUMN IF NOT EXISTS host_last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END $$;

-- ── B) RPC: kahoot_host_heartbeat — el host marca que sigue presente ──
-- Solo el host del juego (o docente ancla / Admin / SA). Actualiza
-- host_last_seen_at sin tocar el estado del juego. El front lo invoca en un
-- intervalo mientras la vista del host está montada.
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
  IF NOT (v_game.host_id = v_uid OR public._poll_anchor_teacher(v_game.poll_id, v_uid)
          OR public.has_role(v_uid, 'Admin') OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Solo el host puede latir' USING ERRCODE = '42501';
  END IF;
  UPDATE public.kahoot_games SET host_last_seen_at = now() WHERE id = _game_id;
END $$;
GRANT EXECUTE ON FUNCTION public.kahoot_host_heartbeat(UUID) TO authenticated;

-- ── C) kahoot_join_game — guarda de presencia del host para NUEVOS ────
-- Cuerpo de la mig 20260925000000 (rechazo de poll en papelera) + guarda de
-- presencia: un alumno que AÚN NO es jugador no puede entrar si el host está
-- ausente (sala huérfana) ni si el juego ya arrancó. Los que YA son jugadores
-- pueden RECONECTAR siempre (no es una vulnerabilidad: ya fueron admitidos).
CREATE OR REPLACE FUNCTION public.kahoot_join_game(_pin TEXT, _nickname TEXT)
RETURNS public.kahoot_players
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_game public.kahoot_games;
  v_nick TEXT := nullif(btrim(_nickname), '');
  v_player public.kahoot_players;
  v_is_existing BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_game FROM public.kahoot_games WHERE pin = _pin AND status <> 'ended' ORDER BY created_at DESC LIMIT 1;
  IF v_game.id IS NULL THEN RAISE EXCEPTION 'PIN inválido o el juego ya terminó' USING ERRCODE = 'P0001'; END IF;
  -- Guard de papelera: poll soft-deleted ⇒ se comporta como PIN inválido.
  IF EXISTS (SELECT 1 FROM public.polls WHERE id = v_game.poll_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'PIN inválido o el juego ya terminó' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public._poll_has_member(v_game.poll_id, v_uid) THEN
    RAISE EXCEPTION 'No estás matriculado en el curso de este Kahoot' USING ERRCODE = '42501';
  END IF;

  v_is_existing := EXISTS (SELECT 1 FROM public.kahoot_players WHERE game_id = v_game.id AND user_id = v_uid);

  -- NUEVOS ingresos: la sala debe estar atendida (host presente) y no haber
  -- arrancado. Los jugadores existentes RECONECTAN sin estas restricciones.
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
GRANT EXECUTE ON FUNCTION public.kahoot_join_game(TEXT, TEXT) TO authenticated;

-- ── D) kahoot_get_state — oculta PIN a no-host + expone host_present ──
-- Cuerpo de la mig 20260926000000 (multi-select) con 2 cambios en el objeto
-- `game`: `pin` solo si v_is_host (NULL para alumnos — el PIN es del docente)
-- y `host_present` (heartbeat fresco) para que el alumno sepa si el docente
-- está conectado.
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
      'id', v_game.id,
      -- El PIN es del DOCENTE: solo el host lo recibe. Los alumnos lo teclean
      -- (o escanean el QR); nunca lo leen del estado → cierra la fuga.
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

-- ── E) Bloqueo de edición mientras el juego está EN VIVO ─────────────
-- Trigger sobre kahoot_questions + kahoot_question_options: rechaza
-- INSERT/UPDATE/DELETE si existe un juego de ese poll en un estado en vivo
-- (question/reveal/leaderboard/podium). En 'lobby' (antes de arrancar) y
-- 'ended' (terminado) se permite editar. Enforcement a nivel BD — el front
-- también lo refleja, pero esta es la barrera autoritativa.
CREATE OR REPLACE FUNCTION public.tg_kahoot_block_edit_when_live()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_poll UUID;
BEGIN
  IF TG_TABLE_NAME = 'kahoot_questions' THEN
    v_poll := COALESCE(NEW.poll_id, OLD.poll_id);
  ELSE
    SELECT poll_id INTO v_poll FROM public.kahoot_questions
      WHERE id = COALESCE(NEW.question_id, OLD.question_id);
  END IF;

  IF v_poll IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.kahoot_games
     WHERE poll_id = v_poll AND status IN ('question', 'reveal', 'leaderboard', 'podium')
  ) THEN
    RAISE EXCEPTION 'No se puede editar el Kahoot mientras hay un juego en vivo. Termina la sesión primero.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

DO $$
BEGIN
  IF to_regclass('public.kahoot_questions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_kahoot_q_block_live ON public.kahoot_questions;
    CREATE TRIGGER trg_kahoot_q_block_live
      BEFORE INSERT OR UPDATE OR DELETE ON public.kahoot_questions
      FOR EACH ROW EXECUTE FUNCTION public.tg_kahoot_block_edit_when_live();
  END IF;
  IF to_regclass('public.kahoot_question_options') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_kahoot_qopt_block_live ON public.kahoot_question_options;
    CREATE TRIGGER trg_kahoot_qopt_block_live
      BEFORE INSERT OR UPDATE OR DELETE ON public.kahoot_question_options
      FOR EACH ROW EXECUTE FUNCTION public.tg_kahoot_block_edit_when_live();
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
