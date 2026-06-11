-- ════════════════════════════════════════════════════════════════════
-- AISLAMIENTO MULTI-TENANT de encuestas — blindaje del linkage curso↔encuesta.
--
-- Brecha raíz: el comentario de 20260720000000 afirmaba que
-- "enforce_course_tenant previene cross-tenant linkage", pero ese trigger
-- NUNCA se implementó. Nada impedía que `poll_courses` enlazara una encuesta
-- de un tenant (ej. FESNA) a un curso de OTRO (ej. UAJC). Como el estudiante
-- lista encuestas por `poll_courses WHERE course_id IN (sus cursos)`, un alumno
-- de UAJC matriculado en ese curso veía la encuesta de FESNA → fuga de datos
-- entre inquilinos (incluye los Kahoot, que son polls).
--
-- Fix (3 partes):
--  A. LIMPIEZA: borrar los `poll_courses` cruzados existentes (tenant del curso
--     ≠ tenant del curso ancla de la encuesta) — son exactamente la fuga.
--  B. TRIGGER `tg_poll_courses_enforce_tenant`: rechaza enlazar una encuesta a
--     un curso de otra institución. Una encuesta vive en UN tenant (el de su
--     curso ancla = polls.course_id); todo curso linkeado debe ser del mismo.
--  C. `kahoot_join_game`: guarda de tenant EXPLÍCITA — un alumno solo puede
--     unirse a un juego de SU tenant. Aunque la matrícula ya lo acotaba, esto
--     blinda el "intento de acceso inter-tenant con PIN válido de otro tenant"
--     incluso si quedara un link cruzado: responde como PIN inválido (no filtra
--     que el juego existe en otro tenant).
-- ════════════════════════════════════════════════════════════════════

-- ── A) Limpieza de links cruzados existentes ─────────────────────────
DO $$
BEGIN
  IF to_regclass('public.poll_courses') IS NOT NULL AND to_regclass('public.polls') IS NOT NULL THEN
    DELETE FROM public.poll_courses pc
     USING public.courses c_link, public.polls p, public.courses c_anchor
     WHERE pc.course_id = c_link.id
       AND p.id = pc.poll_id
       AND c_anchor.id = p.course_id
       AND c_link.tenant_id IS DISTINCT FROM c_anchor.tenant_id;
  END IF;
END $$;

-- ── B) Trigger anti cross-tenant linkage ─────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_poll_courses_enforce_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_poll_tenant UUID;
  v_course_tenant UUID;
BEGIN
  -- Tenant de la encuesta = tenant de su curso ancla (polls.course_id).
  SELECT c.tenant_id INTO v_poll_tenant
    FROM public.polls p
    JOIN public.courses c ON c.id = p.course_id
   WHERE p.id = NEW.poll_id;
  SELECT tenant_id INTO v_course_tenant FROM public.courses WHERE id = NEW.course_id;

  IF v_poll_tenant IS DISTINCT FROM v_course_tenant THEN
    RAISE EXCEPTION 'No se puede vincular una encuesta a un curso de otra institución'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF to_regclass('public.poll_courses') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_poll_courses_enforce_tenant ON public.poll_courses;
    CREATE TRIGGER trg_poll_courses_enforce_tenant
      BEFORE INSERT OR UPDATE OF course_id, poll_id ON public.poll_courses
      FOR EACH ROW EXECUTE FUNCTION public.tg_poll_courses_enforce_tenant();
  END IF;
END $$;

-- ── C) kahoot_join_game — guarda de tenant explícita ─────────────────
-- Cuerpo de 20260931000000 (presencia del host) + guarda de tenant: el alumno
-- debe pertenecer al MISMO tenant que el juego. Si no, respondemos como PIN
-- inválido (no filtramos la existencia del juego en otro tenant).
CREATE OR REPLACE FUNCTION public.kahoot_join_game(_pin TEXT, _nickname TEXT)
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
  SELECT * INTO v_game FROM public.kahoot_games WHERE pin = _pin AND status <> 'ended' ORDER BY created_at DESC LIMIT 1;
  IF v_game.id IS NULL THEN RAISE EXCEPTION 'PIN inválido o el juego ya terminó' USING ERRCODE = 'P0001'; END IF;
  -- Guard de papelera: poll soft-deleted ⇒ se comporta como PIN inválido.
  IF EXISTS (SELECT 1 FROM public.polls WHERE id = v_game.poll_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'PIN inválido o el juego ya terminó' USING ERRCODE = 'P0001';
  END IF;

  -- AISLAMIENTO DE TENANT: el juego pertenece al tenant de su curso ancla; el
  -- alumno debe ser del MISMO tenant. SuperAdmin exento. Intento inter-tenant
  -- (PIN válido de otra institución) → se comporta como PIN inválido.
  IF NOT public.is_super_admin() THEN
    SELECT c.tenant_id INTO v_game_tenant
      FROM public.polls p JOIN public.courses c ON c.id = p.course_id
     WHERE p.id = v_game.poll_id;
    SELECT tenant_id INTO v_user_tenant FROM public.profiles WHERE id = v_uid;
    IF v_game_tenant IS DISTINCT FROM v_user_tenant THEN
      RAISE EXCEPTION 'PIN inválido o el juego ya terminó' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NOT public._poll_has_member(v_game.poll_id, v_uid) THEN
    RAISE EXCEPTION 'No estás matriculado en el curso de este Kahoot' USING ERRCODE = '42501';
  END IF;

  v_is_existing := EXISTS (SELECT 1 FROM public.kahoot_players WHERE game_id = v_game.id AND user_id = v_uid);

  -- NUEVOS ingresos: sala atendida (host presente) y no arrancada. Los
  -- jugadores existentes RECONECTAN sin estas restricciones.
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

NOTIFY pgrst, 'reload schema';
