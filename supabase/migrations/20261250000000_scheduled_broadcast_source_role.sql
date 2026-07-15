-- ══════════════════════════════════════════════════════════════════════
-- #9 [baja]: la difusión PROGRAMADA (dispatch_scheduled_messages, rama broadcast)
-- insertaba la notificación SIN source_role (queda NULL), mientras la difusión
-- INMEDIATA (edge broadcast-course-message) sí lo setea (Admin/Docente/null). El
-- filtro de la campana (use-notifications: source_role.is.null,source_role.neq.<rol
-- activo>) OCULTA una notif con source_role='Docente' para un viewer multi-rol
-- viendo como Docente, pero MUESTRA la misma con source_role=NULL → el mismo
-- anuncio aparece o no según se haya enviado ya o programado. La invariante del
-- proyecto exige que inmediata y programada sean idénticas.
--
-- Fix: CREATE OR REPLACE de dispatch_scheduled_messages IDÉNTICO a 20261015000000
-- salvo que el INSERT de notificaciones de la rama broadcast agrega la columna
-- source_role calculada del creador, igual que el edge.
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
        --    source_role se calcula del CREADOR igual que el edge inmediato, para
        --    que el filtro de la campana (oculta anuncios del propio rol activo)
        --    se comporte idéntico en ambas vías (inmediata y programada).
        INSERT INTO public.notifications (user_id, title, body, kind, link, related_user_id, source_role)
          SELECT DISTINCT e.user_id,
                 '📢 ' || COALESCE(r.subject, ''),
                 v_notif_body,
                 'broadcast',
                 '/app/messages',
                 r.creator_id,
                 CASE
                   WHEN public.has_role(r.creator_id, 'Admin'::public.app_role) THEN 'Admin'
                   WHEN public.has_role(r.creator_id, 'Docente'::public.app_role) THEN 'Docente'
                   ELSE NULL
                 END
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
