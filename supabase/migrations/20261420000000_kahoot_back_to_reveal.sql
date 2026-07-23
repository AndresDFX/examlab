-- ════════════════════════════════════════════════════════════════════
-- KAHOOT ("Reto en vivo") — acción dedicada 'reveal' para VOLVER de la
-- tabla de posiciones (leaderboard) a la vista de respuestas de la pregunta
-- ACTUAL, sin avanzar de pregunta.
--
-- Motivación: en el host, el flujo por defecto ahora pasa de 'reveal' a
-- 'leaderboard' (ver posiciones) antes de avanzar. Desde 'leaderboard' el
-- docente puede querer regresar a mostrar las respuestas de la MISMA
-- pregunta ("Ver respuestas"). Hasta hoy no había acción para eso: el único
-- camino era reusar 'lock', semánticamente etiquetado como question->reveal,
-- lo cual es frágil (si a 'lock' se le agregara un guard de status de origen,
-- el retroceso se rompería en silencio). Esta acción dedicada lo formaliza.
--
-- Semántica de 'reveal':
--   status = 'reveal', question_locked = TRUE.
--   NO toca current_index ni current_question_id → kahoot_get_state vuelve a
--   exponer is_correct + responders_by_option de la MISMA pregunta.
--   question_locked = TRUE (NO reabre el envío: kahoot_submit_answer exige
--   status='question'; además la UNIQUE impide re-responder). Las respuestas
--   viven en kahoot_answers y ninguna acción las borra → el reveal se
--   reconstruye intacto.
--
-- El RETURNS no cambia (sigue RETURNS public.kahoot_games) → CREATE OR REPLACE
-- sin DROP. Cuerpo tomado de la última versión (20260989000000) + la rama
-- ELSIF nueva. Defensiva con to_regclass como el resto del repo.
-- ════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.kahoot_games') IS NOT NULL THEN
    CREATE OR REPLACE FUNCTION public.kahoot_advance_game(_game_id UUID, _action TEXT)
    RETURNS public.kahoot_games
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
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
      ELSIF _action = 'reveal' THEN
        -- Volver de 'leaderboard' a la vista de respuestas de la pregunta
        -- ACTUAL, sin avanzar. NO toca current_index/current_question_id, así
        -- que kahoot_get_state vuelve a exponer is_correct + responders_by_option
        -- de la misma pregunta. question_locked=TRUE (no reabre el envío).
        UPDATE public.kahoot_games SET status = 'reveal', question_locked = TRUE WHERE id = _game_id RETURNING * INTO v_game;
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
    END $fn$;
    GRANT EXECUTE ON FUNCTION public.kahoot_advance_game(UUID, TEXT) TO authenticated;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
