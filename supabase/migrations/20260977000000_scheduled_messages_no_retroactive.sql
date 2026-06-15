-- ══════════════════════════════════════════════════════════════════════
-- Anti-tormenta de correos "de notificaciones que ya pasaron" (tenant Camacho).
--
-- Causa raíz confirmada (workflow de diagnóstico): `dispatch_scheduled_messages`
-- selecciona `WHERE status='pending' AND send_at <= now()` SIN tope inferior de
-- antigüedad. Un mensaje programado que quedó pendiente (outage de pg_cron,
-- reactivación, o un send_at en el pasado) se dispara RETROACTIVAMENTE; como
-- los broadcast emailan (kind 'broadcast' pasa `_notification_kind_emails`),
-- un solo aviso vencido manda un correo a CADA estudiante matriculado de los
-- cursos → tormenta de correos de un anuncio ya pasado.
--
-- Fix:
--   1. Cancelar de entrada los pendientes MUY vencidos (>24h) — no se disparan.
--   2. La selección del batch sólo considera lo vencido en las últimas 24h
--      (defensa en profundidad: si entra un pending con send_at viejo, no se
--      envía retroactivamente).
--   3. Limpieza inmediata (one-shot) de los pendientes vencidos acumulados.
--
-- El resto del cuerpo se reproduce IDÉNTICO a la mig 20260709000000 (la lógica
-- de direct/broadcast + el GUC app.skip_message_notif no cambia).
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
  -- (1) Cancelar pendientes MUY vencidos: disparar un broadcast/direct cuyo
  -- send_at pasó hace >24h es spam retroactivo (el aviso "ya pasó"). Se marcan
  -- cancelled con motivo, no se envían.
  UPDATE public.scheduled_messages
     SET status = 'cancelled',
         error = 'Cancelado: pendiente vencido >24h (evita correo retroactivo)'
   WHERE status = 'pending'
     AND send_at < now() - INTERVAL '24 hours';

  FOR r IN
    SELECT * FROM public.scheduled_messages
    -- (2) Sólo lo vencido en las últimas 24h: nunca dispara retroactivamente.
    WHERE status = 'pending'
      AND send_at <= now()
      AND send_at > now() - INTERVAL '24 hours'
    ORDER BY send_at ASC
    LIMIT 200
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      -- Reset defensivo: las filas direct NO deben saltarse el trigger
      -- de notif (el destinatario debe enterarse). Solo broadcast lo
      -- activa alrededor de sus inserts de mensaje.
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

        -- Body humanizado (#label) para notif/correo; body con 📢 + tokens
        -- crudos para el mensaje replicado (chips en /app/messages).
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

-- (3) Limpieza inmediata: cancelar los pendientes vencidos acumulados (one-shot)
-- para que el próximo tick del cron no los dispare. Idempotente.
DO $cleanup$
BEGIN
  IF to_regclass('public.scheduled_messages') IS NOT NULL THEN
    UPDATE public.scheduled_messages
       SET status = 'cancelled',
           error = 'Cancelado: pendiente vencido >24h (evita correo retroactivo)'
     WHERE status = 'pending'
       AND send_at < now() - INTERVAL '24 hours';
  END IF;
END
$cleanup$;

NOTIFY pgrst, 'reload schema';
