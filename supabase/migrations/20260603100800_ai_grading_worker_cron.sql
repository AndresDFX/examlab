-- ──────────────────────────────────────────────────────────────────────
-- Schedule horario para el worker `ai-grading-worker`.
--
-- Usa la extensión pg_cron (disponible en Supabase Cloud) para llamar al
-- edge function vía HTTP cada hora en el minuto 5 (para no chocar con
-- otros jobs en :00). El service-role key se pasa en el header
-- Authorization para que la edge function pueda llamar RPCs internas.
--
-- IMPORTANTE — Supabase Cloud expone las extensiones `pg_cron` y `pg_net`
-- en el schema `extensions`. La función `cron.schedule` también
-- existe pero los proyectos modernos prefieren `cron.schedule_in_database`
-- por compatibilidad multi-tenant. Acá usamos `cron.schedule` clásico
-- que funciona en proyectos antiguos y nuevos.
--
-- Si el proyecto destino no tiene pg_cron habilitado el bloque DO se
-- traga el error y la migración pasa — el admin tendrá que activarla
-- desde el dashboard Supabase manualmente. Sin cron, el worker se
-- puede invocar manualmente desde el panel admin con un botón
-- "Procesar ahora".
-- ──────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

DO $$
BEGIN
  -- Intenta habilitar pg_cron — si no está disponible (no es un proyecto
  -- Supabase Cloud), salta sin error. La migración sigue funcionando.
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron no disponible en este proyecto. El worker IA tendrá que dispararse manualmente desde el panel admin.';
    RETURN;
  END;

  -- Borrar schedule previo si existe (idempotencia).
  PERFORM extensions.cron.unschedule('ai-grading-worker-hourly')
  WHERE EXISTS (
    SELECT 1 FROM extensions.cron.job WHERE jobname = 'ai-grading-worker-hourly'
  );

  -- Schedule cada hora en el minuto 5.
  PERFORM extensions.cron.schedule(
    'ai-grading-worker-hourly',
    '5 * * * *',
    format(
      $cron$
      SELECT extensions.net.http_post(
        url := %L,
        headers := %L::jsonb,
        body := %L::jsonb,
        timeout_milliseconds := 60000
      )
      $cron$,
      current_setting('app.settings.supabase_url', true) || '/functions/v1/ai-grading-worker',
      jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
      ),
      '{}'::jsonb
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Si current_setting falla porque las custom GUCs no están configuradas,
  -- registramos la advertencia y seguimos. El admin las puede setear con
  -- ALTER DATABASE postgres SET app.settings.supabase_url = '...';
  RAISE NOTICE 'Setup del cron del worker IA falló: %. Configurar manualmente las GUCs app.settings.supabase_url y app.settings.service_role_key.', SQLERRM;
END
$$;
