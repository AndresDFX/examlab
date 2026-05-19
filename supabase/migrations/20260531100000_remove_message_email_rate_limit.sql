-- ──────────────────────────────────────────────────────────────────────
-- Quita el rate-limit de 10 min por conversación en correos de mensajería.
--
-- Razón: el rate-limit que introdujo 20260523000003 saltaba el correo
-- cuando ya había enviado uno reciente para la misma conversación y el
-- destinatario aún no lo leía. En la práctica los docentes/admins
-- usaron el módulo poco frecuentemente y la regla terminaba ocultando
-- avisos legítimos (el alumno NO veía el segundo correo aunque pasaran
-- horas, mientras la primera notificación siguiera sin leer).
--
-- Política nueva: cada mensaje 1-a-1 genera un correo. Si el volumen
-- crece y aparece spam real, el alumno puede silenciar la conversación
-- desde el toggle por-categoría del admin (settings.enabled_kinds.messages)
-- o desde sus preferencias personales — ambos mecanismos existen.
--
-- Esta migración solo reemplaza la función. Si el índice
-- `idx_notifications_rate_limit` no sirve para nada, lo dejamos en la
-- DB; cuesta espacio mínimo (parcial sobre `read=false` + email
-- entregado) y permite re-introducir el rate-limit con un SET-no-op
-- si la decisión se revierte.
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
BEGIN
  SELECT value INTO v_url FROM private.app_settings WHERE key = 'send_email_url';
  SELECT value INTO v_key FROM private.app_settings WHERE key = 'service_role_key';

  -- Filtro 1: kind no envía emails (broadcast, system genéricos, etc.).
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

  -- (Rate-limit por conversación removido en migración 20260531100000.)
  -- Antes acá había una rama que comprobaba si el MISMO user_id tenía
  -- otro correo de mensajería en los últimos 10 min sin leer; si sí,
  -- saltaba el envío. La quitamos porque ocultaba avisos legítimos.

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

NOTIFY pgrst, 'reload schema';
