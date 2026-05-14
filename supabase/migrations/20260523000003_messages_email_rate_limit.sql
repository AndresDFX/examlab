-- ──────────────────────────────────────────────────────────────────────
-- Rate-limit por conversación para correos de mensajería.
--
-- Problema: el trigger `tg_notify_new_message` inserta una notification
-- por cada mensaje. Si Usuario A escribe 10 mensajes en 5 minutos,
-- Usuario B recibe 10 correos casi idénticos — spam clásico.
--
-- Solución: cuando llegue una notificación de kind='info' con link de
-- conversación, si YA mandamos correo para la MISMA conversación (mismo
-- `link`) al MISMO destinatario en los últimos 10 minutos Y el
-- destinatario AÚN no leyó esa notificación previa, suprimimos el
-- correo de la nueva. Se sigue creando la notif (in-app bell + toast
-- funcionan), solo se marca con email_skipped_reason='rate_limited'.
--
-- Cuándo SÍ se envía correo (no rate-limit):
--   - Primera notif de la conv en una racha (siempre)
--   - El usuario ya leyó la previa → racha "consumida", próximo
--     mensaje vuelve a notificar por correo
--   - Pasaron >10 min sin emails → ventana expiró
--
-- Por qué 10 min: para mensajería 1-a-1, una ráfaga típica son varios
-- mensajes en 1-3 minutos. 10 min cubre la racha + buffer sin retrasar
-- demasiado los avisos cuando la persona vuelve después de un rato.
-- Si la métrica de "correos enviados por conv" sugiere otra cosa, se
-- ajusta en una migración futura. No se hace configurable todavía —
-- premature parametrization.
--
-- Solo aplica a kind='info' con link /app/messages%. Para grade, exam,
-- feedback y otros kinds críticos NO hacemos rate-limit — cada uno es
-- un evento educativo distinto que merece su propio correo.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notify_send_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  v_url        text;
  v_key        text;
  v_net_exists boolean;
  v_recent_email_exists boolean;
BEGIN
  SELECT value INTO v_url FROM private.app_settings WHERE key = 'send_email_url';
  SELECT value INTO v_key FROM private.app_settings WHERE key = 'service_role_key';

  -- Rama 1a: kind no crítico → skip silencioso.
  IF NOT public._notification_kind_emails(NEW.kind, NEW.link) THEN
    UPDATE public.notifications
       SET email_skipped_reason = 'kind_not_critical'
     WHERE id = NEW.id;

    PERFORM public.audit_email_event(
      NEW.id,
      'email.skipped',
      'info',
      jsonb_build_object('reason', 'kind_not_critical', 'stage', 'trigger')
    );
    RETURN NEW;
  END IF;

  -- Rama 1b: rate-limit por conversación para mensajes. Solo aplica al
  -- caso `kind='info' AND link LIKE '/app/messages%'`. Buscamos otra
  -- notif al MISMO user con el MISMO link, ya entregada por correo en
  -- los últimos 10 min, y aún no leída. Si existe, suprimimos este
  -- correo (la notif in-app igual entra al bell).
  IF NEW.kind = 'info' AND NEW.link LIKE '/app/messages%' THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.notifications prev
       WHERE prev.user_id = NEW.user_id
         AND prev.link = NEW.link
         AND prev.id <> NEW.id
         AND prev.email_delivered_at IS NOT NULL
         AND prev.email_delivered_at >= NOW() - INTERVAL '10 minutes'
         AND prev.read = false
    ) INTO v_recent_email_exists;

    IF v_recent_email_exists THEN
      UPDATE public.notifications
         SET email_skipped_reason = 'rate_limited_recent_email'
       WHERE id = NEW.id;

      PERFORM public.audit_email_event(
        NEW.id,
        'email.skipped',
        'info',
        jsonb_build_object(
          'reason', 'rate_limited_recent_email',
          'stage',  'trigger',
          'window_minutes', 10
        )
      );
      RETURN NEW;
    END IF;
  END IF;

  -- Rama 2: settings ausentes → warning.
  IF v_url IS NULL OR v_url = '' THEN
    UPDATE public.notifications
       SET email_skipped_reason = 'no_settings'
     WHERE id = NEW.id;

    PERFORM public.audit_email_event(
      NEW.id,
      'email.skipped',
      'warning',
      jsonb_build_object('reason', 'no_settings', 'stage', 'trigger')
    );
    RETURN NEW;
  END IF;

  -- Rama 3: pg_net no instalada → warning.
  SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') INTO v_net_exists;
  IF NOT v_net_exists THEN
    UPDATE public.notifications
       SET email_skipped_reason = 'pg_net_missing'
     WHERE id = NEW.id;

    PERFORM public.audit_email_event(
      NEW.id,
      'email.skipped',
      'warning',
      jsonb_build_object('reason', 'pg_net_missing', 'stage', 'trigger')
    );
    RETURN NEW;
  END IF;

  -- Rama 4: pg_net call.
  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || COALESCE(v_key, '')
      ),
      body                 := jsonb_build_object('notification_id', NEW.id),
      timeout_milliseconds := 10000
    );

    PERFORM public.audit_email_event(
      NEW.id,
      'email.dispatched',
      'info',
      jsonb_build_object('stage', 'trigger')
    );
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.notifications
       SET email_skipped_reason = 'pg_net_call_failed: ' || SQLERRM
     WHERE id = NEW.id;

    PERFORM public.audit_email_event(
      NEW.id,
      'email.failed',
      'error',
      jsonb_build_object(
        'reason',  'pg_net_call_failed',
        'stage',   'trigger',
        'error',   SQLERRM
      )
    );
  END;

  RETURN NEW;
END;
$$;

-- Índice de soporte para el rate-limit. La query filtra por
-- (user_id, link) con email_delivered_at desc + read=false. El índice
-- existente `idx_notifications_unread` cubre (user_id, read) pero no
-- incluye link ni email_delivered_at. Este índice parcial es pequeño
-- (solo filas con email entregado y no leídas) y acelera la
-- comprobación a O(log n).
CREATE INDEX IF NOT EXISTS idx_notifications_rate_limit
  ON public.notifications (user_id, link, email_delivered_at DESC)
  WHERE email_delivered_at IS NOT NULL AND read = false;

NOTIFY pgrst, 'reload schema';
