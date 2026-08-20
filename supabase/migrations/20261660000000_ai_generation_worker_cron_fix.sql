-- ──────────────────────────────────────────────────────────────────────
-- El cron que drena la cola de generación de IA NO EXISTÍA en producción.
--
-- `20260603080000_ai_generation_worker_cron.sql` debía crear
-- `ai-generation-worker-hourly`, pero verificado el 2026-08-19 contra la base:
-- de los 25 jobs de pg_cron, ese no está. Consecuencia: cuando un docente pide
-- "generar con IA" y el modo es async, el job queda en `ai_generation_queue`
-- **para siempre** — nadie lo drena salvo que alguien entre al módulo Cron y
-- pulse "Procesar todos". Un encolado que no se procesa se lee como "la IA no
-- funciona".
--
-- ── Por qué falló la migración original, y qué se hace distinto ────────
--
-- 1. Usaba `extensions.net.http_post` DENTRO del comando del cron. Eso no
--    funciona: pg_net vive en el schema `net`, y Postgres responde
--    "cross-database references are not implemented: extensions.net.http_post".
--    No es teoría — es exactamente el error con el que `calendar-recordings-sync-6h`
--    viene fallando cada 6 horas en producción (mismo anti-patrón).
--    Acá se usa `net.http_post`, que es la forma con la que
--    `trigger_retry_failed_ai_gradings` sí funciona.
--
-- 2. Resolvía la URL con `format()` AL CREAR el job, así que el valor de las
--    GUCs quedaba congelado en el comando. Si la GUC estaba vacía, el comando
--    nacía con `url := NULL` y falla en cada corrida. Acá la config se resuelve
--    EN CADA EJECUCIÓN, dentro de una función.
--
-- 3. Envolvía todo en `EXCEPTION WHEN OTHERS THEN RAISE NOTICE`, así que su
--    propio fallo era invisible: la migración quedaba "aplicada" sin haber
--    creado nada. Acá el `DO` solo tolera lo que de verdad puede faltar
--    (pg_cron) y **deja rastro en `audit_logs`** cuando no puede operar.
--
-- ── El caso "no está configurado" se AUDITA, no se ignora ──────────────
-- La función necesita la URL del proyecto y una credencial para invocar el
-- edge. Ambas viven en GUCs porque un secreto NO puede ir en una migración
-- versionada (esto va al repo). Si faltan, la función **registra un warning en
-- `audit_logs`** una vez por hora en vez de callarse: así el hueco se ve en el
-- módulo de Auditoría, que es el punto que hizo que este cron estuviera dos
-- meses ausente sin que nadie lo notara.
--
-- Para dejarlo operativo hay que correr UNA vez en el SQL Editor (la clave NO
-- se commitea):
--   ALTER DATABASE postgres SET app.settings.supabase_url = 'https://<ref>.supabase.co';
--   ALTER DATABASE postgres SET app.settings.service_role_key = '<service_role_key>';
-- Y reconectar la sesión para que tomen efecto.
--
-- ── Alcance deliberadamente conservador ───────────────────────────────
-- El worker drena hasta 10 jobs por invocación y **se autoexcluye si
-- `processing_mode` es async** (preserva la semántica "encolé porque quería
-- esperar"). Una corrida por hora acota el gasto de IA: la cola es para
-- pedidos REALES de un docente, y esa cadencia evita que un lote se coma la
-- cuota del proveedor de una sola vez.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.trigger_ai_generation_worker()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url  text := current_setting('app.settings.supabase_url', true);
  v_key  text := current_setting('app.settings.service_role_key', true);
  v_pend int;
BEGIN
  -- Sin trabajo, no se molesta al edge ni se gasta una invocación.
  SELECT count(*) INTO v_pend
    FROM public.ai_generation_queue
   WHERE status = 'pending';
  IF v_pend = 0 THEN
    RETURN;
  END IF;

  IF v_url IS NULL OR v_url = '' OR v_key IS NULL OR v_key = '' THEN
    -- Visible en el módulo de Auditoría. Sin esto, la cola se llena en
    -- silencio y parece que la IA está rota.
    INSERT INTO public.audit_logs (action, severity, metadata)
    VALUES (
      'ai_generation.cron_not_configured',
      'warning',
      jsonb_build_object(
        'pendientes', v_pend,
        'falta', CASE
                   WHEN (v_url IS NULL OR v_url = '') AND (v_key IS NULL OR v_key = '')
                     THEN 'app.settings.supabase_url y app.settings.service_role_key'
                   WHEN (v_url IS NULL OR v_url = '') THEN 'app.settings.supabase_url'
                   ELSE 'app.settings.service_role_key'
                 END,
        'como_resolver', 'Correr ALTER DATABASE postgres SET ... (ver la migracion 20261660000000)'
      )
    );
    RETURN;
  END IF;

  -- `net.http_post`, NO `extensions.net.http_post` (ver el comentario de arriba).
  PERFORM net.http_post(
    url := v_url || '/functions/v1/ai-generation-worker',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := '{}'::jsonb,          -- sin jobId = modo drain
    timeout_milliseconds := 90000
  );
END
$$;

COMMENT ON FUNCTION public.trigger_ai_generation_worker() IS
  'Invoca el edge ai-generation-worker en modo drain. La llama el cron ai-generation-worker-hourly. Si las GUCs de config faltan, audita un warning en vez de callarse.';

-- Solo el cron (que corre como superusuario) y service_role la ejecutan.
REVOKE ALL ON FUNCTION public.trigger_ai_generation_worker() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.trigger_ai_generation_worker() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_ai_generation_worker() TO service_role;

-- ── El job de cron ────────────────────────────────────────────────────
-- El comando es una llamada a la función (patrón de los 23 jobs que SÍ
-- funcionan), no un http_post inline (patrón de los 2 que fallan).
DO $$
BEGIN
  IF to_regclass('public.ai_generation_queue') IS NULL THEN
    RAISE NOTICE 'ai_generation_queue ausente — se omite el cron del worker';
    RETURN;
  END IF;

  -- pg_cron es lo único que legítimamente puede no estar; se tolera SOLO eso.
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron no instalado — el worker de generación queda en manual ("Procesar todos" del módulo Cron)';
    RETURN;
  END IF;

  -- Idempotente: si ya existe (con el comando viejo y roto), se reemplaza.
  PERFORM extensions.cron.unschedule('ai-generation-worker-hourly')
   WHERE EXISTS (
     SELECT 1 FROM extensions.cron.job WHERE jobname = 'ai-generation-worker-hourly'
   );

  PERFORM extensions.cron.schedule(
    'ai-generation-worker-hourly',
    '15 * * * *',   -- :15 para no chocar con el de grading (:05)
    'SELECT public.trigger_ai_generation_worker();'
  );
END $$;

-- Descripción humana para el panel del SuperAdmin (Tareas programadas).
DO $$
BEGIN
  IF to_regclass('public.cron_job_descriptions') IS NULL THEN RETURN; END IF;
  INSERT INTO public.cron_job_descriptions (jobname, description)
  VALUES (
    'ai-generation-worker-hourly',
    'Cada hora procesa las generaciones con IA que quedaron en espera (preguntas de taller, examen, reto en vivo y material). Si no hay nada en espera, no hace nada.'
  )
  ON CONFLICT (jobname) DO UPDATE SET description = EXCLUDED.description;
END $$;

NOTIFY pgrst, 'reload schema';
