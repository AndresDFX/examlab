-- ──────────────────────────────────────────────────────────────────────
-- Papelera: extensión del soft-delete a la tabla `tenants`.
--
-- Antes: la tabla `tenants` no soportaba eliminación reversible. Borrar
-- una institución era irreversible (DELETE físico con cascade hacia
-- courses, profiles, etc.) — situación demasiado peligrosa para que el
-- SuperAdmin pueda invocarla con un clic.
--
-- Ahora: agregamos `deleted_at` + `deleted_by` a tenants y dos RPCs:
--   - `soft_delete_tenant(_id)`: marca el tenant + cascadea soft-delete
--     a las 8 entidades trashables (mismo timestamp). Los profiles NO
--     se tocan: mantienen su `tenant_id` pero quedan sin acceso porque
--     el selector de institución en /auth filtra `deleted_at IS NULL`.
--   - `restore_tenant(_id)`: restaura el tenant + sus children que
--     fueron soft-deleted CON EL MISMO timestamp. Si un curso fue
--     borrado individualmente antes (timestamp distinto), no se
--     restaura por esta vía — el SuperAdmin debe restaurarlo manual
--     desde la papelera.
--   - `hard_delete_tenant(_id)`: DELETE físico (cascade real via FKs).
--     Solo aplicable sobre tenants ya en papelera.
--
-- La purge automática (`purge_deleted_items`) se extiende para incluir
-- tenants — tras 30d, hard-delete con cascade.
--
-- Autorización: solo SuperAdmin (validado dentro de cada RPC con
-- SECURITY DEFINER). Las RPCs grant EXECUTE TO authenticated; el check
-- de rol bloquea a no-SuperAdmin.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) Columnas en tenants ──
DO $$
BEGIN
  IF to_regclass('public.tenants') IS NOT NULL THEN
    ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE public.tenants
      ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_tenants_deleted_at
      ON public.tenants(deleted_at) WHERE deleted_at IS NOT NULL;
  ELSE
    RAISE NOTICE 'Tabla public.tenants no existe — se omite la migración';
  END IF;
END $$;

