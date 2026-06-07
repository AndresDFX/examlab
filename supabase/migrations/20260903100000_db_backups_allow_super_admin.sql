-- ──────────────────────────────────────────────────────────────────────
-- db_backups: permitir SuperAdmin además de Admin.
--
-- Bug reportado: el SuperAdmin abría /app/admin/system → tab Backups y
-- recibía "Solo Admin puede consultar tablas para backup". Cuando se
-- introdujo el rol SuperAdmin (post mig 20260523100000), las policies
-- y RPCs de este módulo se quedaron solo con `has_role(_, 'Admin')`.
-- Por convención del proyecto (CLAUDE.md), SuperAdmin hereda lo
-- operativo de Admin — falta exponerlo acá.
--
-- Hay 6 puntos que actualizar:
--   - 2 storage policies (db_backups_storage_read_admin / _delete_admin)
--   - 1 RLS de db_backups (db_backups_admin_all)
--   - 3 RPCs (admin_list_backupable_tables, admin_enqueue_db_backup,
--     admin_delete_db_backup)
--
-- Patrón: reemplazar `public.has_role(auth.uid(), 'Admin')` por
--   `public.has_role(auth.uid(), 'Admin') OR public.is_super_admin()`.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) Storage policies ──
DROP POLICY IF EXISTS "db_backups_storage_read_admin" ON storage.objects;
CREATE POLICY "db_backups_storage_read_admin"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'db-backups'
    AND (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin())
  );

DROP POLICY IF EXISTS "db_backups_storage_delete_admin" ON storage.objects;
CREATE POLICY "db_backups_storage_delete_admin"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'db-backups'
    AND (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin())
  );

-- ── 2) Tabla db_backups RLS ──
-- to_regclass guard por si la migración corre en un entorno donde la
-- tabla aún no existe (mismo patrón defensivo del resto del repo).
DO $$
BEGIN
  IF to_regclass('public.db_backups') IS NOT NULL THEN
    DROP POLICY IF EXISTS "db_backups_admin_all" ON public.db_backups;
    CREATE POLICY "db_backups_admin_all"
      ON public.db_backups FOR ALL TO authenticated
      USING (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin())
      WITH CHECK (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin());
  END IF;
END $$;

-- ── 3) RPC: admin_list_backupable_tables ──
CREATE OR REPLACE FUNCTION public.admin_list_backupable_tables()
RETURNS TABLE (table_name TEXT, est_rows BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Solo Admin o SuperAdmin puede consultar tablas para backup';
  END IF;

  RETURN QUERY
  SELECT
    c.relname::TEXT AS table_name,
    c.reltuples::BIGINT AS est_rows
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname NOT IN (
      'db_backups',
      'attendance_check_in_state'
    )
  ORDER BY c.relname;
END
$$;

REVOKE ALL ON FUNCTION public.admin_list_backupable_tables() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_backupable_tables() TO authenticated;

-- ── 4) RPC: admin_enqueue_db_backup ──
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
  IF NOT (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Solo Admin o SuperAdmin puede crear backups';
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

-- ── 5) RPC: admin_delete_db_backup ──
CREATE OR REPLACE FUNCTION public.admin_delete_db_backup(_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _path TEXT;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Solo Admin o SuperAdmin puede borrar backups';
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
