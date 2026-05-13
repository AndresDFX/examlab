-- ──────────────────────────────────────────────────────────────────────
-- count_unanswered_conversations: cuántas conversaciones del usuario
-- actual tienen un ÚLTIMO mensaje (visible para mí) enviado por el
-- otro. Útil para el card "Mensajes pendientes sin responder" del
-- dashboard del docente.
--
-- "Visible para mí" respeta el borrado asimétrico — solo cuentan los
-- mensajes posteriores a MI `cleared_at`. Si la otra parte respondió
-- después de que limpié, esa nueva interacción cuenta como pendiente.
-- Si la conversación no tiene mensajes visibles, NO entra al conteo.
--
-- SECURITY DEFINER porque consulta tablas con RLS distinto. El filtro
-- por `auth.uid()` está incluido en la query — la función NO devuelve
-- conteos de otros usuarios.
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
      m.sender_id
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE (c.user_a = (SELECT uid FROM me) OR c.user_b = (SELECT uid FROM me))
      AND (
        (c.user_a = (SELECT uid FROM me)
          AND (c.user_a_cleared_at IS NULL OR m.created_at > c.user_a_cleared_at))
        OR (c.user_b = (SELECT uid FROM me)
          AND (c.user_b_cleared_at IS NULL OR m.created_at > c.user_b_cleared_at))
      )
    ORDER BY m.conversation_id, m.created_at DESC
  ) latest
  WHERE latest.sender_id <> (SELECT uid FROM me);
$$;

NOTIFY pgrst, 'reload schema';
