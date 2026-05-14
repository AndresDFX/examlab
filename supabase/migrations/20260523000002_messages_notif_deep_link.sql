-- ──────────────────────────────────────────────────────────────────────
-- Deep-link en notificaciones de mensajes para que el CTA del correo
-- abra la conversación específica.
--
-- Antes: tg_notify_new_message generaba `link = '/app/messages'`. El
-- email se mandaba (porque _notification_kind_emails ya acepta info +
-- prefijo /app/messages) pero el botón "Ver en ExamLab" llevaba a la
-- bandeja genérica y el destinatario tenía que buscar la conversación
-- a mano.
--
-- Ahora: `link = '/app/messages?conv=' || conversation_id`. El
-- predicado de email NO cambia — sigue siendo LIKE '/app/messages%',
-- que matchea con o sin querystring. La página de mensajes
-- (app.messages.tsx) leerá ?conv= y auto-seleccionará la conversación.
--
-- Nota: la columna `notifications.link` es TEXT y no tiene constraint
-- de formato, así que el cambio es retro-compatible. Las notificaciones
-- viejas con link='/app/messages' siguen funcionando — abren la
-- bandeja y el usuario navega normal.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_notify_new_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_recipient    uuid;
  v_sender_name  text;
  v_body_preview text;
BEGIN
  -- Determinar el destinatario (el "otro" usuario de la conversación).
  SELECT CASE
           WHEN c.user_a = NEW.sender_id THEN c.user_b
           ELSE c.user_a
         END
    INTO v_recipient
    FROM public.conversations c
   WHERE c.id = NEW.conversation_id;

  IF v_recipient IS NULL THEN
    -- Defensa: si la conversación se borró entre el INSERT y el trigger,
    -- no podemos notificar. Salimos limpio.
    RETURN NEW;
  END IF;

  -- Nombre legible del remitente (cae a 'Usuario' si no hay perfil).
  SELECT full_name
    INTO v_sender_name
    FROM public.profiles
   WHERE id = NEW.sender_id;
  v_sender_name := COALESCE(v_sender_name, 'Usuario');

  -- Preview del cuerpo — truncamos para que en el bell y en el correo
  -- se vea contenido pero no se desborde. El mensaje completo se ve
  -- al abrir la conversación desde el CTA.
  v_body_preview := COALESCE(LEFT(NEW.body, 200), '(mensaje sin texto)');

  INSERT INTO public.notifications (
    user_id, title, body, kind, link, related_user_id, source_role
  )
  VALUES (
    v_recipient,
    'Nuevo mensaje de ' || v_sender_name,
    v_body_preview,
    'info',
    -- Deep-link a la conversación: incluye el conversation_id como
    -- querystring para que app.messages.tsx auto-seleccione la conv
    -- al cargar. Sigue empezando por /app/messages → cae en el filtro
    -- de _notification_kind_emails y dispara correo.
    '/app/messages?conv=' || NEW.conversation_id::text,
    NEW.sender_id,
    NULL
  );
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
