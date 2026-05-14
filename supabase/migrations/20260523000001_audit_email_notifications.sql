-- ──────────────────────────────────────────────────────────────────────
-- Auditoría completa del flujo de emails de notificaciones.
--
-- Antes de esta migración el único rastro de "qué pasó con el correo"
-- era la columna `notifications.email_skipped_reason` (o el
-- `email_delivered_at` si llegó). Eso sirve para diagnóstico puntual
-- pero no para ver el histórico en el panel de auditoría ni para
-- alertar sobre fallos sistémicos.
--
-- Esta migración:
--   1) Agrega un RPC `audit_email_event(notification_id, action,
--      severity, metadata)` que inserta en `audit_logs` con la categoría
--      'email', resolviendo automáticamente el destinatario, el kind y
--      el link de la notification.
--   2) Reemplaza `notify_send_email` para que llame al RPC en cada rama
--      de decisión (kind no crítico, settings faltantes, pg_net missing,
--      pg_net call failed, dispatched). Mantiene el comportamiento
--      anterior — solo agrega los logs.
--   3) Le da permiso a `service_role` para que la edge function
--      `send-email` pueda llamar el mismo RPC desde sus propias ramas
--      (notification not found, opt-out, SMTP error, etc.).
--
-- Acciones (`audit_logs.action`) que se emiten:
--   - email.dispatched        → trigger envió pg_net → edge function
--   - email.skipped           → cualquier capa decidió no enviar
--   - email.delivered         → edge function confirmó envío SMTP
--   - email.failed            → error en pg_net o en SMTP
--
-- Categoría: 'email' (nueva — agregar al UI de audit/locale).
-- ──────────────────────────────────────────────────────────────────────

-- 1) ─────────────────────────────────────────────── RPC audit_email_event

CREATE OR REPLACE FUNCTION public.audit_email_event(
  p_notification_id uuid,
  p_action          text,
  p_severity        text  DEFAULT 'info',
  p_metadata        jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id   uuid;
  v_kind      text;
  v_title     text;
  v_link      text;
  v_email     text;
  v_full_name text;
BEGIN
  -- Carga el destinatario + correo. Hace LEFT JOIN para que si la
  -- notification fue borrada entre el evento y este log, igual se
  -- registre el evento con los datos que tengamos.
  SELECT n.user_id, n.kind, n.title, n.link,
         p.institutional_email, p.full_name
    INTO v_user_id, v_kind, v_title, v_link, v_email, v_full_name
    FROM public.notifications n
    LEFT JOIN public.profiles p ON p.id = n.user_id
   WHERE n.id = p_notification_id;

  INSERT INTO public.audit_logs (
    actor_id, actor_email, actor_role,
    action, category, severity,
    entity_type, entity_id, entity_name,
    metadata
  ) VALUES (
    v_user_id,                          -- actor = destinatario (la acción la genera el sistema, no un usuario concreto)
    v_email,
    'sistema',
    p_action,
    'email',
    COALESCE(p_severity, 'info'),
    'notification',
    p_notification_id::text,
    v_title,
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'kind',              v_kind,
      'link',              v_link,
      'recipient_user_id', v_user_id,
      'recipient_email',   v_email,
      'recipient_name',    v_full_name
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- El audit nunca debe romper el flujo principal. Si falla por cualquier
  -- razón (FK, jsonb malformado, etc.), silenciamos.
  NULL;
END;
$$;

-- Permisos: la edge function corre con service_role JWT, así que
-- necesita EXECUTE explícito sobre la RPC. Authenticated NO debe
-- llamarla directamente (los users no tienen por qué inyectar audit
-- logs custom).
REVOKE ALL ON FUNCTION public.audit_email_event(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.audit_email_event(uuid, text, text, jsonb) TO service_role;

-- 2) ─────────────────────────────────────── Trigger con audit en cada rama

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

  -- Rama 1: kind no crítico → skip silencioso. Severidad 'info' porque
  -- es comportamiento esperado para todas las notificaciones "blandas".
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

  -- Rama 2: settings ausentes → warning. La app sigue corriendo pero
  -- el admin debería verlo en el panel y configurar los secrets.
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

  -- Rama 3: pg_net no instalada → warning. Bloquea el envío entero.
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

  -- Rama 4: pg_net call. Si succeed → 'email.dispatched'. Si throw →
  -- 'email.failed' con el SQLERRM en metadata. La edge function emitirá
  -- 'email.delivered' o 'email.failed' aparte cuando termine su trabajo.
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
