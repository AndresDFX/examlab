-- ──────────────────────────────────────────────────────────────────────
-- Email delivery para `notifications`.
--
-- Agrega tracking de envío por email y un trigger que dispara una edge
-- function `send-email` (vía pg_net.http_post, igual patrón que el de
-- push). Solo manda email para "kinds críticos" — la lista vive en
-- `_notification_kind_emails` para poder ampliarla en una sola línea.
--
-- Defensa contra `pg_net` faltante: copia el patrón del trigger de push
-- — si el schema `net` no existe, NO falla el INSERT del padre, solo
-- registra `email_skipped_reason = 'pg_net_missing'` para diagnóstico.
--
-- Columnas:
--   - email_delivered_at  → timestamp cuando la edge function confirmó
--                           el envío al SMTP. NULL si nunca se envió o
--                           si el kind no aplica.
--   - email_skipped_reason→ código corto de por qué NO se mandó:
--       'kind_not_critical' | 'no_email' | 'no_settings' | 'pg_net_missing' |
--       'user_opted_out' | 'provider_error: <msg>'.
--     Útil para audit + diagnóstico desde el dashboard sin tener que
--     leer logs de la edge.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS email_delivered_at TIMESTAMPTZ;

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS email_skipped_reason TEXT;

-- ── Tabla privada de settings ────────────────────────────────────────
-- En Supabase Cloud `ALTER DATABASE ... SET app.settings.*` requiere
-- superuser (no lo tenemos). Y `vault` puede no estar instalado en
-- self-hosted. Usamos una tabla privada que solo leen las funciones
-- SECURITY DEFINER. Lockdown total: schema sin acceso para anon/auth,
-- table con RLS habilitada y ningún policy (= nadie puede leer salvo
-- security definer).
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;

CREATE TABLE IF NOT EXISTS private.app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE private.app_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.app_settings FROM PUBLIC, anon, authenticated;

-- Predicado central de "este kind merece email". Vive en una función
-- IMMUTABLE para que se pueda ampliar en un solo lugar (sin tocar el
-- trigger ni la edge). Mensajes 1-a-1 usan `kind='info'` con un link
-- que empieza con `/app/messages` — caso especial para no spammear con
-- todos los `info` del sistema (algunos son notas globales sin acción).
CREATE OR REPLACE FUNCTION public._notification_kind_emails(
  _kind TEXT,
  _link TEXT
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    _kind IN ('grade', 'exam', 'feedback')
    OR (_kind = 'info' AND _link IS NOT NULL AND _link LIKE '/app/messages%');
$$;

-- Trigger que dispara la edge function tras un INSERT en notifications.
-- Mismo patrón defensivo que `notify_send_push` (migración
-- 20260520000000): si los settings no están configurados o pg_net no
-- está disponible, registra el motivo y deja pasar el INSERT — la
-- notificación in-app + push siguen funcionando.
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
  -- Leer URL + service_role_key desde private.app_settings. Esa tabla
  -- está bloqueada para anon/authenticated; solo accesible vía
  -- SECURITY DEFINER. Si las filas no existen, las dos variables quedan
  -- NULL y caen en la rama 'no_settings' más abajo.
  SELECT value INTO v_url FROM private.app_settings WHERE key = 'send_email_url';
  SELECT value INTO v_key FROM private.app_settings WHERE key = 'service_role_key';

  -- Filtro temprano: kinds no críticos NO disparan email. Registramos
  -- el motivo para que el docente sepa que la notificación se entregó
  -- in-app pero no por correo (es información, no error).
  IF NOT public._notification_kind_emails(NEW.kind, NEW.link) THEN
    UPDATE public.notifications
      SET email_skipped_reason = 'kind_not_critical'
      WHERE id = NEW.id;
    RETURN NEW;
  END IF;

  -- Settings ausentes → silencio. La app sigue corriendo con in-app +
  -- push; el correo se activa cuando el admin configura las settings.
  IF v_url IS NULL OR v_url = '' THEN
    UPDATE public.notifications
      SET email_skipped_reason = 'no_settings'
      WHERE id = NEW.id;
    RETURN NEW;
  END IF;

  -- pg_net debe estar habilitada para el http_post. Si no lo está,
  -- registramos y salimos limpio (no tiramos el INSERT entero).
  SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') INTO v_net_exists;
  IF NOT v_net_exists THEN
    UPDATE public.notifications
      SET email_skipped_reason = 'pg_net_missing'
      WHERE id = NEW.id;
    RETURN NEW;
  END IF;

  -- Llamada fire-and-forget a la edge function `send-email`. La edge
  -- carga la notification por id, busca el email del destinatario, y
  -- después actualiza `email_delivered_at` o `email_skipped_reason`.
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

DROP TRIGGER IF EXISTS notifications_send_email ON public.notifications;
CREATE TRIGGER notifications_send_email
  AFTER INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.notify_send_email();

NOTIFY pgrst, 'reload schema';