-- ── 2) RPC soft_delete_tenant ──
-- Cascadea el UPDATE deleted_at/deleted_by al tenant + 8 entidades
-- trashables. Usa el MISMO timestamp para todo (necesario para que
-- restore_tenant pueda identificar qué cascadeó esta operación).
--
-- SECURITY DEFINER porque el caller (SuperAdmin) puede no tener UPDATE
-- directo sobre todas las tablas (RLS de course-teacher, etc.). El
-- check de rol al inicio es la única autorización.
DROP FUNCTION IF EXISTS public.soft_delete_tenant(UUID);
CREATE OR REPLACE FUNCTION public.soft_delete_tenant(_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_is_super BOOLEAN;
  v_ts TIMESTAMPTZ := now();
  v_tenant_exists BOOLEAN;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = 'P0001';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = v_caller AND role = 'SuperAdmin'
  ) INTO v_is_super;

  IF NOT v_is_super THEN
    RAISE EXCEPTION 'Solo SuperAdmin puede eliminar instituciones' USING ERRCODE = 'P0001';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = _tenant_id AND deleted_at IS NULL
  ) INTO v_tenant_exists;

  IF NOT v_tenant_exists THEN
    RAISE EXCEPTION 'La institución no existe o ya está eliminada' USING ERRCODE = 'P0001';
  END IF;

  -- Marcar el tenant.
  UPDATE public.tenants
     SET deleted_at = v_ts, deleted_by = v_caller
   WHERE id = _tenant_id;

  -- Cascada (mismo timestamp para identificar la operación al restaurar).
  -- Solo tocamos filas con deleted_at IS NULL para no pisar timestamps
  -- previos (si un curso ya estaba en papelera por borrado individual,
  -- mantiene su deleted_at original).
  IF to_regclass('public.courses') IS NOT NULL THEN
    UPDATE public.courses
       SET deleted_at = v_ts, deleted_by = v_caller
     WHERE tenant_id = _tenant_id AND deleted_at IS NULL;
  END IF;

  -- Tablas que joinean via course_id → courses.tenant_id.
  IF to_regclass('public.exams') IS NOT NULL THEN
    UPDATE public.exams e
       SET deleted_at = v_ts, deleted_by = v_caller
      FROM public.courses c
     WHERE e.course_id = c.id
       AND c.tenant_id = _tenant_id
       AND e.deleted_at IS NULL;
  END IF;

  IF to_regclass('public.workshops') IS NOT NULL THEN
    UPDATE public.workshops w
       SET deleted_at = v_ts, deleted_by = v_caller
      FROM public.courses c
     WHERE w.course_id = c.id
       AND c.tenant_id = _tenant_id
       AND w.deleted_at IS NULL;
  END IF;

  IF to_regclass('public.projects') IS NOT NULL THEN
    UPDATE public.projects p
       SET deleted_at = v_ts, deleted_by = v_caller
      FROM public.courses c
     WHERE p.course_id = c.id
       AND c.tenant_id = _tenant_id
       AND p.deleted_at IS NULL;
  END IF;

  IF to_regclass('public.attendance_sessions') IS NOT NULL THEN
    UPDATE public.attendance_sessions a
       SET deleted_at = v_ts, deleted_by = v_caller
      FROM public.courses c
     WHERE a.course_id = c.id
       AND c.tenant_id = _tenant_id
       AND a.deleted_at IS NULL;
  END IF;

  IF to_regclass('public.polls') IS NOT NULL THEN
    UPDATE public.polls p
       SET deleted_at = v_ts, deleted_by = v_caller
      FROM public.courses c
     WHERE p.course_id = c.id
       AND c.tenant_id = _tenant_id
       AND p.deleted_at IS NULL;
  END IF;

  -- generated_contents: course_id puede ser NULL (material independiente).
  -- Solo se cascadea cuando course_id está set y apunta a un course del
  -- tenant. Los independientes (NULL) NO pertenecen al tenant.
  IF to_regclass('public.generated_contents') IS NOT NULL THEN
    UPDATE public.generated_contents g
       SET deleted_at = v_ts, deleted_by = v_caller
      FROM public.courses c
     WHERE g.course_id = c.id
       AND c.tenant_id = _tenant_id
       AND g.deleted_at IS NULL;
  END IF;

  -- whiteboards: tiene tenant_id directo (poblado por trigger desde
  -- owner.tenant_id). No necesitamos join con courses.
  IF to_regclass('public.whiteboards') IS NOT NULL THEN
    UPDATE public.whiteboards
       SET deleted_at = v_ts, deleted_by = v_caller
     WHERE tenant_id = _tenant_id AND deleted_at IS NULL;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.soft_delete_tenant(UUID) IS
  'Soft-delete cascadeado del tenant: marca tenants + courses + exams + workshops + projects + attendance_sessions + polls + generated_contents + whiteboards con el mismo deleted_at. Solo SuperAdmin.';

GRANT EXECUTE ON FUNCTION public.soft_delete_tenant(UUID) TO authenticated;

