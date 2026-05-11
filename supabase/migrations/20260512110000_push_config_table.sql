-- ──────────────────────────────────────────────────────────────────────
-- Web Push: mover la config del trigger de `ALTER DATABASE ... SET
-- app.settings.*` (requiere superuser, no disponible en Supabase
-- managed) a una tabla privada `push_config`.
--
-- Diseño:
--   - Tabla con UNA sola fila (singleton via CHECK id=1).
--   - RLS habilitado pero SIN policies → ningún rol authenticated lee
--     ni escribe. Solo el role service_role (que bypassea RLS) y las
--     funciones SECURITY DEFINER pueden leer.
--   - El trigger (SECURITY DEFINER) hace SELECT de la fila para sacar
--     url + secret cada vez que se inserta en notifications. Es 1 query
--     extra muy barata (PK lookup, índice clustered).
--
-- Cómo poblar la tabla (desde el SQL editor de Lovable):
--   INSERT INTO public.push_config (id, send_push_url, trigger_secret)
--   VALUES (1, 'https://<proyecto>.supabase.co/functions/v1/send-push',
--           '<el string aleatorio del paso de generación>')
--   ON CONFLICT (id) DO UPDATE
--     SET send_push_url = EXCLUDED.send_push_url,
--         trigger_secret = EXCLUDED.trigger_secret;
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.push_config (
  id              INT PRIMARY KEY DEFAULT 1,
  send_push_url   TEXT NOT NULL,
  trigger_secret  TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT push_config_singleton CHECK (id = 1)
);

ALTER TABLE public.push_config ENABLE ROW LEVEL SECURITY;
-- Sin policies = ningún user puede leerla. Solo service_role (que
-- bypassea RLS) y funciones SECURITY DEFINER.

-- Recreamos la trigger function para que lea desde la tabla en vez
-- de current_setting('app.settings.*').
CREATE OR REPLACE FUNCTION public.notify_send_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url      text;
  v_secret   text;
  v_payload  jsonb;
BEGIN
  SELECT send_push_url, trigger_secret
    INTO v_url, v_secret
    FROM public.push_config
    WHERE id = 1;

  -- Si todavía no se pobló la tabla, salimos silenciosamente. El
  -- realtime + polling siguen funcionando.
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
      'Content-Type',     'application/json',
      'X-Trigger-Secret', COALESCE(v_secret, '')
    ),
    body := v_payload,
    timeout_milliseconds := 5000
  );

  RETURN NEW;
END;
$$;
