-- ──────────────────────────────────────────────────────────────────────
-- Broadcast → mensajes en /app/messages
--
-- La edge function `broadcast-course-message` ahora también inserta un
-- mensaje 1-a-1 en la conversación de cada alumno con el docente/admin,
-- para que el broadcast aparezca en el módulo de Mensajes (no solo en el
-- bell de notificaciones).
--
-- Problema: el trigger `tg_notify_new_message` se dispara por cada
-- INSERT en `messages` y crea una notification kind='info' + envía
-- correo via el predicado `_notification_kind_emails` (matches
-- info+/app/messages). Eso duplica el bell (la edge ya inserta la
-- notificación 'broadcast' propia) y envía N correos individuales — lo
-- contrario del BCC único que el broadcast usa por privacidad.
--
-- Fix: el trigger ahora checkea un session GUC `app.skip_message_notif`.
-- Si está en 'true', salta sin crear notificación. La edge llama a una
-- RPC SECURITY DEFINER que setea el GUC dentro de su scope y hace el
-- bulk insert; al terminar la función, el GUC se resetea
-- automáticamente.
-- ──────────────────────────────────────────────────────────────────────

-- 1) Trigger: respetar GUC para saltarse la notificación.
CREATE OR REPLACE FUNCTION public.tg_notify_new_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv RECORD;
  v_recipient UUID;
  v_sender_name TEXT;
  v_body_preview TEXT;
  v_skip TEXT;
BEGIN
  -- Si el caller seteó el GUC en true, salimos sin crear notification.
  -- current_setting con 2do arg true → no falla si la var no existe.
  v_skip := current_setting('app.skip_message_notif', true);
  IF v_skip = 'true' THEN
    RETURN NEW;
  END IF;

  SELECT user_a, user_b INTO v_conv
  FROM public.conversations
  WHERE id = NEW.conversation_id;
  IF v_conv IS NULL THEN
    RETURN NEW;
  END IF;
  v_recipient := CASE
    WHEN v_conv.user_a = NEW.sender_id THEN v_conv.user_b
    ELSE v_conv.user_a
  END;
  v_body_preview := substring(split_part(NEW.body, E'\n', 1) FROM 1 FOR 140);
  SELECT COALESCE(full_name, institutional_email, 'Usuario')
    INTO v_sender_name
  FROM public.profiles
  WHERE id = NEW.sender_id;
  v_sender_name := COALESCE(v_sender_name, 'Usuario');

  INSERT INTO public.notifications (
    user_id, title, body, kind, link, related_user_id, source_role
  )
  VALUES (
    v_recipient,
    'Nuevo mensaje de ' || v_sender_name,
    v_body_preview,
    'info',
    '/app/messages',
    NEW.sender_id,
    NULL
  );
  RETURN NEW;
END;
$$;

-- 2) RPC SECURITY DEFINER para que la edge function inserte mensajes
--    en bulk SALTÁNDOSE el trigger de notificación. Solo Admin /
--    Docente del curso pueden llamarla — pero como la edge ya valida
--    permisos antes de llegar acá, acá nos limitamos a chequear que el
--    sender sea el caller (auth.uid()).
CREATE OR REPLACE FUNCTION public.insert_broadcast_messages(
  _sender_id UUID,
  _conv_ids UUID[],
  _body TEXT
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_inserted INT;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '28000';
  END IF;
  IF v_caller <> _sender_id THEN
    RAISE EXCEPTION 'sender_id debe coincidir con auth.uid()' USING ERRCODE = '42501';
  END IF;
  IF _conv_ids IS NULL OR cardinality(_conv_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF _body IS NULL OR length(_body) = 0 THEN
    RAISE EXCEPTION 'body vacío' USING ERRCODE = '22023';
  END IF;
  IF length(_body) > 4000 THEN
    _body := substring(_body FROM 1 FOR 4000);
  END IF;

  -- Saltarse el trigger de "nueva conversación" notif: la edge ya
  -- maneja sus propias notificaciones de broadcast.
  PERFORM set_config('app.skip_message_notif', 'true', true);

  INSERT INTO public.messages (conversation_id, sender_id, body)
  SELECT conv_id, _sender_id, _body
    FROM unnest(_conv_ids) AS conv_id;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.insert_broadcast_messages(UUID, UUID[], TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
