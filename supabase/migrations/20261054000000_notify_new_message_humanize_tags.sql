-- ══════════════════════════════════════════════════════════════════════
-- tg_notify_new_message: humanizar los tokens de tag [[T:type:id:label]] → #label
-- en el preview de la notificación (y por ende del correo, que lee notification.body).
-- En mensajes DIRECTOS/GRUPO se mostraba el token CRUDO en la campana/toast/correo
-- (broadcast ya humanizaba, pero directos no). El body de messages.body se mantiene
-- CRUDO para que el chip siga renderizando en /app/messages.
--
-- Mismo patrón/regex que broadcast.ts (humanizeTags) y dispatch_scheduled_messages
-- (invariante cross-file — ver CLAUDE.md). Reproduce el cuerpo actual VERBATIM
-- cambiando SOLO el cómputo de v_body_preview.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_notify_new_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_conv RECORD;
  v_recipient UUID;
  v_sender_name TEXT;
  v_body_preview TEXT;
  v_skip TEXT;
  v_group_title TEXT;
BEGIN
  v_skip := current_setting('app.skip_message_notif', true);
  IF v_skip = 'true' THEN
    RETURN NEW;
  END IF;
  -- Humanizar tokens [[T:type:id:label]] → #label ANTES de recortar el preview
  -- (la campana/toast/correo no renderizan chips). El body crudo queda intacto.
  v_body_preview := substring(split_part(
    regexp_replace(
      NEW.body,
      '\[\[T:(?:workshop|exam|project|content|video):[0-9a-f-]+:([^\]]+)\]\]',
      '#\1',
      'g'
    ),
    E'\n', 1) FROM 1 FOR 140);
  SELECT COALESCE(full_name, institutional_email, 'Usuario')
    INTO v_sender_name
  FROM public.profiles
  WHERE id = NEW.sender_id;
  v_sender_name := COALESCE(v_sender_name, 'Usuario');
  IF NEW.conversation_id IS NOT NULL THEN
    -- 1-a-1: notif al "otro".
    SELECT user_a, user_b INTO v_conv
    FROM public.conversations
    WHERE id = NEW.conversation_id;
    IF v_conv IS NULL THEN RETURN NEW; END IF;
    v_recipient := CASE
      WHEN v_conv.user_a = NEW.sender_id THEN v_conv.user_b
      ELSE v_conv.user_a
    END;
    INSERT INTO public.notifications (
      user_id, title, body, kind, link, related_user_id, source_role
    ) VALUES (
      v_recipient,
      'Nuevo mensaje de ' || v_sender_name,
      v_body_preview,
      'info',
      '/app/messages',
      NEW.sender_id,
      NULL
    );
  ELSIF NEW.group_id IS NOT NULL THEN
    -- Grupo: notif a cada miembro != sender. group_chat_member_ids
    -- resuelve tanto chats de curso (dinámico) como ad-hoc (filas
    -- explícitas).
    SELECT title INTO v_group_title FROM public.group_chats WHERE id = NEW.group_id;
    INSERT INTO public.notifications (
      user_id, title, body, kind, link, related_user_id, source_role
    )
    SELECT
      m.user_id,
      CASE
        WHEN v_group_title IS NOT NULL THEN v_sender_name || ' · ' || v_group_title
        ELSE 'Nuevo mensaje de ' || v_sender_name
      END,
      v_body_preview,
      'info',
      '/app/messages?group=' || NEW.group_id::text,
      NEW.sender_id,
      NULL
    FROM public.group_chat_member_ids(NEW.group_id) m
    WHERE m.user_id <> NEW.sender_id;
  END IF;
  RETURN NEW;
END;
$function$;
