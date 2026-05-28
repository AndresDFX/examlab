-- ──────────────────────────────────────────────────────────────────────
-- module_visibility por tenant — el SuperAdmin define el ORDEN +
-- VISIBILIDAD global de la plataforma; cada Admin puede OVERRIDE-arlo
-- para su institución.
--
-- Schema anterior:
--   PK (module_key, role)  →  una sola fila por (módulo, rol) en toda la DB.
--
-- Schema nuevo:
--   `tenant_id UUID NULL` — NULL = fila global (default de la plataforma).
--                          UUID = override específico de ese tenant.
--   UNIQUE NULLS NOT DISTINCT (tenant_id, module_key, role) — permite
--     coexistir una fila global + una fila por cada tenant que decide
--     hacer override. NULLS NOT DISTINCT trata los NULLs como iguales
--     (PostgreSQL 15+), así que NO podés tener dos filas globales para
--     el mismo (module_key, role).
--
-- Resolución de visibilidad para un usuario:
--   1. Lee todas las filas WHERE tenant_id IS NULL OR tenant_id = <user_tenant>.
--   2. Por cada (module_key, role), la fila con tenant_id != NULL gana
--      sobre la global. Si no hay tenant row, usa la global.
--   3. Si no hay fila en absoluto, el módulo está visible por default.
--
-- Quién escribe qué:
--   - SuperAdmin (modo cross-tenant) edita filas con tenant_id IS NULL
--     (la "default platform config").
--   - Admin edita filas con tenant_id = current_tenant_id() (override).
--   - SuperAdmin con tenant override activo edita el override del tenant.
-- ──────────────────────────────────────────────────────────────────────

-- 1. Agregar tenant_id (NULL = global). Backfill no es necesario: las
-- filas existentes quedan automáticamente como tenant_id IS NULL.
ALTER TABLE public.module_visibility
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;

-- 2. Reemplazar el PK. Necesitamos un PK que tolere NULL en tenant_id,
-- así que vamos a:
--   - Drop el PK natural (module_key, role).
--   - Agregar un PK surrogate (id UUID gen_random_uuid()).
--   - Agregar UNIQUE NULLS NOT DISTINCT en (tenant_id, module_key, role)
--     para garantizar el invariante "una sola fila por scope".
ALTER TABLE public.module_visibility
  ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();

-- Drop el PK viejo si existe (por nombre estándar de Postgres) y
-- también por si fue creado con un nombre custom — buscamos cualquier
-- constraint PK sobre la tabla.
DO $cleanup$
DECLARE
  v_constraint TEXT;
BEGIN
  SELECT conname INTO v_constraint
  FROM pg_constraint
  WHERE conrelid = 'public.module_visibility'::regclass
    AND contype = 'p';
  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.module_visibility DROP CONSTRAINT %I', v_constraint);
  END IF;
END;
$cleanup$;

ALTER TABLE public.module_visibility
  ADD CONSTRAINT module_visibility_pkey PRIMARY KEY (id);

-- 3. UNIQUE con NULLS NOT DISTINCT para que (tenant_id IS NULL, mod, role)
-- sea único globalmente y (tenant_uuid, mod, role) sea único por tenant.
DROP INDEX IF EXISTS module_visibility_scope_unique;
CREATE UNIQUE INDEX module_visibility_scope_unique
  ON public.module_visibility (tenant_id, module_key, role)
  NULLS NOT DISTINCT;

-- 4. Index para lookups por tenant (la query del hook lee
-- `tenant_id IS NULL OR tenant_id = <user_tenant>`).
CREATE INDEX IF NOT EXISTS module_visibility_tenant_id_idx
  ON public.module_visibility (tenant_id);

-- 5. RLS — las policies viejas (`module_visibility_admin_write` con
-- `has_role(Admin) OR is_super_admin()`) siguen valiendo, pero
-- conceptualmente:
--   - Admin solo debería escribir filas de SU tenant (tenant_id = current_tenant_id()).
--   - SuperAdmin escribe globales (NULL) o cualquier tenant.
-- Lo enforce en una policy nueva más granular:
DROP POLICY IF EXISTS "module_visibility_admin_write" ON public.module_visibility;

DROP POLICY IF EXISTS "module_visibility_admin_write_own_tenant" ON public.module_visibility;
CREATE POLICY "module_visibility_admin_write_own_tenant"
  ON public.module_visibility FOR ALL TO authenticated
  USING (
    -- SuperAdmin: cualquier fila (global o cualquier tenant).
    public.is_super_admin()
    -- Admin: solo filas de su tenant (NO el global).
    OR (public.has_role(auth.uid(), 'Admin') AND tenant_id = public.current_tenant_id())
  )
  WITH CHECK (
    public.is_super_admin()
    OR (public.has_role(auth.uid(), 'Admin') AND tenant_id = public.current_tenant_id())
  );

-- 6. Helper SQL `is_module_enabled` se actualiza para considerar el
-- override del tenant. Antes leía `WHERE module_key = ? AND role = ?`
-- y devolvía la primera fila (única); ahora hay potencialmente DOS
-- (global + tenant). El tenant gana.
CREATE OR REPLACE FUNCTION public.is_module_enabled(_module TEXT, _role TEXT)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  -- Si hay fila del tenant del caller → esa decide. Si solo hay global
  -- (NULL) → esa decide. Si no hay ninguna → TRUE (default).
  SELECT COALESCE(
    (
      SELECT enabled
      FROM public.module_visibility
      WHERE module_key = _module
        AND role = _role
        AND tenant_id = public.current_tenant_id()
      LIMIT 1
    ),
    (
      SELECT enabled
      FROM public.module_visibility
      WHERE module_key = _module
        AND role = _role
        AND tenant_id IS NULL
      LIMIT 1
    ),
    TRUE
  );
$$;

NOTIFY pgrst, 'reload schema';
