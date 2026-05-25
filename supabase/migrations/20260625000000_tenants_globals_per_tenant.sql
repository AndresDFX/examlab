-- ──────────────────────────────────────────────────────────────────────
-- Multi-tenancy Fase 5: globals → per-tenant.
--
-- Tablas singleton globales que ahora son singleton-per-tenant:
--   - app_settings              (config global de Admin)
--   - certificate_settings      (branding global de certificados)
--   - ai_model_settings         (provider/modelo IA activo)
--   - ai_prompts (globales)     (filas con course_id NULL)
--
-- Diseño:
--   - UNIQUE INDEX ((true)) global → UNIQUE INDEX (tenant_id).
--   - Backfill: la única fila existente queda en tenant 'default'.
--   - RLS: SELECT abierto a authenticated PERO filtrado por tenant
--     (los settings se leen desde el cliente de cada tenant). Write Admin
--     dentro de su tenant.
--   - SuperAdmin: ve y edita todos.
--
-- NOTA: para ai_prompts, los overrides per-curso (course_id NOT NULL) ya
-- están aislados via course_id → course.tenant_id (Fase 2). Solo los
-- globales (course_id NULL) necesitan tenant_id explícito.
-- ──────────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════════
-- 1) public.app_settings
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;

UPDATE public.app_settings
   SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'default')
 WHERE tenant_id IS NULL;

ALTER TABLE public.app_settings
  ALTER COLUMN tenant_id SET NOT NULL;

-- Reemplaza el UNIQUE global por singleton-per-tenant.
DROP INDEX IF EXISTS app_settings_singleton;
CREATE UNIQUE INDEX IF NOT EXISTS app_settings_singleton_per_tenant
  ON public.app_settings(tenant_id);

CREATE INDEX IF NOT EXISTS idx_app_settings_tenant ON public.app_settings(tenant_id);

-- Trigger auto-set tenant_id en INSERT.
DROP TRIGGER IF EXISTS trg_app_settings_set_tenant ON public.app_settings;
CREATE TRIGGER trg_app_settings_set_tenant
  BEFORE INSERT ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_tenant_id();

-- RLS: agregar filtro de tenant. Las policies anteriores quedan
-- (asumimos que filtraban por Admin); les sumamos el tenant check.
-- Como no sabemos exactamente cómo están escritas en cada deploy, las
-- recreamos limpias acá.
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_settings_select ON public.app_settings;
DROP POLICY IF EXISTS app_settings_admin_write ON public.app_settings;
DROP POLICY IF EXISTS app_settings_read ON public.app_settings;

CREATE POLICY app_settings_select
  ON public.app_settings FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());

CREATE POLICY app_settings_insert
  ON public.app_settings FOR INSERT TO authenticated
  WITH CHECK (
    (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin'))
    OR public.is_super_admin()
  );

CREATE POLICY app_settings_update
  ON public.app_settings FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin')
         OR public.is_super_admin())
  WITH CHECK (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin')
              OR public.is_super_admin());

-- ════════════════════════════════════════════════════════════════════
-- 2) public.certificate_settings
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.certificate_settings
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;

UPDATE public.certificate_settings
   SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'default')
 WHERE tenant_id IS NULL;

ALTER TABLE public.certificate_settings
  ALTER COLUMN tenant_id SET NOT NULL;

DROP INDEX IF EXISTS certificate_settings_singleton;
CREATE UNIQUE INDEX IF NOT EXISTS certificate_settings_singleton_per_tenant
  ON public.certificate_settings(tenant_id);

CREATE INDEX IF NOT EXISTS idx_certificate_settings_tenant
  ON public.certificate_settings(tenant_id);

DROP TRIGGER IF EXISTS trg_certificate_settings_set_tenant ON public.certificate_settings;
CREATE TRIGGER trg_certificate_settings_set_tenant
  BEFORE INSERT ON public.certificate_settings
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_tenant_id();

ALTER TABLE public.certificate_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS certificate_settings_select ON public.certificate_settings;
DROP POLICY IF EXISTS certificate_settings_admin_write ON public.certificate_settings;
DROP POLICY IF EXISTS certificate_settings_read ON public.certificate_settings;

CREATE POLICY certificate_settings_select
  ON public.certificate_settings FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());

CREATE POLICY certificate_settings_insert
  ON public.certificate_settings FOR INSERT TO authenticated
  WITH CHECK (
    (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin'))
    OR public.is_super_admin()
  );

CREATE POLICY certificate_settings_update
  ON public.certificate_settings FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin')
         OR public.is_super_admin())
  WITH CHECK (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin')
              OR public.is_super_admin());

-- ════════════════════════════════════════════════════════════════════
-- 3) public.ai_model_settings
-- ════════════════════════════════════════════════════════════════════
-- Una fila ACTIVA por tenant (UNIQUE PARTIAL sobre is_active=true,
-- tenant_id). Historial inactivo se mantiene para auditoría.

ALTER TABLE public.ai_model_settings
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;

UPDATE public.ai_model_settings
   SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'default')
 WHERE tenant_id IS NULL;

ALTER TABLE public.ai_model_settings
  ALTER COLUMN tenant_id SET NOT NULL;

