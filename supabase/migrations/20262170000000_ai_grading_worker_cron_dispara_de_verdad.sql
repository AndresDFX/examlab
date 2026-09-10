-- ──────────────────────────────────────────────────────────────────────
-- El cron que califica con IA NO EXISTE. Se crea de verdad.
--
-- ── El sintoma que lo destapo ─────────────────────────────────────────
-- Reportado como «se demora en entregar los talleres» en UNIAJ. Al medir la
-- cola aparecio algo peor que una demora: esperas de 55 min, 15 h, 23,7 h,
-- 24 h, 25 h, 26 h, 2,8 dias y 2,9 dias. Y el lote del 2026-09-08 se completo
-- ENTERO dentro del mismo minuto (03:28-03:29), que es la firma de alguien
-- apretando «Procesar todas» a mano, no de un cron cada hora.
--
-- Verificado contra `cron.job` (via la accion `verify` de cron-deploy.yml, que
-- es de solo lectura): de los 22 jobs que existen, `ai-grading-worker-hourly`
-- NO esta. Su hermano `ai-generation-worker-hourly` SI, y corrio a las 00:15.
-- Los dos unicos jobs de IA que hay —`release-stuck-ai-grading-jobs` (*/10) y
-- `retry-failed-ai-gradings` (*/30)— no sirven para esto: el primero libera
-- trabajos COLGADOS en `processing` y el segundo reintenta los `failed`.
-- Ninguno toca un `pending` con 0 intentos, que es justo en lo que se queda una
-- entrega que cayo a la cola. O sea que hoy una entrega encolada NO se califica
-- nunca hasta que una persona lo pida.
--
-- ── Por que no existe: cuatro fallas que se tapan entre si ────────────
-- La mig 20260603100800 pretendia crearlo y no crea nada:
--
--   1. `extensions.cron.schedule` / `extensions.cron.unschedule` / `extensions.cron.job`.
--      Un nombre de TRES partes Postgres lo lee como `base.esquema.objeto` y
--      responde «cross-database references are not implemented». Las 8
--      migraciones que crearon crons VIVOS usan la forma corta `cron.schedule`.
--   2. `extensions.net.http_post`, la misma trampa en pg_net (vive en `net`).
--   3. `format()` con `current_setting(...)` CONGELA la URL y la credencial en el
--      texto del comando al crear el job. Rotar la service_role dejaria el cron
--      llamando con una clave muerta, y la clave quedaria escrita en claro
--      dentro de `cron.job.command`.
--   4. Y todo eso adentro de un `EXCEPTION WHEN OTHERS THEN RAISE NOTICE`, que
--      convierte cualquiera de las tres en un mensaje que nadie lee. La
--      migracion reporto verde y el cron no se creo.
--
-- ── Que hace esta ─────────────────────────────────────────────────────
-- Espeja las dos migraciones que SI funcionan (20261660000000 para el worker de
-- generacion, 20262110000000 para el respaldo):
--   · El comando del job es una llamada a una funcion, no un `http_post` inline.
--   · La funcion resuelve la configuracion en CADA ejecucion, asi que rotar la
--     credencial no obliga a recrear el job.
--   · `net.http_post` y `cron.schedule`: dos partes y forma corta.
--   · Sin trabajo en la cola, no gasta la invocacion del edge.
--   · **Que falle deja de ser silencio**: si no encuentra configuracion, escribe
--     un `warning` en `audit_logs` diciendo QUE falta. Que el cron no corra puede
--     pasar; que no se sepa, no — eso es lo que costo tres meses de respaldos y
--     lo que aca dejo entregas sin nota por dias.
--
-- ── De donde sale la configuracion, y por que de los dos lados ────────
-- La mig 20262110000000 dejo escrito que en Supabase Cloud las GUCs
-- `app.settings.*` no se pueden fijar (`ALTER DATABASE ... SET` pide superuser) y
-- que por eso el proyecto guarda esa configuracion en `private.app_settings`, de
-- donde la lee el trigger de correo. Pero medido, el cron de generacion —que lee
-- SOLO las GUCs— si dispara: un trabajo creado a las 03:31:54 arranco a las
-- 04:15:14, el tick exacto de su `15 * * * *`. No se puede leer
-- `private.app_settings` desde afuera para cerrar la contradiccion, asi que esta
-- funcion **no depende de resolverla**: prueba la tabla y despues las GUCs, y si
-- las dos vienen vacias lo AUDITA nombrando las dos. El fallback no es adorno:
-- es el camino que hoy parece estar funcionando en el job hermano.
--
-- ── El minuto ─────────────────────────────────────────────────────────
-- `:05`, el que la migracion vieja pretendia. Su hermano de generacion esta en
-- `:15` y su comentario dice explicitamente «:15 para no chocar con el de
-- grading (:05)» — o sea que ese offset se eligio contra un job que nunca
-- existio. Ahora si existe.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.trigger_ai_grading_worker()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_url   text;
  v_key   text;
  v_pend  int;
  v_falta text;
