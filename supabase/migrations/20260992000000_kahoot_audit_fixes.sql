-- ════════════════════════════════════════════════════════════════════
-- Kahoot — fixes de la auditoría adversarial de los 6 ajustes:
--
--  P0 (Ajuste 4 — integridad de puntaje): kahoot_submit_answer rechaza el
--      submit mientras now() < question_started_at. El lead de "¡Prepárate!"
--      (mig 20260989) fija question_started_at en el futuro; sin este guard,
--      responder durante el splash daba PUNTAJE MÁXIMO (elapsed clamp a 0).
--
--  P1 (Ajuste 1 — login directo / banner): NUEVA RPC kahoot_my_live_games()
--      SECURITY DEFINER. El banner/card descubrían juegos por SELECT directo a
--      kahoot_games + EMBED poll:polls(title), pero la RLS de polls del alumno
--      exige is_published=TRUE → un Kahoot en BORRADOR (el caso típico, se
--      hospeda sin publicar) devolvía poll=null y el banner lo descartaba →
--      la notificación NUNCA aparecía. Esta RPC trae los juegos vivos de los
--      cursos del alumno (con título), bypassando esa RLS, con guard de papelera.
--
--  P2 (Ajuste 5 — default 20s): add_questions_from_bank_to_kahoot deja de
--      insertar time_limit_seconds=10 literal → hereda el DEFAULT 20 de la
--      columna. (El edge ai-generate-questions se arregla aparte.)
--
-- Cuerpos de kahoot_submit_answer (origen 20260936) y add_questions_from_bank_to_kahoot
-- (origen 20260935) copiados literalmente, con el cambio mínimo marcado "FIX (auditoría)".
-- ════════════════════════════════════════════════════════════════════

-- ── P1: RPC de descubrimiento de juegos vivos (no toca la RLS de polls) ──
CREATE OR REPLACE FUNCTION public.kahoot_my_live_games()
RETURNS TABLE (game_id uuid, poll_title text, status text, am_i_player boolean)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $fn$
  SELECT g.id, p.title, g.status,
         EXISTS (SELECT 1 FROM public.kahoot_players kp
                  WHERE kp.game_id = g.id AND kp.user_id = auth.uid())
    FROM public.kahoot_games g
    JOIN public.polls p ON p.id = g.poll_id
   WHERE g.status <> 'ended'
     AND p.poll_type = 'kahoot'
     AND p.deleted_at IS NULL
     AND public._poll_has_member(g.poll_id, auth.uid())
   ORDER BY g.created_at DESC;
$fn$;
REVOKE ALL ON FUNCTION public.kahoot_my_live_games() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kahoot_my_live_games() TO authenticated;