-- ── 3) RPC restore_tenant ──
-- Restaura el tenant + sus children que fueron soft-deleted en el
-- MISMO timestamp (= cascadeados por soft_delete_tenant, NO por borrados
-- individuales previos). Lee el `deleted_at` del tenant ANTES de
-- limpiarlo y lo usa como filtro para los children.
DROP FUNCTION IF EXISTS public.restore_tenant(UUID);
CREATE OR REPLACE FUNCTION public.restore_tenant(_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_is_super BOOLEAN;
  v_ts TIMESTAMPTZ;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = 'P0001';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = v_caller AND role = 'SuperAdmin'
  ) INTO v_is_super;

  IF NOT v_is_super THEN
    RAISE EXCEPTION 'Solo SuperAdmin puede restaurar instituciones' USING ERRCODE = 'P0001';
  END IF;

  SELECT deleted_at INTO v_ts FROM public.tenants WHERE id = _tenant_id;
  IF v_ts IS NULL THEN
    RAISE EXCEPTION 'La institución no está eliminada' USING ERRCODE = 'P0001';
  END IF;

  -- Restaurar el tenant.
  UPDATE public.tenants
     SET deleted_at = NULL, deleted_by = NULL
   WHERE id = _tenant_id;

  -- Restaurar SOLO los children con el mismo timestamp (= los que
  -- cascadearon en esta operación). Si un curso tenía deleted_at
  -- distinto (borrado manual previo), permanece en papelera.
  IF to_regclass('public.courses') IS NOT NULL THEN
    UPDATE public.courses
       SET deleted_at = NULL, deleted_by = NULL
     WHERE tenant_id = _tenant_id AND deleted_at = v_ts;
  END IF;

  IF to_regclass('public.exams') IS NOT NULL THEN
    UPDATE public.exams e
       SET deleted_at = NULL, deleted_by = NULL
      FROM public.courses c
     WHERE e.course_id = c.id
       AND c.tenant_id = _tenant_id
       AND e.deleted_at = v_ts;
  END IF;

  IF to_regclass('public.workshops') IS NOT NULL THEN
    UPDATE public.workshops w
       SET deleted_at = NULL, deleted_by = NULL
      FROM public.courses c
     WHERE w.course_id = c.id
       AND c.tenant_id = _tenant_id
       AND w.deleted_at = v_ts;
  END IF;

  IF to_regclass('public.projects') IS NOT NULL THEN
    UPDATE public.projects p
       SET deleted_at = NULL, deleted_by = NULL
      FROM public.courses c
     WHERE p.course_id = c.id
       AND c.tenant_id = _tenant_id
       AND p.deleted_at = v_ts;
  END IF;

  IF to_regclass('public.attendance_sessions') IS NOT NULL THEN
    UPDATE public.attendance_sessions a
       SET deleted_at = NULL, deleted_by = NULL
      FROM public.courses c
     WHERE a.course_id = c.id
       AND c.tenant_id = _tenant_id
       AND a.deleted_at = v_ts;
  END IF;

  IF to_regclass('public.polls') IS NOT NULL THEN
    UPDATE public.polls p
       SET deleted_at = NULL, deleted_by = NULL
      FROM public.courses c
     WHERE p.course_id = c.id
       AND c.tenant_id = _tenant_id
       AND p.deleted_at = v_ts;
  END IF;

  IF to_regclass('public.generated_contents') IS NOT NULL THEN
    UPDATE public.generated_contents g
       SET deleted_at = NULL, deleted_by = NULL
      FROM public.courses c
     WHERE g.course_id = c.id
       AND c.tenant_id = _tenant_id
       AND g.deleted_at = v_ts;
  END IF;

  IF to_regclass('public.whiteboards') IS NOT NULL THEN
    UPDATE public.whiteboards
       SET deleted_at = NULL, deleted_by = NULL
     WHERE tenant_id = _tenant_id AND deleted_at = v_ts;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.restore_tenant(UUID) IS
  'Restaura un tenant soft-deleted + sus children que fueron cascadeados en la misma operación (mismo deleted_at). Solo SuperAdmin.';

GRANT EXECUTE ON FUNCTION public.restore_tenant(UUID) TO authenticated;

-- ── 4) RPC hard_delete_tenant ──
-- DELETE físico — cascade de FKs limpia todo lo que apunta al tenant
-- (courses, profiles via tenant_id NULL on SET NULL, etc.). Solo
-- aplicable sobre tenants ya en papelera.
DROP FUNCTION IF EXISTS public.hard_delete_tenant(UUID);
CREATE OR REPLACE FUNCTION public.hard_delete_tenant(_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_is_super BOOLEAN;
  v_in_trash BOOLEAN;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = 'P0001';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = v_caller AND role = 'SuperAdmin'
  ) INTO v_is_super;

  IF NOT v_is_super THEN
    RAISE EXCEPTION 'Solo SuperAdmin puede eliminar definitivamente una institución' USING ERRCODE = 'P0001';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = _tenant_id AND deleted_at IS NOT NULL
  ) INTO v_in_trash;

  IF NOT v_in_trash THEN
    RAISE EXCEPTION 'La institución debe estar en papelera antes del borrado definitivo' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.tenants WHERE id = _tenant_id;