BEGIN
  IF to_regclass('public.ai_grading_queue') IS NULL THEN
    RAISE NOTICE 'ai_grading_queue ausente — nada que drenar';
    RETURN;
  END IF;

  -- Sin trabajo, no se molesta al edge ni se gasta una invocacion.
  SELECT count(*) INTO v_pend
    FROM public.ai_grading_queue
   WHERE status = 'pending';
  IF v_pend = 0 THEN
    RETURN;
  END IF;

  -- La tabla primero, las GUCs despues. Ver la cabecera: no se sabe cual de las
  -- dos esta poblada en esta base, y la union cubre las dos sin tener que saberlo.
  IF to_regclass('private.app_settings') IS NOT NULL THEN
    SELECT value INTO v_url FROM private.app_settings WHERE key = 'supabase_url';
    SELECT value INTO v_key FROM private.app_settings WHERE key = 'service_role_key';
  END IF;
  IF v_url IS NULL OR v_url = '' THEN
    v_url := NULLIF(current_setting('app.settings.supabase_url', true), '');
  END IF;
  IF v_key IS NULL OR v_key = '' THEN
    v_key := NULLIF(current_setting('app.settings.service_role_key', true), '');
  END IF;

  IF v_url IS NULL OR v_url = '' OR v_key IS NULL OR v_key = '' THEN
    v_falta := CASE
                 WHEN (v_url IS NULL OR v_url = '') AND (v_key IS NULL OR v_key = '')
                   THEN 'supabase_url y service_role_key'
                 WHEN (v_url IS NULL OR v_url = '') THEN 'supabase_url'
                 ELSE 'service_role_key'
               END;
    -- Visible en el modulo de Auditoria. Sin esto la cola se llena en silencio y
    -- parece que la IA esta rota, que es exactamente lo que se reporto.
    BEGIN
      INSERT INTO public.audit_logs (action, severity, metadata)
      VALUES (
        'ai_grading.cron_not_configured',
        'warning',
        jsonb_build_object(
          'pendientes', v_pend,
          'falta', v_falta,
          'buscado_en', 'private.app_settings y las GUCs app.settings.*',
          'consecuencia', 'Las entregas encoladas NO se califican hasta que alguien use "Procesar todas" en el modulo Cron.'
        )
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'ai_grading.cron_not_configured no se pudo auditar: %', SQLERRM;
    END;
    RETURN;
  END IF;

  BEGIN
    -- `net.http_post` (dos partes). `extensions.net.http_post` LANZA.
    PERFORM net.http_post(
      url     := v_url || '/functions/v1/ai-grading-worker',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      body    := '{}'::jsonb,        -- sin jobId = modo drain
      timeout_milliseconds := 90000
    );
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.audit_logs (action, severity, metadata)
      VALUES (
        'ai_grading.cron_dispatch_failed',
        'error',
        jsonb_build_object('pendientes', v_pend, 'error', SQLERRM)
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'ai_grading.cron_dispatch_failed no se pudo auditar: %', SQLERRM;
    END;
  END;
END
$fn$;

COMMENT ON FUNCTION public.trigger_ai_grading_worker() IS
  'Invoca el edge ai-grading-worker en modo drain. La llama el cron ai-grading-worker-hourly. Si falta la configuracion, audita un warning en vez de callarse.';

-- Solo el cron (que corre como superusuario) y service_role la ejecutan.
-- El REVOKE a anon/authenticated es explicito a proposito: Supabase otorga
-- EXECUTE por ALTER DEFAULT PRIVILEGES y el REVOKE ... FROM PUBLIC no borra esa
-- entrada del ACL (medido en el proyecto: 256 de 305 SECURITY DEFINER tenian
-- anon=X). Sin esto, un anonimo con la URL podria disparar el drenaje.
REVOKE ALL ON FUNCTION public.trigger_ai_grading_worker() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.trigger_ai_grading_worker() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_ai_grading_worker() TO service_role;

-- ── El job de cron ────────────────────────────────────────────────────
DO $do$
BEGIN
  IF to_regclass('public.ai_grading_queue') IS NULL THEN
    RAISE NOTICE 'ai_grading_queue ausente — se omite el cron del worker';
    RETURN;
  END IF;

  -- Se pregunta si `cron.schedule` es INVOCABLE, no si la extension figura en
  -- pg_extension: es lo que de verdad hace falta, y asi el guard se puede
  -- ejercitar en una base de prueba con un stub del schema `cron`.
  IF to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN
    RAISE NOTICE 'pg_cron no disponible — la calificacion con IA queda en manual ("Procesar todas" del modulo Cron)';
    RETURN;
  END IF;

  -- Idempotente: si quedo alguna version vieja con el comando roto, se reemplaza.
  PERFORM cron.unschedule('ai-grading-worker-hourly')
   WHERE EXISTS (
     SELECT 1 FROM cron.job WHERE jobname = 'ai-grading-worker-hourly'
   );

  PERFORM cron.schedule(
    'ai-grading-worker-hourly',
    '5 * * * *',    -- :05, el minuto contra el que el de generacion eligio su :15
    'SELECT public.trigger_ai_grading_worker();'
  );
END $do$;

-- Descripcion humana para el panel del SuperAdmin (Tareas programadas).
DO $desc$
BEGIN
  IF to_regclass('public.cron_job_descriptions') IS NULL THEN RETURN; END IF;
  INSERT INTO public.cron_job_descriptions (jobname, description)
  VALUES (
    'ai-grading-worker-hourly',
    'Cada hora califica con IA las entregas que quedaron en espera. Si no hay ninguna en espera, no hace nada.'
  )
  ON CONFLICT (jobname) DO UPDATE SET description = EXCLUDED.description;
END $desc$;

NOTIFY pgrst, 'reload schema';