-- ── P0: kahoot_submit_answer + guard now() < question_started_at ─────
CREATE OR REPLACE FUNCTION public.kahoot_submit_answer(_game_id UUID, _option_ids UUID[])
RETURNS public.kahoot_answers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  -- INVARIANTE CROSS-FILE: el auto-lock del host
  -- (src/routes/app.teacher.kahoot.$gameId.tsx, setTimeout tras left===0) DEBE
  -- ser >= este v_grace_ms para que los auto-envíos en left===0 entren mientras
  -- el status sigue 'question'. El cierre REAL es server-side por tiempo (abajo).
  v_grace_ms CONSTANT NUMERIC := 2000;
  v_uid UUID := auth.uid();
  v_game public.kahoot_games;
  v_player public.kahoot_players;
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
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_game FROM public.kahoot_games WHERE id = _game_id;
  IF v_game.id IS NULL THEN RAISE EXCEPTION 'Juego no encontrado' USING ERRCODE = '22023'; END IF;

  -- AISLAMIENTO DE TENANT (defensa en profundidad, igual que kahoot_join_game):
  -- aunque ya tenga fila en kahoot_players, si perdió la matrícula / cambió de
  -- tenant deja de poder responder. poll_courses no cruza tenants (trigger),
  -- así que _poll_has_member implica mismo tenant. _poll_admin_in_tenant cubre
  -- Admin de su tenant + SuperAdmin.
  IF NOT (public._poll_has_member(v_game.poll_id, v_uid)
          OR public._poll_admin_in_tenant(v_game.poll_id, v_uid)) THEN
    RAISE EXCEPTION 'Sin acceso a este juego' USING ERRCODE = '42501';
  END IF;

  -- CIERRE LÓGICO: solo en 'question'. En 'reveal' se muestra is_correct → NO
  -- se admite responder (anti-cheat). La gracia funciona porque el host retrasa
  -- el lock 2200ms > 2000ms de gracia; un lock manual temprano cierra ya.
  IF v_game.status <> 'question' THEN
    RAISE EXCEPTION 'La pregunta no está abierta para responder' USING ERRCODE = 'P0001';
  END IF;
  IF v_game.question_started_at IS NULL THEN
    RAISE EXCEPTION 'La pregunta aún no ha iniciado' USING ERRCODE = 'P0001';
  END IF;
  -- FIX (auditoría): el lead de "¡Prepárate!" (mig 20260989) fija
  -- question_started_at en el FUTURO. Mientras no llegue ese instante la
  -- pregunta NO está abierta: rechazar el submit. Sin esto, responder durante
  -- el splash daría PUNTAJE MÁXIMO (v_elapsed_ms = GREATEST(0, now-started) = 0)
  -- → agujero de integridad de puntaje introducido por el lead.
  IF now() < v_game.question_started_at THEN
    RAISE EXCEPTION 'La pregunta aún no está abierta' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_player FROM public.kahoot_players WHERE game_id = _game_id AND user_id = v_uid;
  IF v_player.id IS NULL THEN RAISE EXCEPTION 'No estás en este juego' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_q FROM public.kahoot_questions WHERE id = v_game.current_question_id;
  IF v_q.id IS NULL THEN RAISE EXCEPTION 'No hay pregunta activa' USING ERRCODE = 'P0001'; END IF;

  -- CIERRE FORZADO autoritativo por TIEMPO de servidor + gracia. GREATEST(0,…)
  -- protege contra clock-skew (now() < started) → elapsed nunca negativo.
  v_limit_ms := v_q.time_limit_seconds * 1000.0;
  v_elapsed_ms := GREATEST(0, EXTRACT(EPOCH FROM (now() - v_game.question_started_at)) * 1000.0);
  IF v_elapsed_ms > v_limit_ms + v_grace_ms THEN
    RAISE EXCEPTION 'El tiempo para responder ya cerró' USING ERRCODE = 'P0001';
  END IF;

  -- Set de opciones, deduplicado y sin nulls. Vacío permitido = participación
  -- en blanco (el alumno no alcanzó a elegir antes del timeout).
  SELECT array_agg(DISTINCT x) INTO v_opts
    FROM unnest(coalesce(_option_ids, '{}'::uuid[])) x WHERE x IS NOT NULL;
  v_empty := (v_opts IS NULL OR array_length(v_opts, 1) IS NULL);

  IF NOT v_empty THEN
    IF EXISTS (
      SELECT 1 FROM unnest(v_opts) oid
       WHERE NOT EXISTS (SELECT 1 FROM public.kahoot_question_options WHERE id = oid AND question_id = v_q.id)
    ) THEN
      RAISE EXCEPTION 'Una opción no pertenece a la pregunta actual' USING ERRCODE = '22023';
    END IF;
    IF NOT v_q.multi_select AND array_length(v_opts, 1) > 1 THEN
      RAISE EXCEPTION 'Esta pregunta admite una sola opción' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Una respuesta por (juego, pregunta, jugador). El UNIQUE es el cierre duro
  -- contra doble-submit en carrera (un blanco YA es haber respondido).
  IF EXISTS (SELECT 1 FROM public.kahoot_answers WHERE game_id = _game_id AND question_id = v_q.id AND player_id = v_player.id) THEN
    RAISE EXCEPTION 'Ya respondiste esta pregunta' USING ERRCODE = 'P0001';
  END IF;

  -- Correctitud (con v_opts vacío todo queda 0 → incorrecto).
  SELECT count(*) FILTER (WHERE o.is_correct), count(*)
    INTO v_sel_correct, v_sel_total
    FROM public.kahoot_question_options o
   WHERE o.question_id = v_q.id AND v_opts IS NOT NULL AND o.id = ANY(v_opts);
  SELECT count(*) INTO v_total_correct
    FROM public.kahoot_question_options WHERE question_id = v_q.id AND is_correct;

  IF v_empty THEN
    v_is_correct := false;
  ELSIF v_q.multi_select THEN
    v_is_correct := (v_total_correct > 0 AND v_sel_correct = v_total_correct AND v_sel_total = v_total_correct);
  ELSE
    v_is_correct := (v_sel_total = 1 AND v_sel_correct = 1);
  END IF;

  -- Puntos: clamp [0, límite] (no premia la franja de gracia ni rompe por skew).
  -- Espejo EXACTO de kahootPoints() en src/modules/polls/kahoot.ts.
  v_clamped_ms := GREATEST(0, LEAST(v_elapsed_ms, v_limit_ms));
  IF v_is_correct THEN
    v_points := round(v_q.points * (1 - (v_clamped_ms / v_limit_ms) / 2.0));
  ELSE
    v_points := 0;
  END IF;

  INSERT INTO public.kahoot_answers (game_id, question_id, player_id, option_id, option_ids, is_correct, points, response_ms)
  VALUES (
    _game_id, v_q.id, v_player.id,
    CASE WHEN v_empty OR v_q.multi_select THEN NULL ELSE v_opts[1] END,
    CASE WHEN v_empty THEN NULL ELSE v_opts END,
    v_is_correct, v_points, round(v_clamped_ms)::int
  )
  RETURNING * INTO v_ans;

  UPDATE public.kahoot_players SET score = score + v_points WHERE id = v_player.id;
  RETURN v_ans;
END $$;
GRANT EXECUTE ON FUNCTION public.kahoot_submit_answer(UUID, UUID[]) TO authenticated;

-- ── P2: add_questions_from_bank_to_kahoot hereda DEFAULT 20 ─────────
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

    INSERT INTO public.kahoot_questions (poll_id, text, points, multi_select, position)
    -- FIX (auditoría): sin time_limit_seconds → hereda el DEFAULT 20 de la columna
    -- (antes insertaba 10 literal, saltándose el default).
    VALUES (_poll_id, left(_bank.content, 500), _points, _multi, _max_pos)
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
