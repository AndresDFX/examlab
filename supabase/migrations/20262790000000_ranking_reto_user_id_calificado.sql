-- kahoot_course_leaderboard devolvía 400 (42702: «user_id» ambiguo) en CADA
-- carga del inicio de un estudiante: RETURNS TABLE declara `user_id` como
-- parámetro de salida, y los EXISTS de pertenencia al curso lo usaban sin
-- calificar. La tarjeta del ranking fallaba en silencio. Mismo cuerpo que
-- 20260936000000, con las columnas calificadas.
DO $mig$
BEGIN
  IF to_regclass('public.kahoot_players') IS NULL OR to_regclass('public.poll_courses') IS NULL THEN
    RAISE NOTICE 'kahoot ausente; nada que hacer.';
    RETURN;
  END IF;
  EXECUTE $sql$
CREATE OR REPLACE FUNCTION public.kahoot_course_leaderboard(_course_id UUID, _limit INT DEFAULT 5)
RETURNS TABLE (
  rank          INT,
  user_id       UUID,
  full_name     TEXT,
  total_score   BIGINT,
  games_played  BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501'; END IF;
  IF NOT public.course_in_my_tenant(_course_id) THEN
    RAISE EXCEPTION 'Curso fuera de tu institución' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_super_admin()
     AND NOT EXISTS (SELECT 1 FROM public.course_enrollments ce WHERE ce.course_id = _course_id AND ce.user_id = v_uid)
     AND NOT EXISTS (SELECT 1 FROM public.course_teachers ctx WHERE ctx.course_id = _course_id AND ctx.user_id = v_uid) THEN
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
END $fn$;
  $sql$;
END
$mig$;
