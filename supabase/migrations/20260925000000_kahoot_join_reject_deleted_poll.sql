-- ──────────────────────────────────────────────────────────────────────
-- kahoot_join_game: rechazar juegos de encuestas Kahoot en PAPELERA.
--
-- Regla del proyecto: un item soft-deleted (polls.deleted_at != NULL) NO
-- debe ser visualizable NI usable en ningún flujo hasta restaurarse. El
-- <KahootJoinCard> del estudiante ya filtra los juegos de polls borrados a
-- nivel UI, pero el RPC de ingreso `kahoot_join_game` (SECURITY DEFINER)
-- buscaba el juego solo por PIN + status<>'ended' — un alumno con un PIN o
-- deep-link viejo podía unirse a un Kahoot que el docente ya mandó a la
-- papelera. Acá cerramos ese camino server-side: si el poll del juego está
-- soft-deleted, devolvemos el MISMO error genérico que un PIN inválido (no
-- filtramos información de que existió/fue borrado).
--
-- Cuerpo idéntico al de la mig 20260921000100, solo se agrega el guard de
-- deleted_at justo después de localizar el juego por PIN.
-- ──────────────────────────────────────────────────────────────────────

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
  -- Guard de papelera: si la encuesta Kahoot del juego está soft-deleted, se
  -- comporta como PIN inválido (no se puede unir a algo que está en papelera).
  IF EXISTS (SELECT 1 FROM public.polls WHERE id = v_game.poll_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'PIN inválido o el juego ya terminó' USING ERRCODE = 'P0001';
  END IF;
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

NOTIFY pgrst, 'reload schema';
