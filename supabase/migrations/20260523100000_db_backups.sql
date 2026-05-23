-- ──────────────────────────────────────────────────────────────────────
-- Backups lógicos de la base de datos (snapshots por tabla → ZIP).
--
-- Contexto:
--   Lovable gestiona Supabase y el Admin no tiene acceso al dashboard
--   para disparar backups nativos. Este módulo agrega snapshots lógicos
--   gestionables desde la UI:
--     · `db_backups` — tabla de control de cada snapshot.
--     · Bucket `db-backups` privado en Storage para los archivos ZIP.
--     · Edge function `db-backup-runner` lee la fila, exporta cada tabla
--       a JSON y sube el ZIP al bucket.
--     · pg_cron semanal (domingos 03:05 UTC) crea un snapshot automático
--       con TODAS las tablas para tener un fallback siempre fresco.
--     · La UI permite al Admin crear backups manuales eligiendo tablas,
--       descargarlos y borrarlos. NO se restaura desde UI — el admin
--       descarga el ZIP y restaura manualmente vía SQL si hace falta.
--
-- Diseño:
--   - `tables` es text[] — la lista de tablas a respaldar. La UI deja
--     elegir, el cron usa la lista canónica (admin_list_backupable_tables).
--   - `status` sigue el mismo vocabulario que `ai_grading_queue`
--     (queued/running/done/failed/cancelled) para reutilizar mental model.
--   - `file_path` apunta al objeto en el bucket. NULL hasta que la edge
--     suba el ZIP. El bucket es privado: descarga vía signed URL.
--   - `source` distingue manual vs cron — útil para retención (mantener
--     los últimos N manuales + N cron por separado, ver script de
--     limpieza más abajo).
-- ──────────────────────────────────────────────────────────────────────

-- ─── 1) Bucket privado `db-backups` ───────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'db-backups',
  'db-backups',
  false,
  -- 2GB — los snapshots de ExamLab raramente pasan de 100MB pero damos
  -- margen para crecer sin tener que migrar el bucket.
  2147483648,
  ARRAY['application/zip', 'application/octet-stream']
) ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Policies: SOLO Admin lee/borra. El INSERT lo hace el edge con
-- service_role (no aplica policy). UPDATE no aplica (los objetos son
-- inmutables; si se quiere reemplazar se borra + sube nuevo).
DROP POLICY IF EXISTS "db_backups_storage_read_admin" ON storage.objects;
CREATE POLICY "db_backups_storage_read_admin"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'db-backups' AND public.has_role(auth.uid(), 'Admin'));

DROP POLICY IF EXISTS "db_backups_storage_delete_admin" ON storage.objects;
CREATE POLICY "db_backups_storage_delete_admin"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'db-backups' AND public.has_role(auth.uid(), 'Admin'));

-- ─── 2) Tabla de control `db_backups` ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.db_backups (
  id           UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  label        TEXT,
  tables       TEXT[] NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('manual', 'cron')),
  status       TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled'))
                DEFAULT 'queued',
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  -- Path dentro del bucket `db-backups`. NULL hasta que el edge sube.
  file_path    TEXT,
  size_bytes   BIGINT,
  -- Conteo agregado de filas en TODAS las tablas — útil para detectar
  -- backups truncados (e.g. uno con 0 filas suele ser síntoma de fallo).
  row_count    BIGINT,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_db_backups_created_at
  ON public.db_backups (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_db_backups_status
  ON public.db_backups (status) WHERE status IN ('queued', 'running');

COMMENT ON TABLE public.db_backups IS
  'Snapshots lógicos de la BD (exportación por tabla → ZIP en bucket db-backups). Una fila por backup; el archivo en sí vive en Storage.';

-- RLS: solo Admin
ALTER TABLE public.db_backups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "db_backups_admin_all" ON public.db_backups;
CREATE POLICY "db_backups_admin_all"
  ON public.db_backups FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Admin'));

-- ─── 3) RPC: lista de tablas respaldables ─────────────────────────────
-- Devuelve las tablas en schema `public` que tienen sentido respaldar.
-- Excluye:
--   - La propia `db_backups` (auto-referencia sin valor; lo importante
--     son los archivos en Storage, no este control plane).
--   - Tablas vacías o de cache temporal (e.g. `attendance_check_in_state`
--     — codes TOTP-rotativos, no aporta backup).
-- Si en el futuro hay tablas que se quieren excluir explícitamente,
-- agregar a la condición NOT IN.
CREATE OR REPLACE FUNCTION public.admin_list_backupable_tables()
RETURNS TABLE (table_name TEXT, est_rows BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'Admin') THEN
    RAISE EXCEPTION 'Solo Admin puede consultar tablas para backup';
  END IF;

  RETURN QUERY
  SELECT
    c.relname::TEXT AS table_name,
    c.reltuples::BIGINT AS est_rows
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'  -- ordinary tables
    AND c.relname NOT IN (
      'db_backups',
      'attendance_check_in_state'
    )
  ORDER BY c.relname;
END
$$;

REVOKE ALL ON FUNCTION public.admin_list_backupable_tables() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_backupable_tables() TO authenticated;

