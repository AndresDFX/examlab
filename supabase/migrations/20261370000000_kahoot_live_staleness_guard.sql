-- ════════════════════════════════════════════════════════════════════════
-- Fix: el banner "¡Reto en vivo!" seguía apareciéndole a los estudiantes
-- (matriculados que no entraron) DESPUÉS de que el reto ya terminó.
--
-- Causa: kahoot_my_live_games devolvía CUALQUIER juego con status <> 'ended'.
-- Un reto que el docente dejó en 'lobby' (o cualquier estado) y nunca cerró
-- explícitamente quedaba "vivo" para siempre → el banner no desaparecía.
--
-- Fix: solo se consideran VIVOS los juegos con actividad reciente del HOST.
-- El host mantiene un heartbeat (host_last_seen_at, kahoot_host_heartbeat, mig
-- 20260931/20260935 — el código ya usa una ventana de 25s para "host_present").
-- Si el docente cerró la pestaña, host_last_seen_at deja de actualizarse y el
-- juego se considera abandonado a los ~3 minutos → el banner desaparece.
-- (La matrícula ya estaba bien acotada por _poll_has_member.)
-- ════════════════════════════════════════════════════════════════════════

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
     -- Solo juegos con actividad reciente del host (no lobbies abandonados).
     AND COALESCE(g.host_last_seen_at, g.updated_at, g.created_at) > now() - interval '3 minutes'
     AND public._poll_has_member(g.poll_id, auth.uid())
   ORDER BY g.created_at DESC;
$fn$;

REVOKE ALL ON FUNCTION public.kahoot_my_live_games() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kahoot_my_live_games() TO authenticated;

NOTIFY pgrst, 'reload schema';
