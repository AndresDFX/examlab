-- ──────────────────────────────────────────────────────────────────────
-- RPC: marcar TODAS las conversaciones del usuario actual como leídas.
--
-- Caso de uso: el FAB de mensajes/notificaciones tiene un botón
-- "Marcar todo como leído" que debe limpiar el badge global de una vez.
-- Ese badge agrega notifications no leídas + mensajes no leídos en
-- conversaciones. El primero ya se cubre con notifications.read=true
-- (un único UPDATE). Para el segundo necesitamos actualizar el campo
-- `last_read_at` de la mitad-A o mitad-B de cada conversación donde
-- soy miembro — esta RPC encapsula esa lógica.
--
-- Retorna el número de conversaciones actualizadas (informativo, no
-- es crítico para el flujo del cliente).
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mark_all_conversations_read()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_count integer := 0;
  v_now   timestamptz := NOW();
  v_a_cnt integer;
  v_b_cnt integer;
BEGIN
  IF v_uid IS NULL THEN
    RETURN 0;
  END IF;

  -- Actualiza el lado A: las conversaciones donde soy user_a y tengo
  -- last_read_at más viejo que NOW (siempre cierto). UPDATE incondicional
  -- — más simple que filtrar por mensajes nuevos pendientes, y mover
  -- el timestamp un segundo más adelante en convs ya al día no rompe
  -- nada (sigue siendo "leído hasta ahora").
  UPDATE public.conversations
     SET user_a_last_read_at = v_now
   WHERE user_a = v_uid;
  GET DIAGNOSTICS v_a_cnt = ROW_COUNT;

  UPDATE public.conversations
     SET user_b_last_read_at = v_now
   WHERE user_b = v_uid;
  GET DIAGNOSTICS v_b_cnt = ROW_COUNT;

  v_count := v_a_cnt + v_b_cnt;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_all_conversations_read() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_all_conversations_read() TO authenticated;

NOTIFY pgrst, 'reload schema';
