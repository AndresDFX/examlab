-- ──────────────────────────────────────────────────────────────────────
-- Messaging: marcar conversación como NO leída.
--
-- Espejo de `mark_conversation_read` (mig 20260518100000): en lugar de
-- setear MI `last_read_at` a `now()`, lo pone en NULL. Como `unreadCount`
-- ya trata `null` como "leí 0 mensajes" (todos los ajenos cuentan), el
-- badge se rellena con la cuenta de mensajes ajenos del set reciente.
--
-- Usado por la UI de Mensajes para que el usuario pueda "olvidar" la
-- lectura — útil para volver más tarde a responder un chat que ya abrió
-- y no quiere perder de vista.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mark_conversation_unread(_conv_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me UUID := auth.uid();
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '28000';
  END IF;
  UPDATE public.conversations
  SET
    user_a_last_read_at = CASE WHEN user_a = v_me THEN NULL ELSE user_a_last_read_at END,
    user_b_last_read_at = CASE WHEN user_b = v_me THEN NULL ELSE user_b_last_read_at END
  WHERE id = _conv_id
    AND (user_a = v_me OR user_b = v_me);
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_conversation_unread(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