END;
$$;

COMMENT ON FUNCTION public.hard_delete_tenant(UUID) IS
  'Borrado físico de un tenant que YA está en papelera. Cascade via FKs. Solo SuperAdmin.';

GRANT EXECUTE ON FUNCTION public.hard_delete_tenant(UUID) TO authenticated;

-- ── 5) Extender purge_deleted_items para incluir tenants ──
-- Re-creamos la función con el array de tablas ampliado. El orden importa:
-- borramos hijos PRIMERO (courses, exams, etc.) y tenants AL FINAL. Si
-- borráramos tenants primero, las FK cascade harían DELETE físico de
-- courses + sus hijos ahora (rompiendo el principio "30d en papelera").
DROP FUNCTION IF EXISTS public.purge_deleted_items(INTERVAL);
CREATE OR REPLACE FUNCTION public.purge_deleted_items(_ttl INTERVAL DEFAULT INTERVAL '30 days')
RETURNS TABLE(table_name TEXT, purged_count INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tbl TEXT;
  tbls TEXT[] := ARRAY[
    -- Hijos primero — sus deleted_at > TTL se borran antes de que el
    -- tenant pase a hard-delete por FK cascade.
    'courses',
    'exams',
    'workshops',
    'projects',
    'attendance_sessions',
    'whiteboards',
    'generated_contents',
    'polls',
    -- Tenants al final.
    'tenants'
  ];
  cnt INT;
BEGIN
  FOREACH tbl IN ARRAY tbls
  LOOP
    IF to_regclass('public.' || tbl) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'DELETE FROM public.%I WHERE deleted_at IS NOT NULL AND deleted_at < now() - $1',
      tbl
    ) USING _ttl;
    GET DIAGNOSTICS cnt = ROW_COUNT;
    table_name := tbl;
    purged_count := cnt;
    RETURN NEXT;
  END LOOP;
  RETURN;
END;
$$;

COMMENT ON FUNCTION public.purge_deleted_items(INTERVAL) IS
  'Borra fisicamente las filas con deleted_at > TTL (default 30d) de las tablas de papelera, incluyendo tenants. Invocado diariamente por pg_cron.';

-- Actualizar la descripción del job (la edita el panel SuperAdmin → Cron).
DO $$
BEGIN
  IF to_regclass('public.cron_job_descriptions') IS NOT NULL THEN
    UPDATE public.cron_job_descriptions
       SET description = 'Papelera: borra fisicamente filas con deleted_at > 30 dias en cursos, examenes, talleres, proyectos, sesiones, pizarras, contenidos, encuestas e instituciones.',
           updated_at = now()
     WHERE jobname = 'purge-deleted-items-daily';
  END IF;
END $$;

-- ── 6) Excluir tenants eliminados del selector público del login ──
-- El Select de institución en /auth llama list_active_tenants_public.
-- Antes filtraba solo `is_active = true`. Ahora además excluimos los
-- soft-deleted: un tenant en papelera no debe ser elegible para
-- loguearse (sus usuarios deben quedar bloqueados hasta restaurar).
CREATE OR REPLACE FUNCTION public.list_active_tenants_public()
RETURNS TABLE (
  id uuid,
  slug text,
  name text,
  logo_url text,
  logo_path text,
  primary_color text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT t.id, t.slug, t.name, t.logo_url, t.logo_path, t.primary_color
  FROM public.tenants AS t
  WHERE t.is_active = true
    AND t.deleted_at IS NULL
  ORDER BY t.name ASC;
$$;

REVOKE ALL ON FUNCTION public.list_active_tenants_public() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_active_tenants_public() TO anon, authenticated;
