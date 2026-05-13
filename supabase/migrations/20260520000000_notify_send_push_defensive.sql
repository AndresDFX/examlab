-- ──────────────────────────────────────────────────────────────────────
-- notify_send_push: hacer el trigger tolerante a `pg_net` ausente.
--
-- Bug que arregla: al enviar un mensaje del módulo de mensajería, el
-- flujo es:
--   1. INSERT en `messages` (trigger inserta una notificación al
--      destinatario).
--   2. INSERT en `notifications` (trigger `notify_send_push` llama
--      `net.http_post(...)` para fan-out al edge `send-push`).
--   3. Si la extensión `pg_net` NO está habilitada en el proyecto
--      Supabase, el schema `net` no existe → ERROR. El INSERT del
--      paso 2 falla, lo que CASCADEA y rompe el INSERT del paso 1.
--      El usuario ve "schema 'net' does not exist" en la UI y el
--      mensaje nunca se manda.
--
-- Fix:
--   - Verificamos antes de la llamada si el schema `net` existe (y la
--     extensión `pg_net` está habilitada). Si no, salimos limpiamente
--     sin error. La notificación se persiste igual; solo no hay push
--     real al device.
--   - Como red de seguridad final, envolvemos la llamada en un
--     EXCEPTION WHEN OTHERS para que CUALQUIER fallo de pg_net
--     (timeout, schema raro, permisos, etc.) NO rompa el INSERT padre.
--
-- Consecuencia: la app sigue funcionando aunque `pg_net` no esté
-- habilitada — el usuario ve la notificación en el bell (que la lee
-- por realtime + polling) pero NO recibe push notification real en su
-- PWA cerrada. Esa es una pérdida de funcionalidad aceptable mientras
-- el admin habilita la extensión.
-- ──────────────────────────────────────────────────────────────────────

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
  v_net_exists boolean;
BEGIN
  -- Si los settings no están configurados, salimos silenciosamente. El
  -- sistema sigue con realtime + polling — solo se pierde el push real
  -- al device cerrado.
  IF v_url IS NULL OR v_url = '' THEN
    RETURN NEW;
  END IF;

  -- Verificamos si la extensión `pg_net` está habilitada (schema `net`
  -- presente). Si NO, salimos antes de intentar la llamada — evita que
  -- el INSERT padre falle por una dependencia no instalada.
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

  -- Red de seguridad: aunque el schema `net` exista, la llamada puede
  -- fallar por timeouts, permisos, malformación de URL, etc. Capturamos
  -- TODO porque el trigger NUNCA debería romper el INSERT del padre —
  -- la notificación tiene que persistirse aunque el push falle.
  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || COALESCE(v_key, '')
      ),
      body := v_payload,
      timeout_milliseconds := 5000
    );
  EXCEPTION WHEN OTHERS THEN
    -- Loggeamos para diagnóstico pero NO interrumpimos el flujo.
    -- RAISE NOTICE en triggers SECURITY DEFINER llega al log de Supabase.
    RAISE NOTICE 'notify_send_push: pg_net call failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
