-- ──────────────────────────────────────────────────────────────────────
-- Multi-tenancy Fase 2: scoping del backbone académico.
--
-- Agrega `tenant_id` a las 4 tablas que forman la "espina dorsal"
-- académica:
--   - academic_programs   (carreras / pregrados / postgrados)
--   - academic_periods    (semestres / ciclos)
--   - academic_subjects   (asignaturas / plan de estudios)
--   - courses             (instancias concretas)
--
-- Decisiones:
--   - tenant_id es NOT NULL después del backfill — un programa, periodo
--     o curso SIEMPRE pertenece a UNA institución. No hay programas
--     "compartidos" cross-tenant (eso sería un anti-pattern: cada
--     institución administra su propio plan).
--   - UNIQUE indexes globales se vuelven `(tenant_id, lower(name|code))`.
--     Dos instituciones distintas pueden tener "Ingeniería de Sistemas"
--     sin colisionar.
--   - Backfill: todos los rows existentes → tenant 'default'.
--   - RLS: SELECT abierto a authenticated PERO filtrado por tenant_id
--     (o SuperAdmin). Write Admin solo dentro de su tenant.
--   - Triggers BEFORE INSERT: si tenant_id viene NULL, lo seteamos a
--     current_tenant_id(). El cliente puede omitir el campo y el
--     trigger lo completa automáticamente.
-- ──────────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════════
-- 1) academic_programs
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.academic_programs
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE RESTRICT;

UPDATE public.academic_programs
   SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'default')
 WHERE tenant_id IS NULL;

ALTER TABLE public.academic_programs
  ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_academic_programs_tenant_id
  ON public.academic_programs(tenant_id);

-- UNIQUE por nombre dentro del tenant. Reemplaza el unique global.
DROP INDEX IF EXISTS idx_academic_programs_name;
CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_programs_tenant_name
  ON public.academic_programs(tenant_id, LOWER(name));

-- RLS: SELECT filtrado por tenant; write Admin dentro del propio tenant.
DROP POLICY IF EXISTS "academic_programs_read" ON public.academic_programs;
CREATE POLICY "academic_programs_read"
  ON public.academic_programs FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());

DROP POLICY IF EXISTS "academic_programs_admin_write" ON public.academic_programs;
CREATE POLICY "academic_programs_admin_insert"
  ON public.academic_programs FOR INSERT TO authenticated
  WITH CHECK (
    (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin'))
    OR public.is_super_admin()
  );
CREATE POLICY "academic_programs_admin_update"
  ON public.academic_programs FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin')
         OR public.is_super_admin())
  WITH CHECK (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin')
              OR public.is_super_admin());
CREATE POLICY "academic_programs_admin_delete"
  ON public.academic_programs FOR DELETE TO authenticated
  USING (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin')
         OR public.is_super_admin());

-- Trigger: auto-set tenant_id en INSERT si NULL.
CREATE OR REPLACE FUNCTION public.tg_set_tenant_id()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    NEW.tenant_id := public.current_tenant_id();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_academic_programs_set_tenant ON public.academic_programs;
CREATE TRIGGER trg_academic_programs_set_tenant
  BEFORE INSERT ON public.academic_programs
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_tenant_id();

-- ════════════════════════════════════════════════════════════════════
-- 2) academic_periods
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.academic_periods
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE RESTRICT;

UPDATE public.academic_periods
   SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'default')
 WHERE tenant_id IS NULL;

ALTER TABLE public.academic_periods
  ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_academic_periods_tenant_id
  ON public.academic_periods(tenant_id);

DROP INDEX IF EXISTS idx_academic_periods_code;
CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_periods_tenant_code
  ON public.academic_periods(tenant_id, LOWER(code));

DROP POLICY IF EXISTS "academic_periods_read" ON public.academic_periods;
CREATE POLICY "academic_periods_read"
  ON public.academic_periods FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());

DROP POLICY IF EXISTS "academic_periods_admin_write" ON public.academic_periods;
CREATE POLICY "academic_periods_admin_insert"
  ON public.academic_periods FOR INSERT TO authenticated
  WITH CHECK (
    (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin'))
    OR public.is_super_admin()
  );
CREATE POLICY "academic_periods_admin_update"
  ON public.academic_periods FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin')
         OR public.is_super_admin())
  WITH CHECK (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin')
              OR public.is_super_admin());