-- Reemplaza el unique partial existente (probablemente sobre is_active solo).
DROP INDEX IF EXISTS ai_model_settings_active_singleton;
DROP INDEX IF EXISTS idx_ai_model_settings_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_model_settings_active_per_tenant
  ON public.ai_model_settings(tenant_id)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_ai_model_settings_tenant
  ON public.ai_model_settings(tenant_id);

DROP TRIGGER IF EXISTS trg_ai_model_settings_set_tenant ON public.ai_model_settings;
CREATE TRIGGER trg_ai_model_settings_set_tenant
  BEFORE INSERT ON public.ai_model_settings
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_tenant_id();

ALTER TABLE public.ai_model_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_model_settings_select ON public.ai_model_settings;
DROP POLICY IF EXISTS ai_model_settings_admin_write ON public.ai_model_settings;

CREATE POLICY ai_model_settings_select
  ON public.ai_model_settings FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());

CREATE POLICY ai_model_settings_insert
  ON public.ai_model_settings FOR INSERT TO authenticated
  WITH CHECK (
    (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin'))
    OR public.is_super_admin()
  );

CREATE POLICY ai_model_settings_update
  ON public.ai_model_settings FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin')
         OR public.is_super_admin())
  WITH CHECK (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin')
              OR public.is_super_admin());

-- ════════════════════════════════════════════════════════════════════
-- 4) public.ai_prompts (filas globales)
-- ════════════════════════════════════════════════════════════════════
-- Los overrides per-curso (course_id NOT NULL) ya están aislados via
-- course.tenant_id desde Fase 2. Solo los globales (course_id NULL)
-- necesitan tenant_id explícito.

ALTER TABLE public.ai_prompts
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;

-- Backfill: si la fila tiene course_id, derivamos de ahí; si no, default.
UPDATE public.ai_prompts ap
   SET tenant_id = COALESCE(
     (SELECT tenant_id FROM public.courses WHERE id = ap.course_id),
     (SELECT id FROM public.tenants WHERE slug = 'default')
   )
 WHERE ap.tenant_id IS NULL;

ALTER TABLE public.ai_prompts
  ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_prompts_tenant ON public.ai_prompts(tenant_id);

-- Reemplaza el UNIQUE partial de globales: (use_case) → (use_case, tenant_id).
-- El partial sigue: solo aplica cuando course_id IS NULL.
DROP INDEX IF EXISTS idx_ai_prompts_global;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_prompts_global_per_tenant
  ON public.ai_prompts(tenant_id, use_case)
  WHERE course_id IS NULL;

-- Trigger: si el INSERT trae course_id NOT NULL, derivamos tenant_id
-- desde courses.tenant_id (asegura consistencia y libera al cliente).
-- Si es global (course_id NULL), tg_set_tenant_id() usa current_tenant_id().
CREATE OR REPLACE FUNCTION public.tg_ai_prompts_set_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    IF NEW.course_id IS NOT NULL THEN
      SELECT tenant_id INTO NEW.tenant_id FROM public.courses WHERE id = NEW.course_id;
    ELSE
      NEW.tenant_id := public.current_tenant_id();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_prompts_set_tenant ON public.ai_prompts;
CREATE TRIGGER trg_ai_prompts_set_tenant
  BEFORE INSERT ON public.ai_prompts
  FOR EACH ROW EXECUTE FUNCTION public.tg_ai_prompts_set_tenant();

-- RLS para ai_prompts: el SELECT debe permitir lectura del prompt
-- global del tenant + del override del curso. Las policies pre-existentes
-- ya filtran por curso para overrides; las recreamos limpias con
-- filtro de tenant.
ALTER TABLE public.ai_prompts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_prompts_select ON public.ai_prompts;
DROP POLICY IF EXISTS ai_prompts_admin_write_global ON public.ai_prompts;
DROP POLICY IF EXISTS ai_prompts_teacher_write_course ON public.ai_prompts;
DROP POLICY IF EXISTS ai_prompts_read ON public.ai_prompts;

CREATE POLICY ai_prompts_select
  ON public.ai_prompts FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());

-- INSERT/UPDATE: Admin del tenant para globales, docente del curso para overrides.
CREATE POLICY ai_prompts_admin_write_global
  ON public.ai_prompts FOR ALL TO authenticated
  USING (
    course_id IS NULL
    AND tenant_id = public.current_tenant_id()
    AND public.has_role(auth.uid(), 'Admin')
    OR public.is_super_admin()
  )
  WITH CHECK (
    course_id IS NULL
    AND tenant_id = public.current_tenant_id()
    AND public.has_role(auth.uid(), 'Admin')
    OR public.is_super_admin()
  );

CREATE POLICY ai_prompts_teacher_write_course
  ON public.ai_prompts FOR ALL TO authenticated
  USING (
    course_id IS NOT NULL
    AND tenant_id = public.current_tenant_id()
    AND (
      EXISTS (SELECT 1 FROM public.course_teachers WHERE course_id = ai_prompts.course_id AND user_id = auth.uid())
      OR public.has_role(auth.uid(), 'Admin')
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    course_id IS NOT NULL
    AND tenant_id = public.current_tenant_id()
    AND (
      EXISTS (SELECT 1 FROM public.course_teachers WHERE course_id = ai_prompts.course_id AND user_id = auth.uid())
      OR public.has_role(auth.uid(), 'Admin')
    )
    OR public.is_super_admin()
  );

NOTIFY pgrst, 'reload schema';
