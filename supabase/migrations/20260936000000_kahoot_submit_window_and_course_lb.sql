-- ════════════════════════════════════════════════════════════════════
-- Kahoot: cierre por TIEMPO DE SERVIDOR + gracia, participación en blanco,
-- guarda de tenant del alumno, default de tiempo 20→10s, y leaderboard
-- ACUMULADO por curso.
--
-- (1) kahoot_submit_answer — antes el cierre dependía de question_locked (que
--     el host pone en left===0), así que un auto-lock mataba la ventana de
--     gracia, y nada validaba el tiempo server-side. Ahora la aceptación se
--     decide por TIEMPO de servidor: now() <= question_started_at + límite +
--     GRACIA (2s). Se exige status='question' (NO 'reveal' — en reveal el
--     alumno ya ve is_correct; aceptar ahí sería un cheat). El auto-lock del
--     host se retrasa 2200ms (> gracia), así que durante la gracia el status
--     sigue 'question' y los auto-envíos entran; un lock MANUAL temprano cierra
--     al instante a propósito. _option_ids vacío = participación en blanco
--     (is_correct false, 0 pts). Guarda de tenant: el alumno debe ser miembro
--     de un curso del poll (mismo patrón que kahoot_join_game de 20260934000000).
-- (2) kahoot_questions.time_limit_seconds DEFAULT 20→10.
-- (3) kahoot_course_leaderboard — suma score por alumno a través de TODOS los
--     juegos de TODAS las kahoot del curso (poll_courses), top N, tenant-safe.
-- ════════════════════════════════════════════════════════════════════

-- ── (1) kahoot_submit_answer: ventana server + gracia + blanco + tenant ──
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

-- ── (2) Default de tiempo 20→10s ────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.kahoot_questions') IS NOT NULL THEN
    ALTER TABLE public.kahoot_questions ALTER COLUMN time_limit_seconds SET DEFAULT 10;
  END IF;
END $$;

-- ── (3) Leaderboard ACUMULADO por curso ─────────────────────────────
-- Suma el score de cada alumno a través de TODOS los kahoot_players de TODOS
-- los juegos de TODAS las encuestas kahoot ligadas al curso (poll_courses).
-- Tenant-safe (triple guarda): course_in_my_tenant (cubre SA) + el caller debe
-- ser miembro del curso. poll_courses NO cruza tenants (trigger), así que
-- agregar por course_id no filtra datos de otra institución. Excluye kahoot en
-- papelera y al STAFF del curso (docentes que se unen a probar no compiten).
CREATE OR REPLACE FUNCTION public.kahoot_course_leaderboard(_course_id UUID, _limit INT DEFAULT 5)
RETURNS TABLE (
  rank          INT,
  user_id       UUID,
  full_name     TEXT,
  total_score   BIGINT,
  games_played  BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501'; END IF;
  IF NOT public.course_in_my_tenant(_course_id) THEN
    RAISE EXCEPTION 'Curso fuera de tu institución' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_super_admin()
     AND NOT EXISTS (SELECT 1 FROM public.course_enrollments WHERE course_id = _course_id AND user_id = v_uid)
     AND NOT EXISTS (SELECT 1 FROM public.course_teachers   WHERE course_id = _course_id AND user_id = v_uid) THEN
    RAISE EXCEPTION 'No perteneces a este curso' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH agg AS (
    SELECT
      kp.user_id,
      SUM(kp.score)::BIGINT              AS total_score,
      COUNT(DISTINCT kp.game_id)::BIGINT AS games_played,
      MIN(kp.joined_at)                  AS first_joined
    FROM public.poll_courses   pc
    JOIN public.polls          p  ON p.id = pc.poll_id
                                  AND p.poll_type = 'kahoot'
                                  AND p.deleted_at IS NULL
    JOIN public.kahoot_games   g  ON g.poll_id = p.id
    JOIN public.kahoot_players kp ON kp.game_id = g.id
    WHERE pc.course_id = _course_id
      AND NOT EXISTS (SELECT 1 FROM public.course_teachers ct
                       WHERE ct.course_id = _course_id AND ct.user_id = kp.user_id)
    GROUP BY kp.user_id
  )
  SELECT
    RANK() OVER (ORDER BY a.total_score DESC, a.first_joined ASC, a.user_id ASC)::INT,
    a.user_id,
    COALESCE(NULLIF(BTRIM(pr.full_name), ''), 'Estudiante'),
    a.total_score,
    a.games_played
  FROM agg a
  LEFT JOIN public.profiles pr ON pr.id = a.user_id
  ORDER BY a.total_score DESC, a.first_joined ASC, a.user_id ASC
  LIMIT GREATEST(1, _limit);
END $$;
GRANT EXECUTE ON FUNCTION public.kahoot_course_leaderboard(UUID, INT) TO authenticated;

NOTIFY pgrst, 'reload schema';
