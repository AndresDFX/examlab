-- ──────────────────────────────────────────────────────────────────────
-- Multitenant — Fase B: tenant_id en tablas CORE.
--
-- Tablas afectadas:
--   - profiles (tenant_id NULLABLE — el Superadmin puede tener NULL)
--   - user_roles (tenant_id NULLABLE — Superadmin tiene NULL; los demás
--                 roles deben tener tenant_id por CHECK constraint)
--   - courses, exams, workshops, projects (tenant_id NOT NULL)
--
-- Patrón estándar por tabla:
--   1) ALTER TABLE … ADD COLUMN tenant_id UUID
--   2) UPDATE … SET tenant_id = (tenant inicial)  -- backfill
--   3) ALTER TABLE … ALTER COLUMN tenant_id SET NOT NULL  (excepto donde NULLABLE)
--   4) ADD CONSTRAINT FK + INDEX
--
-- Las RLS aún NO usan tenant_id en sus checks — eso viene en Fase D.
-- Después de aplicar B+C+D, el filtrado por tenant queda activo end-to-end.
-- ──────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  _initial_tenant UUID;
BEGIN
  SELECT id INTO _initial_tenant FROM public.tenants WHERE slug = 'examlab' LIMIT 1;
  IF _initial_tenant IS NULL THEN
    RAISE EXCEPTION 'Tenant inicial "examlab" no encontrado. Aplica primero 20260522100000_multitenant_foundation.sql.';
  END IF;

  -- ── profiles ────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='profiles' AND column_name='tenant_id') THEN
    ALTER TABLE public.profiles ADD COLUMN tenant_id UUID;
    EXECUTE format('UPDATE public.profiles SET tenant_id = %L WHERE tenant_id IS NULL', _initial_tenant);
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_profiles_tenant_id ON public.profiles(tenant_id);
  END IF;

  -- ── user_roles ───────────────────────────────────────────────────────
  -- NULLABLE porque Superadmin no tiene tenant. CHECK lo enforza:
  --   role = 'Superadmin'  →  tenant_id IS NULL
  --   role <> 'Superadmin' →  tenant_id IS NOT NULL
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='user_roles' AND column_name='tenant_id') THEN
    ALTER TABLE public.user_roles ADD COLUMN tenant_id UUID;
    -- Backfill: TODOS los roles existentes son no-Superadmin → tenant inicial
    EXECUTE format('UPDATE public.user_roles SET tenant_id = %L WHERE tenant_id IS NULL', _initial_tenant);
    ALTER TABLE public.user_roles
      ADD CONSTRAINT user_roles_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    -- Constraint: solo Superadmin tiene tenant_id NULL
    ALTER TABLE public.user_roles
      ADD CONSTRAINT user_roles_tenant_id_role_consistency
      CHECK (
        (role = 'Superadmin' AND tenant_id IS NULL)
        OR (role <> 'Superadmin' AND tenant_id IS NOT NULL)
      );
    CREATE INDEX IF NOT EXISTS idx_user_roles_tenant_id ON public.user_roles(tenant_id);
    -- Misma user_id + tenant_id + role debe ser único (no duplicar rol
    -- por user en el mismo tenant). El unique original era (user_id, role).
    -- Mantenemos eso pero adicional con tenant_id si llegara N:M en futuro.
  END IF;

  -- ── courses ─────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='courses' AND column_name='tenant_id') THEN
    ALTER TABLE public.courses ADD COLUMN tenant_id UUID;
    EXECUTE format('UPDATE public.courses SET tenant_id = %L WHERE tenant_id IS NULL', _initial_tenant);
    ALTER TABLE public.courses ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE public.courses
      ADD CONSTRAINT courses_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_courses_tenant_id ON public.courses(tenant_id);
  END IF;

  -- ── exams ───────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='exams' AND column_name='tenant_id') THEN
    ALTER TABLE public.exams ADD COLUMN tenant_id UUID;
    EXECUTE format('UPDATE public.exams SET tenant_id = %L WHERE tenant_id IS NULL', _initial_tenant);
    ALTER TABLE public.exams ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE public.exams
      ADD CONSTRAINT exams_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_exams_tenant_id ON public.exams(tenant_id);
  END IF;

  -- ── workshops ───────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='workshops' AND column_name='tenant_id') THEN
    ALTER TABLE public.workshops ADD COLUMN tenant_id UUID;
    EXECUTE format('UPDATE public.workshops SET tenant_id = %L WHERE tenant_id IS NULL', _initial_tenant);
    ALTER TABLE public.workshops ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE public.workshops
      ADD CONSTRAINT workshops_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_workshops_tenant_id ON public.workshops(tenant_id);
  END IF;

  -- ── projects ────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='projects' AND column_name='tenant_id') THEN
    ALTER TABLE public.projects ADD COLUMN tenant_id UUID;
    EXECUTE format('UPDATE public.projects SET tenant_id = %L WHERE tenant_id IS NULL', _initial_tenant);
    ALTER TABLE public.projects ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE public.projects
      ADD CONSTRAINT projects_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_projects_tenant_id ON public.projects(tenant_id);
  END IF;

  RAISE NOTICE 'Fase B completada. tenant_id agregado a profiles, user_roles, courses, exams, workshops, projects. Tenant inicial: %', _initial_tenant;

  -- ── Sanity check: ninguna fila sin tenant_id en tablas NOT NULL ──
  -- Si esto falla, algo del backfill no cubrió todas las filas y la
  -- columna NOT NULL habría rechazado el ALTER. Como llegamos hasta acá
  -- está implícitamente OK, pero validamos explícitamente por seguridad.
  DECLARE
    _orphan_count INT;
  BEGIN
    -- profiles permite NULL (Superadmin) — no chequeamos.
    -- user_roles igual.
    SELECT COUNT(*) INTO _orphan_count FROM public.courses WHERE tenant_id IS NULL;
    IF _orphan_count > 0 THEN RAISE EXCEPTION 'courses tiene % filas sin tenant_id', _orphan_count; END IF;

    SELECT COUNT(*) INTO _orphan_count FROM public.exams WHERE tenant_id IS NULL;
    IF _orphan_count > 0 THEN RAISE EXCEPTION 'exams tiene % filas sin tenant_id', _orphan_count; END IF;

    SELECT COUNT(*) INTO _orphan_count FROM public.workshops WHERE tenant_id IS NULL;
    IF _orphan_count > 0 THEN RAISE EXCEPTION 'workshops tiene % filas sin tenant_id', _orphan_count; END IF;

    SELECT COUNT(*) INTO _orphan_count FROM public.projects WHERE tenant_id IS NULL;
    IF _orphan_count > 0 THEN RAISE EXCEPTION 'projects tiene % filas sin tenant_id', _orphan_count; END IF;
  END;

  RAISE NOTICE 'Sanity check Fase B: OK. Todas las filas de courses/exams/workshops/projects tienen tenant_id.';
