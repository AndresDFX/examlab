-- ──────────────────────────────────────────────────────────────────────
-- Re-seed del cron semanal de backups (`db-backup-weekly`).
--
-- En la migración 20260523100000 ya se creó el schedule, pero quedó
-- envuelto en un bloque `DO $$ ... EXCEPTION WHEN OTHERS THEN NOTICE END $$`
-- que silencia errores. Si pg_cron no estaba habilitado en el primer
-- intento o el helper `_cron_run_weekly_db_backup()` no se creó por una
-- falla en la migración madre, el `cron.schedule` nunca llegó a inscribir
-- el job y por eso no aparece en el panel "Tareas programadas".
--
-- Esta migración:
--   1) Garantiza que existe la función `_cron_run_weekly_db_backup()`
--      (idempotente con `CREATE OR REPLACE`).
--   2) Garantiza el schedule `db-backup-weekly` (unschedule previo + alta).
--   3) Asegura la descripción humana en `cron_job_descriptions`.
--
-- Es seguro re-aplicar: todas las operaciones son `OR REPLACE` /
-- `unschedule + schedule` / `ON CONFLICT DO UPDATE`. Si pg_cron sigue sin
-- estar disponible en el entorno, el bloque DO levanta un NOTICE y la
-- migración pasa sin abortar.
-- ──────────────────────────────────────────────────────────────────────

-- ─── 1) Helper SQL llamado por el cron ───────────────────────────────
-- Re-creamos la función incluso si ya existe. Sin esta función el job
-- corre hacia nada y el `pg_net.http_post` falla silenciosamente.
-- Usa `IF EXISTS public.db_backups` defensivamente — si la tabla no
-- existe (migración 20260523100000 no se aplicó nunca), el cron no
-- inserta y simplemente loguea. Mejor que un trigger que rompe.
CREATE OR REPLACE FUNCTION public._cron_run_weekly_db_backup()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _tables TEXT[];
  _id UUID;
  _supabase_url TEXT;
  _service_key TEXT;
  _table_exists BOOLEAN;
BEGIN
  -- Guard: si la tabla de control aún no existe (migración 20260523100000
  -- pendiente o fallida), no intentar inserción.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'db_backups'
  ) INTO _table_exists;
  IF NOT _table_exists THEN
    RAISE NOTICE '_cron_run_weekly_db_backup: tabla db_backups no existe — saltando';
    RETURN;
  END IF;

  -- Lista canónica de tablas respaldables. Misma exclusión que la RPC
  -- `admin_list_backupable_tables`.
  SELECT array_agg(c.relname ORDER BY c.relname)
    INTO _tables
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relname NOT IN ('db_backups', 'attendance_check_in_state');

  IF _tables IS NULL OR array_length(_tables, 1) = 0 THEN
    RAISE NOTICE '_cron_run_weekly_db_backup: no hay tablas para respaldar';
    RETURN;
  END IF;

  INSERT INTO public.db_backups (tables, label, source, status, created_by)
  VALUES (_tables, 'Auto (semanal)', 'cron', 'queued', NULL)
  RETURNING id INTO _id;

  -- Dispara la edge function vía pg_net. Si las GUCs no están
  -- configuradas o pg_net no está instalado, el job queda en 'queued'
  -- y el admin puede drenarlo manualmente desde el módulo Cola.
  BEGIN
    _supabase_url := current_setting('app.settings.supabase_url', true);
    _service_key := current_setting('app.settings.service_role_key', true);
    IF _supabase_url IS NOT NULL AND _service_key IS NOT NULL THEN
      PERFORM extensions.net.http_post(
        url := _supabase_url || '/functions/v1/db-backup-runner',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || _service_key
        ),
        body := jsonb_build_object('backupId', _id),
        timeout_milliseconds := 300000
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'No se pudo disparar db-backup-runner: %', SQLERRM;
  END;
END
$$;

REVOKE ALL ON FUNCTION public._cron_run_weekly_db_backup() FROM PUBLIC;

-- ─── 2) Schedule en pg_cron ──────────────────────────────────────────
-- Domingo 03:05 UTC. Unschedule defensivo evita "ya existe job con ese
-- nombre" si la migración 20260523100000 sí lo registró.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron no disponible en este entorno. db-backup-weekly se omite.';
    RETURN;
  END;

  PERFORM extensions.cron.unschedule('db-backup-weekly')
  WHERE EXISTS (
    SELECT 1 FROM extensions.cron.job WHERE jobname = 'db-backup-weekly'
  );

  PERFORM extensions.cron.schedule(
    'db-backup-weekly',
    '5 3 * * 0',
    $cron$ SELECT public._cron_run_weekly_db_backup(); $cron$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Setup del cron db-backup-weekly falló: %', SQLERRM;
END
$$;

-- ─── 3) Descripción humana ───────────────────────────────────────────
-- Cubre el caso donde la tabla `cron_job_descriptions` existe pero la
-- fila para `db-backup-weekly` no se insertó (migración madre falló
-- antes del INSERT). Idempotente con ON CONFLICT.
INSERT INTO public.cron_job_descriptions (jobname, description)
VALUES (
  'db-backup-weekly',
  'Snapshot lógico semanal de toda la BD (todas las tablas públicas → ZIP en Storage bucket `db-backups`). Llama a la edge function `db-backup-runner` los domingos 03:05 UTC. Pausarlo NO afecta los backups manuales que el admin dispare desde Configuración → Backups.'
) ON CONFLICT (jobname) DO UPDATE SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';
