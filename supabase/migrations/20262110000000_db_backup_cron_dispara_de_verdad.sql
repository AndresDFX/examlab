-- ──────────────────────────────────────────────────────────────────────
-- El respaldo semanal de la base lleva 105 días sin ejecutarse, en silencio.
--
-- Medido contra producción el 2026-09-05: `db_backups` tiene ONCE filas
-- consecutivas en `status='queued'` —del 2026-06-21 al 2026-08-30, una por
-- semana— con `error` en NULL, `started_at` en NULL y `completed_at` en NULL.
-- El último respaldo que de verdad existe es del 2026-05-24. Un sistema con
-- datos de 163 estudiantes reales lleva tres meses y medio sin copia, y nada
-- lo dijo: ni un error, ni un aviso, ni una fila en rojo.
--
-- ── Por qué nunca corrió ──────────────────────────────────────────────
-- `_cron_run_weekly_db_backup()` (mig 20260603170000) encola bien la fila y
-- después intenta disparar el edge, con DOS fallas que se tapan entre sí:
--
--   1. Llama a `extensions.net.http_post`. pg_net vive en el schema `net`, y
--      esa forma de tres partes Postgres la lee como base.schema.funcion, así
--      que responde «cross-database references are not implemented» y LANZA.
--      Es el mismo anti-patrón que la mig 20261660000000 ya documentó y
--      arregló para el worker de generación de IA.
--
--   2. Resuelve la URL y la credencial con `current_setting('app.settings.*')`.
--      En Supabase Cloud esas GUCs no se pueden fijar (`ALTER DATABASE ... SET`
--      pide superuser), y por eso el proyecto guarda esa configuración en la
--      tabla `private.app_settings` — que es de donde las lee el trigger de
--      correo, el único camino pg_net que demostrablemente funciona en esta
--      base. Con las GUCs vacías el `IF` no entra y no se dispara nada.
--
-- Y las dos quedan dentro de un `EXCEPTION WHEN OTHERS THEN RAISE NOTICE`, que
-- convierte cualquiera de ellas en un mensaje que nadie lee. La fila se queda
-- en `queued` para siempre y el panel muestra una cola que jamás se drena.
--
-- ── Qué cambia ────────────────────────────────────────────────────────
--   · Se llama `net.http_post` (dos partes), como el trigger de correo.
--   · La configuración sale de `private.app_settings`, con las GUCs sólo como
--     último recurso para entornos self-hosted que sí las tengan.
--   · **Un fallo deja de ser silencio**: si falta la configuración o el POST
--     lanza, la fila pasa a `status='failed'` con el motivo en `error`, y se
--     escribe un `warning` en `audit_logs`. Que el respaldo no corra puede
--     pasar; que no se sepa, no.
--
-- Verificado antes de escribir esto: encolando por `admin_enqueue_db_backup` e
-- invocando el edge a mano, el respaldo se completa —130 tablas, 45.161 filas,
-- 2,08 MB—. O sea que el edge, las credenciales y el Storage están bien; lo
-- único roto era la llamada del cron.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._cron_run_weekly_db_backup()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _tables       TEXT[];
  _id           UUID;
  _url          TEXT;
  _key          TEXT;
  _table_exists BOOLEAN;
  _net_exists   BOOLEAN;
  _falta        TEXT;
BEGIN
  -- Guard: si la tabla de control no existe (migración pendiente o fallida),
  -- no intentar nada.
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

  -- ── Configuración: la tabla privada primero, las GUCs como último recurso ──
  -- El orden importa. En Supabase Cloud las GUCs están siempre vacías, así que
  -- consultarlas primero (como hacía la versión vieja) equivale a no tener
  -- configuración nunca.
  IF to_regclass('private.app_settings') IS NOT NULL THEN
    SELECT value INTO _url FROM private.app_settings WHERE key = 'supabase_url';
    SELECT value INTO _key FROM private.app_settings WHERE key = 'service_role_key';
  END IF;
  IF _url IS NULL OR _url = '' THEN
    _url := NULLIF(current_setting('app.settings.supabase_url', true), '');
  END IF;
  IF _key IS NULL OR _key = '' THEN
    _key := NULLIF(current_setting('app.settings.service_role_key', true), '');
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') INTO _net_exists;

  IF NOT _net_exists OR _url IS NULL OR _url = '' OR _key IS NULL OR _key = '' THEN
    _falta := CASE
                WHEN NOT _net_exists THEN 'la extensión pg_net'
                WHEN (_url IS NULL OR _url = '') AND (_key IS NULL OR _key = '')
                  THEN 'supabase_url y service_role_key en private.app_settings'
                WHEN (_url IS NULL OR _url = '') THEN 'supabase_url en private.app_settings'
                ELSE 'service_role_key en private.app_settings'
              END;
    -- La fila NO se queda en 'queued': eso es exactamente lo que escondió el
    -- problema durante once semanas.
    UPDATE public.db_backups
       SET status = 'failed',
           error  = 'El cron no pudo invocar db-backup-runner: falta ' || _falta ||
                    '. El respaldo NO se ejecutó.'
     WHERE id = _id;
    BEGIN
      INSERT INTO public.audit_logs (action, severity, metadata)
      VALUES (
        'db_backup.cron_not_configured',
        'warning',
        jsonb_build_object('backup_id', _id, 'falta', _falta)
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'db_backup.cron_not_configured no se pudo auditar: %', SQLERRM;
    END;
    RETURN;
  END IF;

  BEGIN
    -- `net.http_post` (dos partes). `extensions.net.http_post` LANZA con
    -- «cross-database references are not implemented» — ver la cabecera.
    PERFORM net.http_post(
      url := _url || '/functions/v1/db-backup-runner',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || _key
      ),
      body := jsonb_build_object('backupId', _id),
      timeout_milliseconds := 300000
    );
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.db_backups
       SET status = 'failed',
           error  = 'El cron no pudo invocar db-backup-runner: ' || SQLERRM
     WHERE id = _id;
    BEGIN
      INSERT INTO public.audit_logs (action, severity, metadata)
      VALUES (
        'db_backup.cron_dispatch_failed',
        'error',
        jsonb_build_object('backup_id', _id, 'error', SQLERRM)
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'db_backup.cron_dispatch_failed no se pudo auditar: %', SQLERRM;
    END;
  END;
END
$$;

REVOKE ALL ON FUNCTION public._cron_run_weekly_db_backup() FROM PUBLIC;

-- ─── Las once filas fantasma ──────────────────────────────────────────
-- Quedaron en 'queued' sin haber corrido nunca. Dejarlas así hace que el panel
-- muestre una cola pendiente que nadie va a drenar, y que el hueco siga
-- pareciendo un atraso en vez de una falla. Se marcan como lo que son, con el
-- motivo escrito. Sólo las que llevan más de 7 días: una recién encolada puede
-- estar corriendo de verdad.
DO $$
BEGIN
  IF to_regclass('public.db_backups') IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.db_backups
     SET status = 'failed',
         error  = 'Nunca se ejecutó: el cron encolaba la fila pero su llamada al edge '
                  || 'fallaba en silencio (extensions.net.http_post + GUCs vacías). '
                  || 'Corregido en la migración 20262110000000.'
   WHERE status = 'queued'
     AND started_at IS NULL
     AND created_at < NOW() - INTERVAL '7 days';
END
$$;
