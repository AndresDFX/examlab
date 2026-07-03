-- ══════════════════════════════════════════════════════════════════════
-- kahoot_create_game: rechazar hospedar si ALGUNA pregunta del Kahoot tiene < 2
-- opciones o ninguna correcta. El editor puede dejar una pregunta con cero/una
-- opción por un guardado no atómico (DELETE + INSERT sin transacción) → pregunta
-- injugable en vivo. Este guard server-side lo previene independientemente de la
-- causa. Reproduce el cuerpo actual VERBATIM + el nuevo chequeo tras "sin preguntas".
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.kahoot_create_game(_poll_id uuid)
 RETURNS kahoot_games
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    IF EXISTS (SELECT 1 FROM public.polls WHERE id = _poll_id AND deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Encuesta no encontrada' USING ERRCODE = '22023';
    END IF;
    IF v_type <> 'kahoot' THEN RAISE EXCEPTION 'La encuesta no es de tipo Kahoot' USING ERRCODE = 'P0001'; END IF;
    IF NOT (public._poll_anchor_teacher(_poll_id, v_uid) OR public._poll_admin_in_tenant(_poll_id, v_uid)) THEN
      RAISE EXCEPTION 'Solo el docente puede hospedar este Kahoot' USING ERRCODE = '42501';
    END IF;
    SELECT count(*) INTO v_n FROM public.kahoot_questions WHERE poll_id = _poll_id;
    IF v_n = 0 THEN RAISE EXCEPTION 'El Kahoot no tiene preguntas' USING ERRCODE = 'P0001'; END IF;
    -- Cada pregunta debe tener >= 2 opciones y al menos una correcta (evita
    -- preguntas injugables por un guardado parcial de opciones).
    IF EXISTS (
      SELECT 1 FROM public.kahoot_questions q
      WHERE q.poll_id = _poll_id
        AND (
          (SELECT count(*) FROM public.kahoot_question_options o WHERE o.question_id = q.id) < 2
          OR NOT EXISTS (
            SELECT 1 FROM public.kahoot_question_options o WHERE o.question_id = q.id AND o.is_correct
          )
        )
    ) THEN
      RAISE EXCEPTION 'Cada pregunta del Kahoot debe tener al menos 2 opciones y una correcta'
        USING ERRCODE = 'P0001';
    END IF;
    LOOP
      v_pin := lpad((floor(random() * 1000000))::int::text, 6, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.kahoot_games WHERE pin = v_pin AND status <> 'ended');
    END LOOP;
    INSERT INTO public.kahoot_games (poll_id, host_id, pin, status, current_index)
    VALUES (_poll_id, v_uid, v_pin, 'lobby', -1)
    RETURNING * INTO v_game;
    RETURN v_game;
  END $function$;

NOTIFY pgrst, 'reload schema';
