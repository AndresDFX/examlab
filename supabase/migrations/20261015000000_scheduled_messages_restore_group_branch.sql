-- ══════════════════════════════════════════════════════════════════════
-- M1 — Restaurar la rama kind='group' en dispatch_scheduled_messages.
--
-- La rama group se agregó en 20260808000000, pero dos CREATE OR REPLACE
-- posteriores (20260977000000 anti-retroactivo, 20260982000000 papelera) la
-- omitieron al recrear la función → drift: un mensaje PROGRAMADO de tipo 'group'
-- ya no se despacha (queda pending hasta vencer >24h y se cancela, o falla).
--
-- Este CREATE OR REPLACE = cuerpo ACTUAL (20260982000000, con anti-retroactivo +
-- papelera) + la rama group reinsertada VERBATIM (de 20260808000000) entre las
-- ramas 'direct' y 'broadcast'. El resto es idéntico a 20260982000000.
-- Dependencias verificadas en prod: is_group_chat_member() y messages.group_id
-- existen. El trigger tg_notify_new_message detecta la rama group_id y notifica
-- a los miembros (skip_message_notif queda en 'false' — reset al inicio del loop
-- — así que SÍ notifica, que es lo correcto para group).
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.dispatch_scheduled_messages()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_count INT := 0;
  v_conv_id UUID;
  v_msg_body TEXT;
  v_notif_body TEXT;
  v_student UUID;
  v_user_a UUID;
  v_user_b UUID;
BEGIN
  -- (1) Cancelar pendientes MUY vencidos (>24h): evita correo retroactivo.
  UPDATE public.scheduled_messages
     SET status = 'cancelled',
         error = 'Cancelado: pendiente vencido >24h (evita correo retroactivo)'
   WHERE status = 'pending'
     AND send_at < now() - INTERVAL '24 hours';

  FOR r IN
    SELECT * FROM public.scheduled_messages
    WHERE status = 'pending'
      AND send_at <= now()
      AND send_at > now() - INTERVAL '24 hours'
    ORDER BY send_at ASC
    LIMIT 200
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      -- Reset defensivo: direct/group NO deben saltarse el trigger de notif.
      PERFORM set_config('app.skip_message_notif', 'false', true);

      IF r.kind = 'direct' THEN
        IF r.recipient_id IS NULL OR NOT public.can_message(r.creator_id, r.recipient_id) THEN
          RAISE EXCEPTION 'No autorizado a mensajear al destinatario';
        END IF;
        v_user_a := LEAST(r.creator_id, r.recipient_id);
        v_user_b := GREATEST(r.creator_id, r.recipient_id);
        INSERT INTO public.conversations (user_a, user_b)
          VALUES (v_user_a, v_user_b)
          ON CONFLICT (user_a, user_b) DO NOTHING;
        SELECT id INTO v_conv_id FROM public.conversations
          WHERE user_a = v_user_a AND user_b = v_user_b;
        INSERT INTO public.messages (conversation_id, sender_id, body)
          VALUES (v_conv_id, r.creator_id, left(r.body, 4000));

      ELSIF r.kind = 'group' THEN
        -- Validar membresía actual: si el docente perdió acceso al chat entre
        -- el agendamiento y el envío (raro), no enviamos.
        IF r.group_id IS NULL OR NOT public.is_group_chat_member(r.group_id, r.creator_id) THEN
          RAISE EXCEPTION 'No autorizado o chat de grupo inexistente';
        END IF;
        -- INSERT en messages con group_id (NO conversation_id). El trigger
        -- tg_notify_new_message detecta la rama group_id y notifica a todos los
        -- miembros menos el sender.
        INSERT INTO public.messages (group_id, sender_id, body)
          VALUES (r.group_id, r.creator_id, left(r.body, 4000));

      ELSIF r.kind = 'broadcast' THEN
        IF r.course_ids IS NULL OR cardinality(r.course_ids) = 0 THEN
          RAISE EXCEPTION 'broadcast sin cursos';
        END IF;
        -- Papelera: si ALGÚN curso del broadcast está soft-deleted, abortar la fila.
        IF EXISTS (
          SELECT 1 FROM unnest(r.course_ids) AS cid
          WHERE NOT EXISTS (
            SELECT 1 FROM public.courses c
            WHERE c.id = cid AND c.deleted_at IS NULL
          )
        ) THEN
          RAISE EXCEPTION 'broadcast: uno o más cursos no existen o están en la papelera';
        END IF;
        -- Authz: Admin O dicta todos los cursos.
        IF NOT public.has_role(r.creator_id, 'Admin'::public.app_role) THEN
          IF EXISTS (
            SELECT 1 FROM unnest(r.course_ids) AS cid
            WHERE NOT EXISTS (
              SELECT 1 FROM public.course_teachers ct
              WHERE ct.course_id = cid AND ct.user_id = r.creator_id
            )
          ) THEN
            RAISE EXCEPTION 'No autorizado en uno o más cursos';
          END IF;
        END IF;

        v_notif_body := regexp_replace(
          r.body,
          '\[\[T:(?:workshop|exam|project|content|video):[0-9a-f-]+:([^\]]+)\]\]',
          '#\1',
          'g'
        );
        v_msg_body := left('📢 ' || COALESCE(r.subject, '') || E'\n\n' || r.body, 4000);

        -- 1) Notificación por alumno único (dispara correo via trigger).
        INSERT INTO public.notifications (user_id, title, body, kind, link, related_user_id)
          SELECT DISTINCT e.user_id,
                 '📢 ' || COALESCE(r.subject, ''),
                 v_notif_body,
                 'broadcast',
                 '/app/messages',
                 r.creator_id
          FROM public.course_enrollments e
          WHERE e.course_id = ANY (r.course_ids)
            AND e.user_id <> r.creator_id;

        -- 2) Replica como mensaje 1-a-1 (skip del trigger de notif via GUC).
        PERFORM set_config('app.skip_message_notif', 'true', true);
        FOR v_student IN
          SELECT DISTINCT e.user_id
          FROM public.course_enrollments e
          WHERE e.course_id = ANY (r.course_ids)
            AND e.user_id <> r.creator_id
        LOOP
          v_user_a := LEAST(r.creator_id, v_student);
          v_user_b := GREATEST(r.creator_id, v_student);
          INSERT INTO public.conversations (user_a, user_b)
            VALUES (v_user_a, v_user_b)
            ON CONFLICT (user_a, user_b) DO NOTHING;
          SELECT id INTO v_conv_id FROM public.conversations
            WHERE user_a = v_user_a AND user_b = v_user_b;
          INSERT INTO public.messages (conversation_id, sender_id, body)
            VALUES (v_conv_id, r.creator_id, v_msg_body);
        END LOOP;
        PERFORM set_config('app.skip_message_notif', 'false', true);
      END IF;

      UPDATE public.scheduled_messages
        SET status = 'sent', sent_at = now(), error = NULL
        WHERE id = r.id;
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      -- Una fila mala no tumba el batch: la marcamos failed con el motivo.
      UPDATE public.scheduled_messages
        SET status = 'failed', error = left(SQLERRM, 500)
        WHERE id = r.id;
    END;
  END LOOP;
  RETURN v_count;
END;
$$;

NOTIFY pgrst, 'reload schema';
