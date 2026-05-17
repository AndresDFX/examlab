-- ──────────────────────────────────────────────────────────────────────
-- Preferencias de notificación por usuario.
--
-- Cada usuario puede silenciar canales (email / push) por kind
-- (exam, workshop, project, grade, feedback, attendance, content,
--  info — mensajes 1-a-1, system).
--
-- Las notificaciones in-app SIEMPRE se entregan (la regulación del
-- volumen la hacen los kill switches del admin + el bell badge).
--
-- Modelo: columna JSONB en profiles
--   notification_preferences = {
--     "exam":     {"email": true,  "push": true},
--     "workshop": {"email": false, "push": true},
--     ...
--   }
-- Default: {} → todos los canales habilitados (opt-out, no opt-in).
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS notification_preferences JSONB
    NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.profiles.notification_preferences IS
  'Preferencias de canales (email/push) por kind. Estructura: {kind: {email: bool, push: bool}}. Default {} = todo habilitado.';

-- ── Helper: ¿el usuario tiene este canal habilitado para este kind? ──

CREATE OR REPLACE FUNCTION public._user_channel_enabled(
  _user_id UUID,
  _kind    TEXT,
  _channel TEXT  -- 'email' | 'push'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    -- Si la preferencia no está seteada → TRUE (default opt-in)
    (p.notification_preferences -> _kind ->> _channel)::boolean,
    TRUE
  )
  FROM public.profiles p
  WHERE p.id = _user_id;
$$;

-- ── Reemplazar notify_send_email para chequear preferencia del user ──
-- (idéntico al original, agregando bloque user_opted_out)

CREATE OR REPLACE FUNCTION public.notify_send_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url text;
  v_key text;
  v_net_exists boolean;
BEGIN
  SELECT value INTO v_url FROM private.app_settings WHERE key = 'send_email_url';
  SELECT value INTO v_key FROM private.app_settings WHERE key = 'service_role_key';

  IF NOT public._notification_kind_emails(NEW.kind, NEW.link) THEN
    UPDATE public.notifications
      SET email_skipped_reason = 'kind_not_critical'
      WHERE id = NEW.id;
    RETURN NEW;
  END IF;

  -- ── Chequeo de preferencia del usuario ──
  IF NOT public._user_channel_enabled(NEW.user_id, NEW.kind, 'email') THEN
    UPDATE public.notifications
      SET email_skipped_reason = 'user_opted_out'
      WHERE id = NEW.id;
    RETURN NEW;
  END IF;

  IF v_url IS NULL OR v_url = '' THEN
    UPDATE public.notifications
      SET email_skipped_reason = 'no_settings'
      WHERE id = NEW.id;
    RETURN NEW;
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') INTO v_net_exists;
  IF NOT v_net_exists THEN
    UPDATE public.notifications
      SET email_skipped_reason = 'pg_net_missing'
      WHERE id = NEW.id;
    RETURN NEW;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || COALESCE(v_key, '')
      ),
      body := jsonb_build_object('notification_id', NEW.id),
      timeout_milliseconds := 10000
    );
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.notifications
      SET email_skipped_reason = 'pg_net_call_failed: ' || SQLERRM
      WHERE id = NEW.id;
  END;

  RETURN NEW;
END;
$$;

-- ── Reemplazar notify_send_push para chequear preferencia ──

CREATE OR REPLACE FUNCTION public.notify_send_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url      text := current_setting('app.settings.send_push_url', true);
  v_secret   text := current_setting('app.settings.push_trigger_secret', true);
  v_payload  jsonb;
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    RETURN NEW;
  END IF;

  -- ── Chequeo de preferencia del usuario ──
  IF NOT public._user_channel_enabled(NEW.user_id, NEW.kind, 'push') THEN
    RETURN NEW;
  END IF;

  v_payload := jsonb_build_object(
    'user_id', NEW.user_id,
    'title',   NEW.title,
    'body',    NEW.body,
    'link',    NEW.link,
    'kind',    NEW.kind,
    'notification_id', NEW.id
  );

  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type',     'application/json',
      'X-Trigger-Secret', COALESCE(v_secret, '')
    ),
    body := v_payload,
    timeout_milliseconds := 5000
  );

  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