END $$;

-- ── Trigger: nuevas filas en estas tablas heredan tenant_id del actor ──
-- Si el cliente olvida pasar tenant_id en el INSERT, el trigger lo
-- popula desde el JWT/profile del actor. Esto evita errores comunes
-- y centraliza la lógica.

CREATE OR REPLACE FUNCTION public._fill_tenant_id_from_actor()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    NEW.tenant_id := public.current_tenant_id_safe();
    -- Si después de leer del JWT/profile sigue NULL Y el rol del actor
    -- NO es Superadmin, abortamos. Superadmin debe pasar tenant_id
    -- explícito (al crear cursos para un tenant específico).
    IF NEW.tenant_id IS NULL AND NOT public.has_role(auth.uid(), 'Superadmin') THEN
      RAISE EXCEPTION 'tenant_id no pudo resolverse desde el actor. ¿Sesión expirada?';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- Aplicar a las 4 tablas con tenant_id NOT NULL
DROP TRIGGER IF EXISTS trg_fill_tenant_id_courses ON public.courses;
CREATE TRIGGER trg_fill_tenant_id_courses
  BEFORE INSERT ON public.courses
  FOR EACH ROW EXECUTE FUNCTION public._fill_tenant_id_from_actor();

DROP TRIGGER IF EXISTS trg_fill_tenant_id_exams ON public.exams;
CREATE TRIGGER trg_fill_tenant_id_exams
  BEFORE INSERT ON public.exams
  FOR EACH ROW EXECUTE FUNCTION public._fill_tenant_id_from_actor();

DROP TRIGGER IF EXISTS trg_fill_tenant_id_workshops ON public.workshops;
CREATE TRIGGER trg_fill_tenant_id_workshops
  BEFORE INSERT ON public.workshops
  FOR EACH ROW EXECUTE FUNCTION public._fill_tenant_id_from_actor();

DROP TRIGGER IF EXISTS trg_fill_tenant_id_projects ON public.projects;
CREATE TRIGGER trg_fill_tenant_id_projects
  BEFORE INSERT ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public._fill_tenant_id_from_actor();

NOTIFY pgrst, 'reload schema';
