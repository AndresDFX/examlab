-- ──────────────────────────────────────────────────────────────────────
-- Web Push notifications: tabla + trigger de fan-out al edge function.
--
-- Arquitectura:
--   1. El cliente (PWA) llama a `pushManager.subscribe()` con la VAPID
--      public key. El browser devuelve un endpoint + claves p256dh/auth
--      que persistimos en `public.push_subscriptions`.
--   2. Cuando se inserta una fila en `public.notifications`, un trigger
--      hace `pg_net.http_post(...)` al edge function `send-push` con
--      el user_id + payload. La función mira las suscripciones del user
--      y envía al endpoint de Web Push de cada device.
--   3. El SW (public/sw.js, evento `push`) recibe el payload y dispara
--      `showNotification(...)`. Esto funciona aunque la PWA esté cerrada.
--
-- Requiere las extensiones `pg_net` (HTTP outbound desde Postgres) y
-- secrets configurados en el dashboard de Supabase:
--   - app.settings.supabase_url       → URL del proyecto
--   - app.settings.send_push_url      → <supabase_url>/functions/v1/send-push
--   - app.settings.service_role_key   → service_role JWT (para autorizar la llamada)
-- (Lovable Publish suele setear `app.settings.supabase_url` automático;
-- los otros dos los configura el admin.)
-- ──────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── 1. Tabla de suscripciones ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- endpoint es el URL único asignado por el browser. Es el primary
  -- key efectivo desde el lado del cliente: si el browser pierde la
  -- suscripción y la recrea, el endpoint cambia.
  endpoint    TEXT NOT NULL,
  -- Claves criptográficas que necesita el servidor para firmar el
  -- payload. p256dh es la public key del device, auth es un secret
  -- compartido. Ambas vienen de subscription.toJSON().
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON public.push_subscriptions(user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- El usuario solo gestiona sus propias suscripciones. El edge function
-- usa service_role y bypasea RLS, así que no necesita políticas.
DROP POLICY IF EXISTS push_subscriptions_owner ON public.push_subscriptions;
CREATE POLICY push_subscriptions_owner ON public.push_subscriptions
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── 2. Trigger: notifications INSERT → fan-out al edge function ──────
-- pg_net devuelve un id de request inmediatamente; la respuesta queda
-- en `net._http_response`. No bloqueamos el INSERT esperándola — esto
-- es fire-and-forget desde el punto de vista del docente que crea la
-- notificación.

CREATE OR REPLACE FUNCTION public.notify_send_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url       text := current_setting('app.settings.send_push_url', true);
  v_key       text := current_setting('app.settings.service_role_key', true);
  v_payload   jsonb;
BEGIN
  -- Si los settings no están configurados, salimos silenciosamente.
  -- El sistema sigue funcionando con realtime + polling; solo que sin
  -- Web Push real (que es lo que se rompe en PWA móvil cerrada).
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

  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || COALESCE(v_key, '')
    ),
    body := v_payload,
    timeout_milliseconds := 5000
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notifications_send_push ON public.notifications;
CREATE TRIGGER notifications_send_push
  AFTER INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.notify_send_push();

-- ── 3. Touch updated_at en push_subscriptions ────────────────────────
CREATE OR REPLACE FUNCTION public.touch_push_subscription()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS push_subscriptions_touch ON public.push_subscriptions;
CREATE TRIGGER push_subscriptions_touch
  BEFORE UPDATE ON public.push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_push_subscription();
