-- ════════════════════════════════════════════════════════════════════
-- Correctiva: recrear cron jobs Tipo B que fallaron silenciosamente.
--
-- Contexto: 5 migraciones previas usaron `extensions.cron.schedule(...)`
-- como nombre de la función. Postgres lo lee como 3-part name
-- (`database.schema.function`) → "cross-database references are not
-- implemented" → la llamada lanza error → atrapado por `EXCEPTION WHEN
-- OTHERS THEN RAISE NOTICE` del DO block → silenciosa.
--
-- En este proyecto Supabase, pg_cron expone sus funciones en el schema
-- `cron` (verificado: `SELECT n.nspname FROM pg_proc p JOIN pg_namespace
-- n ON ... WHERE proname = 'schedule'` → `cron`). Las migraciones
-- correctas históricamente usan `cron.schedule(...)` (sin prefijo
-- `extensions.`). Las rotas se quedaron a mitad de camino.
--
-- Resultado: 5 cron jobs Tipo B nunca llegaron a registrarse, y 2 jobs
-- viejos que la mig 20260980 quería des-agendar siguen vivos.
--
-- ALCANCE INTENCIONAL — no incluye los jobs Tipo A (workers que drenan
-- colas IA: ai-grading-worker-hourly, ai-generation-worker-hourly).
-- Decisión de producto: la cola IA se drena SOLO cuando un usuario
-- clickea "Procesar ahora" desde el panel, no automáticamente. Si en
-- el futuro se quiere drain automático, agregar acá.
--
-- Idempotente: cada paso chequea existence antes. Re-correr es seguro.
-- ════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  -- Sanity: salir limpio si pg_cron no está disponible.
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    RAISE NOTICE 'Schema "cron" no existe — pg_cron no instalado. Salida limpia.';
    RETURN;
  END IF;

  -- ── 1) Des-agendar los OBSOLETOS (reemplazados por workshop/project-due-reminder) ──
  -- La mig 20260980 los quiso quitar pero falló por el bug de schema.
  PERFORM cron.unschedule('workshop-due-24h')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'workshop-due-24h');
  PERFORM cron.unschedule('project-due-24h')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'project-due-24h');

  -- ── 2) db-backup-weekly (origen mig 20260523100000 / 20260603170000) ──
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'db-backup-weekly') THEN
    PERFORM cron.schedule(
      'db-backup-weekly',
      '5 3 * * 0',
      $cron$ SELECT public._cron_run_weekly_db_backup(); $cron$
    );
  END IF;

  -- ── 3) calendar-recordings-sync-6h (origen mig 20260940000000) ──
  -- Sincroniza grabaciones de Google/Microsoft Calendar a las sesiones.
  -- Depende de GUCs `app.settings.supabase_url` y
  -- `app.settings.service_role_key` (las setea Lovable en el proyecto).
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'calendar-recordings-sync-6h') THEN
    PERFORM cron.schedule(
      'calendar-recordings-sync-6h',
      '30 */6 * * *',
      format(
        $cron$
        SELECT extensions.net.http_post(
          url := %L,
          headers := %L::jsonb,
          body := %L::jsonb,
          timeout_milliseconds := 120000
        )
        $cron$,
        current_setting('app.settings.supabase_url', true) || '/functions/v1/calendar',
        jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
        ),
        jsonb_build_object('action', 'cron_sync_recordings')
      )
    );
  END IF;

  -- ── 4) auto-finalize-courses-daily (origen mig 20260964000000) ──
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-finalize-courses-daily') THEN
    PERFORM cron.schedule(
      'auto-finalize-courses-daily',
      '0 4 * * *',
      $cron$ SELECT public.auto_finalize_courses(); $cron$
    );
  END IF;

  -- ── 5) workshop-due-reminder (origen mig 20260980000000) ──
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'workshop-due-reminder') THEN
    PERFORM cron.schedule(
      'workshop-due-reminder',
      '*/15 * * * *',
      $cron$ SELECT public.notify_students_workshop_due_soon(); $cron$
    );
  END IF;

  -- ── 6) project-due-reminder (origen mig 20260980000000) ──
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'project-due-reminder') THEN
    PERFORM cron.schedule(
      'project-due-reminder',
      '*/15 * * * *',
      $cron$ SELECT public.notify_students_project_due_soon(); $cron$
    );
  END IF;

  -- ── 7) dispatch-scheduled-messages (origen mig 20260709000000) ──
  -- Re-defensivo: el SuperAdmin ya lo creó manualmente desde el SQL
  -- Editor antes de esta migración, pero el guard `IF NOT EXISTS`
  -- garantiza que en un entorno nuevo (preview / DB reset) esta mig
  -- también lo deja en pie sin depender del paso manual.
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-scheduled-messages') THEN
    PERFORM cron.schedule(
      'dispatch-scheduled-messages',
      '* * * * *',
      $cron$ SELECT public.dispatch_scheduled_messages(); $cron$
    );
  END IF;
END
$$;

-- Re-seed de las descripciones humanas en el panel de Cron del SuperAdmin
-- por si alguna se perdió o quedó stale. ON CONFLICT mantiene el texto
-- actualizado.
INSERT INTO public.cron_job_descriptions (jobname, description)
VALUES
  ('db-backup-weekly',
   'Cada domingo a las 03:05 UTC: crea un backup completo de la DB.'),
  ('calendar-recordings-sync-6h',
   'Cada 6 horas: para los docentes con calendario conectado, trae automáticamente las grabaciones, notas y enlaces de Google/Microsoft Calendar a las sesiones ya vinculadas (últimos 45 días).'),
  ('auto-finalize-courses-daily',
   'Cada día a las 04:00 UTC: marca como Finalizado los cursos En curso cuya fecha de fin ya pasó. Un curso finalizado o reabierto manualmente respeta la acción del docente/admin.'),
  ('workshop-due-reminder',
   'Cada 15 minutos: notifica a los alumnos sobre talleres que vencen dentro de la ventana parametrizada (ver `due_reminder_lead`). Reemplaza al viejo workshop-due-24h.'),
  ('project-due-reminder',
   'Cada 15 minutos: notifica a los alumnos sobre proyectos que vencen dentro de la ventana parametrizada. Reemplaza al viejo project-due-24h.'),
  ('dispatch-scheduled-messages',
   'Cada minuto: envía mensajes programados (directos y de difusión) cuya fecha de envío ya pasó.')
ON CONFLICT (jobname) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at = now();

NOTIFY pgrst, 'reload schema';
