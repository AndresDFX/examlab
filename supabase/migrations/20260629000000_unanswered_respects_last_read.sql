-- ──────────────────────────────────────────────────────────────────────
-- count_unanswered_conversations: ahora respeta last_read_at.
--
-- Bug reportado: el boton "Marcar todo" del FAB de mensajes no
-- reduce el contador "X conversaciones pendientes por responder".
--
-- Causa: la version original (mig 20260518200000) solo miraba el LAST
-- sender_id por conversacion + filtraba mensajes por cleared_at. Como
-- `mark_all_conversations_read` actualiza `last_read_at` (no
-- cleared_at), el conteo no se enteraba — el ultimo sender seguia
-- siendo el otro y la conv contaba como pendiente.
--
-- Fix: el predicado ahora exige que el ULTIMO mensaje visible (no
-- borrado para mi) sea ADEMAS posterior a mi `last_read_at`. Asi:
--   - Marcar todo → last_read_at = now() → ningun mensaje es posterior
--     → count = 0. Boton funciona como espera el usuario.
--   - Mensaje nuevo del otro → created_at > last_read_at → vuelve a
--     contar como pendiente.
--   - Yo respondo → mi propio mensaje es el ultimo, sender_id = me →
--     no cuenta (ya pasaba).
--
-- Nueva semantica de "pendiente": "alguien me escribio algo que YO NO
-- HE ACUSADO RECIBO (leyendo o respondiendo)". Mas alineada con la
-- expectativa del usuario.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.count_unanswered_conversations()
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (SELECT auth.uid() AS uid)
  SELECT COUNT(*)::INTEGER FROM (
    SELECT DISTINCT ON (m.conversation_id)
      m.conversation_id,
      m.sender_id,
      m.created_at,
      CASE
        WHEN c.user_a = (SELECT uid FROM me) THEN c.user_a_last_read_at
        WHEN c.user_b = (SELECT uid FROM me) THEN c.user_b_last_read_at
      END AS my_last_read_at
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE (c.user_a = (SELECT uid FROM me) OR c.user_b = (SELECT uid FROM me))
      AND (
        -- Mensaje visible para mi (respeta cleared_at)
        (c.user_a = (SELECT uid FROM me)
          AND (c.user_a_cleared_at IS NULL OR m.created_at > c.user_a_cleared_at))
        OR (c.user_b = (SELECT uid FROM me)
          AND (c.user_b_cleared_at IS NULL OR m.created_at > c.user_b_cleared_at))
      )
    ORDER BY m.conversation_id, m.created_at DESC
  ) latest
  WHERE latest.sender_id <> (SELECT uid FROM me)
    -- NUEVO: el ultimo mensaje del otro debe ser posterior a mi
    -- last_read_at. Si ya marque la conversacion como leida, no cuenta.
    AND (latest.my_last_read_at IS NULL OR latest.created_at > latest.my_last_read_at);
$$;

NOTIFY pgrst, 'reload schema';
