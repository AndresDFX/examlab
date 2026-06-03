-- ──────────────────────────────────────────────────────────────────────
-- polls: trigger AFTER INSERT que asegura el course_id ancla en
-- poll_courses (junction).
--
-- Contexto: en la migración 20260603010000_polls_multicourse introdujimos
-- la tabla puente `poll_courses`. La RLS de polls / poll_options /
-- poll_responses ahora consulta la junction. El backfill cubrió todas
-- las filas existentes, pero los INSERTERS futuros (UI y módulos que aún
-- no migran) seguían insertando solo en `polls` sin tocar la junction
-- → la nueva poll era invisible para todo el mundo (RLS no encuentra
-- ningún course linkeado).
--
-- Casos cubiertos:
--   - LaunchPollDialog (encuesta en vivo desde sesión) → no se actualizó
--     aún para escribir junction; el trigger lo cubre.
--   - CreatePollDialog ya inserta el set completo de cursos en junction
--     después del INSERT del poll. El trigger inserta el ancla con
--     ON CONFLICT DO NOTHING para no chocar con esa segunda inserción.
--   - Cualquier futuro path que inserte en polls.
--
-- Diseño:
--   AFTER INSERT en polls → INSERT del ancla en poll_courses con
--   ON CONFLICT DO NOTHING. Idempotente.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._tg_poll_ensure_anchor_in_junction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.poll_courses (poll_id, course_id)
       VALUES (NEW.id, NEW.course_id)
  ON CONFLICT (poll_id, course_id) DO NOTHING;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_poll_ensure_anchor_in_junction ON public.polls;
CREATE TRIGGER trg_poll_ensure_anchor_in_junction
  AFTER INSERT ON public.polls
  FOR EACH ROW EXECUTE FUNCTION public._tg_poll_ensure_anchor_in_junction();

NOTIFY pgrst, 'reload schema';
