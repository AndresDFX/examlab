-- ──────────────────────────────────────────────────────────────────────
-- Schedule del worker `ai-generation-worker`.
--
-- Análogo al cron de `ai-grading-worker` (mig 20260603100800), pero para
-- la cola de GENERACIÓN. Drena `ai_generation_queue` cada hora en el
-- minuto :15 (offset para no chocar con grading en :05).
--
-- IMPORTANTE: el worker solo procesa si `ai_model_settings.processing_mode`
-- es `sync` (decisión interna del worker). En modo `async` los jobs
-- esperan a que el admin/docente los procese manualmente desde el panel
-- "Cola IA → Generaciones". Esto preserva la semántica de "encolé
-- porque quiero esperar a tener código".
--
-- También agregamos la descripción del job a `cron_job_descriptions`
-- para que aparezca en el panel admin SuperAdmin (Tareas programadas).
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron no disponible en este proyecto. El worker de generación tendrá que dispararse manualmente.';
    RETURN;
  END;

  -- Idempotencia: borrar schedule previo si existe.
  PERFORM extensions.cron.unschedule('ai-generation-worker-hourly')
  WHERE EXISTS (
    SELECT 1 FROM extensions.cron.job WHERE jobname = 'ai-generation-worker-hourly'
  );

  PERFORM extensions.cron.schedule(
    'ai-generation-worker-hourly',
    '15 * * * *',
    format(
      $cron$
      SELECT extensions.net.http_post(
        url := %L,
        headers := %L::jsonb,
        body := %L::jsonb,
        timeout_milliseconds := 90000
      )
      $cron$,
      current_setting('app.settings.supabase_url', true) || '/functions/v1/ai-generation-worker',
      jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
      ),
      '{}'::jsonb
    )
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Setup del cron del worker de generación IA falló: %. Configurar manualmente las GUCs app.settings.supabase_url y app.settings.service_role_key.', SQLERRM;
END
$$;

-- Descripción humana para que aparezca explicada en el panel admin.
INSERT INTO public.cron_job_descriptions (jobname, description)
VALUES (
  'ai-generation-worker-hourly',
  'Cada hora invoca el edge function `ai-generation-worker`, que drena la cola `ai_generation_queue` (preguntas, archivos, contenidos encolados para generar con IA). Solo procesa si `ai_model_settings.processing_mode = ''sync''` — en modo async deja los jobs esperando para que el docente los procese manualmente con un código de IA inmediata desde el panel "Cola IA → Generaciones".'
)
ON CONFLICT (jobname) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at = now();

NOTIFY pgrst, 'reload schema';
