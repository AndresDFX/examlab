-- audit_logs: dejar de registrar el skip de correo ESPERADO.
--
-- WHY: `notify_send_email` audita un evento `email.skipped` por CADA notificación
-- cuyo kind no manda correo. Como esas notificaciones se crean POR DESTINATARIO
-- (publicar una encuesta a un curso = una notificación por alumno), un solo
-- evento de producto generaba decenas de filas. Medido en prod (2026-07-21 →
-- 07-28): 234 de 470 filas de `audit_logs` = **50% del volumen total** eran
-- `email.skipped/kind_not_critical`, y 228 de esas 234 eran `kind='poll'`.
--
-- Es ruido no accionable: que un `poll` no mande correo es el comportamiento
-- diseñado (ver `_notification_kind_emails`), no una falla que alguien deba
-- revisar. Y al ser la mitad del volumen, ENMASCARA los eventos reales en el
-- panel de Auditoría y en las consultas de diagnóstico — el mismo problema que
-- ya se atacó del lado del cliente con `isBrowserNoise` en GlobalErrorLogger
-- (los errores del service worker eran ~50% del volumen sin valor).
--
-- QUÉ SE CONSERVA (nada de diagnóstico se pierde):
--   • `notifications.email_skipped_reason = 'kind_not_critical'` se sigue
--     escribiendo en la fila, así que "¿por qué esta notificación no mandó
--     correo?" se responde igual, consultando la notificación.
--   • Los skips que SÍ requieren acción humana siguen auditados con su
--     severidad: `no_settings` y `pg_net_missing` (warning) — indican
--     configuración faltante — y `email.dispatched` / `email.failed`.
--
-- Resto de la función: IDÉNTICO a la definición vigente (20260531100000).
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

  -- Filtro 1: kind no envía emails (broadcast, system genéricos, poll, etc.).
  -- Se marca la razón en la notificación pero NO se audita: es el caso esperado
  -- y de alto volumen (ver el comentario de cabecera).
  IF NOT public._notification_kind_emails(NEW.kind, NEW.link) THEN
    UPDATE public.notifications
       SET email_skipped_reason = 'kind_not_critical'
     WHERE id = NEW.id;

    RETURN NEW;
  END IF;

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