-- ─── 4) RPC: encolar un backup manual ─────────────────────────────────
-- El cliente (panel admin) llama esto para crear la fila `queued` y
-- luego invoca el edge function `db-backup-runner` con el id.
-- Validación: solo Admin, lista de tablas no vacía.
CREATE OR REPLACE FUNCTION public.admin_enqueue_db_backup(
  _tables TEXT[],
  _label TEXT DEFAULT NULL,
  _source TEXT DEFAULT 'manual'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _id UUID;
BEGIN
  IF NOT public.has_role(auth.uid(), 'Admin') THEN
    RAISE EXCEPTION 'Solo Admin puede crear backups';
  END IF;
  IF _tables IS NULL OR array_length(_tables, 1) IS NULL OR array_length(_tables, 1) = 0 THEN
    RAISE EXCEPTION 'Debes elegir al menos una tabla';
  END IF;
  IF _source NOT IN ('manual', 'cron') THEN
    RAISE EXCEPTION 'source debe ser manual o cron';
  END IF;

  INSERT INTO public.db_backups (tables, label, source, status, created_by)
  VALUES (_tables, _label, _source, 'queued', auth.uid())
  RETURNING id INTO _id;

  RETURN _id;
END
$$;

REVOKE ALL ON FUNCTION public.admin_enqueue_db_backup(TEXT[], TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_enqueue_db_backup(TEXT[], TEXT, TEXT) TO authenticated;

-- ─── 5) RPC: borrar backup (fila + archivo en Storage) ────────────────
-- Borrar la fila NO borra automáticamente el objeto en Storage; lo
-- hacemos en una sola transacción acá para que la UI no quede con un
-- ZIP huérfano que ocupa espacio sin estar referenciado.
CREATE OR REPLACE FUNCTION public.admin_delete_db_backup(_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _path TEXT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'Admin') THEN
    RAISE EXCEPTION 'Solo Admin puede borrar backups';
  END IF;

  SELECT file_path INTO _path FROM public.db_backups WHERE id = _id;
  IF _path IS NOT NULL THEN
    DELETE FROM storage.objects WHERE bucket_id = 'db-backups' AND name = _path;
  END IF;
  DELETE FROM public.db_backups WHERE id = _id;
END
$$;

REVOKE ALL ON FUNCTION public.admin_delete_db_backup(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_db_backup(UUID) TO authenticated;

-- ─── 6) Cron semanal: backup automático completo ──────────────────────
-- Función que lista todas las tablas respaldables y crea + dispara la
-- edge. Llamada por pg_cron una vez por semana (domingo 03:05 UTC).
-- La función corre como SECURITY DEFINER pero internamente NO checkea
-- has_role — la llama el cron, no un user. Por eso bypasea el check
-- de `admin_enqueue_db_backup` haciendo el INSERT directo.
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
BEGIN
  -- Construir la lista de tablas respaldables sin pasar por
  -- admin_list_backupable_tables (esa tiene check de role).
  SELECT array_agg(c.relname ORDER BY c.relname)
    INTO _tables
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relname NOT IN ('db_backups', 'attendance_check_in_state');

  IF _tables IS NULL OR array_length(_tables, 1) = 0 THEN
    RAISE NOTICE 'No hay tablas para respaldar';
    RETURN;
  END IF;

  INSERT INTO public.db_backups (tables, label, source, status, created_by)
  VALUES (_tables, 'Auto (semanal)', 'cron', 'queued', NULL)
  RETURNING id INTO _id;

  -- Disparar la edge function vía pg_net. Si las custom GUCs no están
  -- configuradas el job queda en 'queued' y el admin puede invocarlo
  -- manualmente desde la UI con "Procesar ahora" (mismo patrón que el
  -- worker IA).
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
        timeout_milliseconds := 300000  -- 5 min: backups pueden tardar
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'No se pudo disparar la edge function: %', SQLERRM;
  END;
END
$$;

REVOKE ALL ON FUNCTION public._cron_run_weekly_db_backup() FROM PUBLIC;
-- No GRANT a authenticated — solo se llama desde pg_cron (que corre como
-- postgres superuser).

-- ─── 7) pg_cron schedule semanal ──────────────────────────────────────
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron no disponible. Los backups automáticos no correrán; usa el botón "Crear backup" desde la UI.';
    RETURN;
  END;

  PERFORM extensions.cron.unschedule('db-backup-weekly')
  WHERE EXISTS (
    SELECT 1 FROM extensions.cron.job WHERE jobname = 'db-backup-weekly'
  );

  -- Domingo 03:05 UTC — coincide con baja actividad y NO choca con
  -- ai-grading-worker-hourly (que corre minuto :05 cada hora; 03:05 sí
  -- choca pero pg_cron serializa por job, no por minuto, así que OK).
  PERFORM extensions.cron.schedule(
    'db-backup-weekly',
    '5 3 * * 0',
    $cron$ SELECT public._cron_run_weekly_db_backup(); $cron$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Setup del cron de backups falló: %', SQLERRM;
END
$$;

-- Descripción para el módulo Cron (la UI muestra `description` junto
-- al schedule en SupabaseCronPanel).
INSERT INTO public.cron_job_descriptions (jobname, description)
VALUES (
  'db-backup-weekly',
  'Snapshot lógico semanal de toda la BD. Llama a la edge function db-backup-runner los domingos 03:05 UTC.'
) ON CONFLICT (jobname) DO UPDATE SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';
