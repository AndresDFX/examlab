-- ──────────────────────────────────────────────────────────────────────
-- Mensajes programados: soporte para `kind='group'` (chat grupal).
--
-- Tras la migración 20260806000000 (group_chats), existen tres modos de
-- mensajería:
--   - direct    → conversación 1-a-1 (tabla conversations)
--   - broadcast → fan-out a todos los alumnos de uno o más cursos
--   - group     → chat grupal (tabla group_chats) — NUEVO en scheduling
--
-- Esta migración añade soporte de programación al modo 'group':
--   1. Amplía el CHECK de scheduled_messages.kind para aceptar 'group'.
--   2. Agrega columna `group_id UUID NULL REFERENCES group_chats(id)`.
--   3. CHECK de target exclusivo: por kind hay UN solo campo target set.
--   4. Reescribe `dispatch_scheduled_messages` para procesar 'group':
--      valida `is_group_chat_member(group_id, creator_id)` y luego
--      INSERT en messages con group_id (el trigger tg_notify_new_message
--      ya maneja la rama group_id → notif a todos los miembros).
--
-- La UI compose para chats grupales NO está lista todavía — esta
-- migración prepara el backend para que cuando se agregue compose, la
-- programación funcione sin cambios adicionales en SQL.
-- ──────────────────────────────────────────────────────────────────────

-- 1) Ampliar CHECK kind. Buscamos el CHECK auto-nombrado y lo recreamos.
DO $$
DECLARE
  v_constraint TEXT;
BEGIN
  SELECT conname INTO v_constraint
  FROM pg_constraint
  WHERE conrelid = 'public.scheduled_messages'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%kind%direct%broadcast%';
  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.scheduled_messages DROP CONSTRAINT %I', v_constraint);
  END IF;
END
$$;

ALTER TABLE public.scheduled_messages
  ADD CONSTRAINT scheduled_messages_kind_check
  CHECK (kind IN ('direct', 'broadcast', 'group'));

-- 2) Columna group_id.
ALTER TABLE public.scheduled_messages
  ADD COLUMN IF NOT EXISTS group_id UUID NULL
  REFERENCES public.group_chats(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS scheduled_messages_group_id_idx
  ON public.scheduled_messages (group_id)
  WHERE group_id IS NOT NULL;

-- 3) CHECK de target exclusivo: exactamente UN campo de destino debe
-- estar set según el kind. Sin esto un cliente podría enviar
-- {kind:'direct', recipient_id, course_ids:[...]} y el dispatch
-- escogería arbitrariamente. NOT VALID para no rechazar filas viejas
-- que no satisfagan (en producción todas las filas viejas son direct
-- o broadcast con sus targets correspondientes — pero por defensa
-- agregamos NOT VALID y validamos en background si se desea).
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scheduled_messages_kind_target'
      AND conrelid = 'public.scheduled_messages'::regclass
  ) THEN
    ALTER TABLE public.scheduled_messages
      ADD CONSTRAINT scheduled_messages_kind_target
      CHECK (
        (kind = 'direct'
          AND recipient_id IS NOT NULL
          AND course_ids IS NULL
          AND group_id IS NULL)
        OR (kind = 'broadcast'
          AND course_ids IS NOT NULL
          AND recipient_id IS NULL
          AND group_id IS NULL)
        OR (kind = 'group'
          AND group_id IS NOT NULL
          AND recipient_id IS NULL
          AND course_ids IS NULL)
      ) NOT VALID;
  END IF;
END
$check$;

-- 4) Reescribir dispatch_scheduled_messages con rama 'group'.
-- El cuerpo de direct y broadcast queda IDÉNTICO al de mig
-- 20260709000000 — esta migración solo añade el ELSIF.
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
  FOR r IN
    SELECT * FROM public.scheduled_messages
    WHERE status = 'pending' AND send_at <= now()
    ORDER BY send_at ASC
    LIMIT 200
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      -- Reset defensivo del GUC por iteración. Solo broadcast lo
      -- activa para saltar el trigger; direct y group quieren que
      -- las notifs salgan (el destinatario debe enterarse).
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
        -- Validar membresía actual: si el docente perdió acceso al
        -- chat entre el agendamiento y el envío (raro pero posible
        -- si el chat fue eliminado), no enviamos.
        IF r.group_id IS NULL OR NOT public.is_group_chat_member(r.group_id, r.creator_id) THEN
          RAISE EXCEPTION 'No autorizado o chat de grupo inexistente';
        END IF;
        -- INSERT en messages con group_id (NO conversation_id). El
        -- trigger tg_notify_new_message detecta la rama group_id y
        -- notifica a todos los miembros menos el sender. Idéntico al
        -- flujo sync del compose group (cuando exista UI).
        INSERT INTO public.messages (group_id, sender_id, body)
          VALUES (r.group_id, r.creator_id, left(r.body, 4000));

      ELSIF r.kind = 'broadcast' THEN
        IF r.course_ids IS NULL OR cardinality(r.course_ids) = 0 THEN
          RAISE EXCEPTION 'broadcast sin cursos';
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

        -- 1) Notificación por alumno único.
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

        -- 2) Replica como mensaje 1-a-1 (skip trigger de notif via GUC).
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
      UPDATE public.scheduled_messages
        SET status = 'failed', error = left(SQLERRM, 500)
        WHERE id = r.id;
    END;
  END LOOP;
  RETURN v_count;
END;
$$;

-- Mantener el REVOKE de la migración previa (20260807200000): el
-- dispatcher NO debe ser callable por anon/PUBLIC. Re-aplicamos por
-- idempotencia — Postgres descarta DUPLICATE PRIVILEGE silenciosamente.
REVOKE EXECUTE ON FUNCTION public.dispatch_scheduled_messages() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.dispatch_scheduled_messages() FROM anon;
REVOKE EXECUTE ON FUNCTION public.dispatch_scheduled_messages() FROM authenticated;

NOTIFY pgrst, 'reload schema';