CREATE POLICY "academic_periods_admin_delete"
  ON public.academic_periods FOR DELETE TO authenticated
  USING (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin')
         OR public.is_super_admin());

DROP TRIGGER IF EXISTS trg_academic_periods_set_tenant ON public.academic_periods;
CREATE TRIGGER trg_academic_periods_set_tenant
  BEFORE INSERT ON public.academic_periods
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_tenant_id();

-- ════════════════════════════════════════════════════════════════════
-- 3) academic_subjects
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.academic_subjects
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE RESTRICT;

UPDATE public.academic_subjects
   SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'default')
 WHERE tenant_id IS NULL;

ALTER TABLE public.academic_subjects
  ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_academic_subjects_tenant_id
  ON public.academic_subjects(tenant_id);

DROP INDEX IF EXISTS idx_academic_subjects_name_program;
CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_subjects_tenant_name_program
  ON public.academic_subjects(
    tenant_id,
    LOWER(name),
    COALESCE(program_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

DROP POLICY IF EXISTS "academic_subjects_read" ON public.academic_subjects;
CREATE POLICY "academic_subjects_read"
  ON public.academic_subjects FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());

DROP POLICY IF EXISTS "academic_subjects_admin_write" ON public.academic_subjects;
CREATE POLICY "academic_subjects_admin_insert"
  ON public.academic_subjects FOR INSERT TO authenticated
  WITH CHECK (
    (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin'))
    OR public.is_super_admin()
  );
CREATE POLICY "academic_subjects_admin_update"
  ON public.academic_subjects FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin')
         OR public.is_super_admin())
  WITH CHECK (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin')
              OR public.is_super_admin());
CREATE POLICY "academic_subjects_admin_delete"
  ON public.academic_subjects FOR DELETE TO authenticated
  USING (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin')
         OR public.is_super_admin());

DROP TRIGGER IF EXISTS trg_academic_subjects_set_tenant ON public.academic_subjects;
CREATE TRIGGER trg_academic_subjects_set_tenant
  BEFORE INSERT ON public.academic_subjects
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_tenant_id();

-- ════════════════════════════════════════════════════════════════════
-- 4) courses
-- ════════════════════════════════════════════════════════════════════
-- courses es el corazón del scoping: TODAS las tablas hijas (exams,
-- workshops, projects, attendance, actas, schedules) heredan tenant
-- vía course_id. La Fase 3 actualiza sus RLS para usar este join.

ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE RESTRICT;

UPDATE public.courses
   SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'default')
 WHERE tenant_id IS NULL;

ALTER TABLE public.courses
  ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_courses_tenant_id
  ON public.courses(tenant_id);

DROP TRIGGER IF EXISTS trg_courses_set_tenant ON public.courses;
CREATE TRIGGER trg_courses_set_tenant
  BEFORE INSERT ON public.courses
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_tenant_id();

-- NOTA sobre RLS de courses: las policies de courses son complejas y
-- atan a course_teachers/course_enrollments. NO las modificamos aquí —
-- ya filtran por membresía (un estudiante solo ve cursos en los que
-- está matriculado, etc.). El tenant_id es defensa adicional: si un
-- SuperAdmin asigna por error un course de tenant A a un usuario de
-- tenant B, las matrices RLS existentes lo siguen aislando.
--
-- La Fase 3 agregará tenant_id check si descubrimos un agujero. Por
-- ahora confiamos en el RLS existente + el constraint de FK.

-- ════════════════════════════════════════════════════════════════════
-- 5) Helper SQL: course_tenant_id() para joins de RLS en tablas hijas
-- ════════════════════════════════════════════════════════════════════
-- Las fases 3-4 lo usan en `EXISTS (SELECT 1 FROM courses c WHERE
-- c.id = parent.course_id AND c.tenant_id = current_tenant_id())`.
-- Lo dejamos en STABLE para que el planner cachée.

CREATE OR REPLACE FUNCTION public.course_tenant_id(_course_id UUID)
RETURNS UUID
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT tenant_id FROM public.courses WHERE id = _course_id;
$$;

GRANT EXECUTE ON FUNCTION public.course_tenant_id(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
