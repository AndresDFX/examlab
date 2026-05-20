-- ──────────────────────────────────────────────────────────────────────
-- notify_send_push: restaurar el contrato correcto con el edge function
-- después de la regresión introducida por 20260520000000.
--
-- Línea de tiempo del trigger:
--   20260510120000  v1  — Authorization: Bearer service_role_key
--                         (GUCs app.settings.*)
--   20260512100000  v2  — X-Trigger-Secret (GUCs app.settings.*)
--   20260512110000  v3  — X-Trigger-Secret + tabla `push_config`
--                         (los GUCs app.settings.* no se pueden setear en
--                          Supabase managed sin superuser)
--   20260520000000  v4  — Agregó pg_net defensive check + EXCEPTION
--                         wrapper, PERO regresó a Authorization Bearer
--                         + GUCs app.settings.* — perdió todo lo de v2/v3.
--
-- Síntoma producido por v4 + edge function (`PUSH_TRIGGER_SECRET` env):
--   - Si el admin configuró `PUSH_TRIGGER_SECRET` en el edge function (la
--     ruta segura recomendada), TODAS las llamadas del trigger fallan
--     con 401 Unauthorized porque el trigger ya no envía el header.
--   - Las notificaciones se persisten en la tabla (el usuario las ve en
--     la campanita) pero NO llega Web Push al device cerrado/Android.
--
-- Este fix combina lo bueno de v3 + v4:
--   - `push_config` table como source of truth (v3).
--   - `X-Trigger-Secret` header (v2/v3) — coincide con lo que el edge
--     function valida en supabase/functions/send-push/index.ts.
--   - pg_net presence check (v4 defensive) — si la extensión no está
--     habilitada, salimos limpio sin romper el INSERT padre.
--   - EXCEPTION wrapper (v4 defensive) — cualquier fallo de pg_net
--     (timeout, DNS, etc.) se loggea pero no rompe el INSERT padre.
--
-- Tras esta migración, asegúrate que:
--   1. `public.push_config` tiene una fila (id=1) con `send_push_url`
--      apuntando al edge function actual y `trigger_secret` no vacío.
--   2. El edge function tiene env `PUSH_TRIGGER_SECRET` con EL MISMO
--      valor que `push_config.trigger_secret`.
--   3. El edge function tiene `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY`
--      + `VAPID_SUBJECT` (sin esto retorna `skipped: vapid_missing`).
--   4. El frontend tiene `VITE_VAPID_PUBLIC_KEY` con el mismo public key.
--   5. Extensión `pg_net` habilitada en el proyecto.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notify_send_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url        text;
  v_secret     text;
  v_payload    jsonb;
  v_net_exists boolean;
BEGIN
  SELECT send_push_url, trigger_secret
    INTO v_url, v_secret
    FROM public.push_config
    WHERE id = 1;

  -- Sin URL configurada (tabla vacía o sin fila id=1) salimos limpio.
  -- La notificación queda persistida; el usuario la ve por realtime
  -- + polling — solo se pierde el Web Push real al device cerrado.
  IF v_url IS NULL OR v_url = '' THEN
    RETURN NEW;
  END IF;

  -- Si la extensión pg_net no está habilitada, el schema `net` no
  -- existe y `net.http_post` daría error en runtime — evitamos romper
  -- el INSERT padre.
  SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') INTO v_net_exists;
  IF NOT v_net_exists THEN
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

  -- Header `X-Trigger-Secret` debe coincidir con el env
  -- `PUSH_TRIGGER_SECRET` del edge function `send-push`. Mismatch → 401.
  -- Authorization se omite a propósito: send-push tiene verify_jwt=false
  -- en config.toml y no consulta ese header.
  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type',     'application/json',
        'X-Trigger-Secret', COALESCE(v_secret, '')
      ),
      body := v_payload,
      timeout_milliseconds := 5000
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'notify_send_push: pg_net call failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
