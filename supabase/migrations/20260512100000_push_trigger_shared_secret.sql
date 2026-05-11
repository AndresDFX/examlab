-- ──────────────────────────────────────────────────────────────────────
-- Web Push: cambiar el auth del trigger de service_role_key → shared
-- secret propio. Razón: Lovable Cloud no expone el service_role_key al
-- usuario por seguridad, así que poner ese key como DB setting no es
-- viable sin acceso al dashboard de Supabase. Con un shared secret
-- ("PUSH_TRIGGER_SECRET") generado por el admin:
--   - El trigger lo manda en el header X-Trigger-Secret.
--   - send-push valida el header contra Deno.env.get("PUSH_TRIGGER_SECRET").
--   - verify_jwt está apagado para send-push (ver supabase/config.toml).
--
-- Sobrescribe la trigger function de la migración previa.
-- ──────────────────────────────────────────────────────────────────────

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
  -- Si la URL no está, salimos silenciosamente. La app sigue con
  -- realtime + polling.
  IF v_url IS NULL OR v_url = '' THEN
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

  -- Mandamos el shared secret en X-Trigger-Secret. El header
  -- Authorization queda vacío porque verify_jwt = false en config.toml
  -- para send-push, así que Supabase deja pasar la llamada sin JWT.
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
