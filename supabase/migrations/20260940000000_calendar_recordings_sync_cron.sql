-- ──────────────────────────────────────────────────────────────────────
-- Tarea programada: sincronización automática de grabaciones de Calendar.
--
-- Para TODOS los docentes con calendario conectado (filas en
-- `teacher_google_tokens`), recorre las sesiones ya vinculadas a un evento
-- (`attendance_sessions.google_event_id` set) de los últimos ~45 días y
-- re-consulta el evento en Google/Microsoft, actualizando
-- `recording_url` / `notes_url` / `meeting_url` cuando el evento los expone
-- (las grabaciones de Meet se adjuntan al evento POCO DESPUÉS de la clase).
--
-- Así el alumno ve la grabación en su tablero sin que el docente entre
-- manualmente a "Vincular eventos". Combinado con el front, una sesión que
-- ya tiene grabación deja de mostrar el botón "Unirse" (la clase ya pasó).
--
-- El trabajo real lo hace el edge `calendar` con la acción
-- `cron_sync_recordings` (autenticada con el service_role key; la edge es
-- verify_jwt=false y valida internamente). Corre cada 6 horas.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron no disponible: la sincronización de grabaciones tendrá que dispararse manualmente.';
    RETURN;
  END;

  -- Idempotencia: borrar schedule previo si existe.
  PERFORM extensions.cron.unschedule('calendar-recordings-sync-6h')
  WHERE EXISTS (
    SELECT 1 FROM extensions.cron.job WHERE jobname = 'calendar-recordings-sync-6h'
  );

  PERFORM extensions.cron.schedule(
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
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Setup del cron de sync de grabaciones falló: %. Configurar manualmente las GUCs app.settings.supabase_url y app.settings.service_role_key.', SQLERRM;
END
$$;

-- Descripción humana para el panel SuperAdmin → Tareas programadas.
INSERT INTO public.cron_job_descriptions (jobname, description)
VALUES (
  'calendar-recordings-sync-6h',
  'Cada 6 horas: para los docentes con calendario conectado, trae automáticamente las grabaciones, notas y enlaces de Google/Microsoft Calendar a las sesiones ya vinculadas (últimos 45 días).'
)
ON CONFLICT (jobname) DO UPDATE SET description = EXCLUDED.description, updated_at = now();
