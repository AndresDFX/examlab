-- ══════════════════════════════════════════════════════════════════════
-- db_backups: cerrar la autz server-side a SuperAdmin (paridad con la UI + cron).
--
-- La feature de backups es PLATAFORMA-WIDE (bucket/tabla sin tenant_id; exporta
-- TODAS las tablas de todos los tenants). La UI (DbBackupsPanel) ya se movió a
-- /app/superadmin/system, pero la autz server-side quedó en
-- `has_role('Admin') OR is_super_admin()` — y has_role es GLOBAL (sin scope de
-- tenant), así que CUALQUIER Admin de tenant pasa. Las policies de STORAGE ya se
-- endurecieron a is_super_admin() (la descarga del ZIP ya estaba bloqueada), pero
-- un Admin todavía podía: enumerar todas las tablas, ENCOLAR backups de toda la
-- plataforma (DoS/recursos), y BORRAR los backups del SA (admin_delete_db_backup
-- borra el objeto de storage vía SECURITY DEFINER, saltando la policy SA-only).
--
-- Fix: alinear las 3 RPCs + la RLS de db_backups a SuperAdmin-only, igual que se
-- hizo con cron (mig 20260825000000: "pg_cron es infraestructura CROSS-TENANT").
-- El edge db-backup-runner se endurece aparte (deja de aceptar el rol Admin).
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.admin_list_backupable_tables()
 RETURNS TABLE(table_name text, est_rows bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Solo SuperAdmin puede consultar tablas para backup (infra cross-tenant)';
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
$function$;

CREATE OR REPLACE FUNCTION public.admin_enqueue_db_backup(_tables text[], _label text DEFAULT NULL::text, _source text DEFAULT 'manual'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _id UUID;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Solo SuperAdmin puede crear backups (infra cross-tenant)';
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
$function$;

CREATE OR REPLACE FUNCTION public.admin_delete_db_backup(_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _path TEXT;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Solo SuperAdmin puede borrar backups (infra cross-tenant)';
  END IF;

  SELECT file_path INTO _path FROM public.db_backups WHERE id = _id;
  IF _path IS NOT NULL THEN
    DELETE FROM storage.objects WHERE bucket_id = 'db-backups' AND name = _path;
  END IF;
  DELETE FROM public.db_backups WHERE id = _id;
END
$function$;

-- RLS de la tabla db_backups → SuperAdmin only (la lista/estado del panel SA).
DO $$
BEGIN
  IF to_regclass('public.db_backups') IS NOT NULL THEN
    ALTER POLICY db_backups_admin_all ON public.db_backups
      USING (public.is_super_admin())
      WITH CHECK (public.is_super_admin());
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
