-- ──────────────────────────────────────────────────────────────────────
-- ai_model_settings: nivel "platform default" del SuperAdmin
--
-- Antes (mig 20260625): una fila ACTIVA por tenant; SuperAdmin solo
-- podía configurar tenants individualmente. Si un tenant no tenía fila
-- activa, la calificación caía al fallback HARDCODED del edge
-- (Lovable Gateway + Gemini Flash) — sin posibilidad de que el
-- SuperAdmin gestionara el modelo + keys "por defecto" desde la UI.
--
-- Ahora: 3 capas + hardcoded fallback.
--   1. tenant row activa     (tenant_id = X, is_active = true)
--   2. PLATFORM DEFAULT      (tenant_id IS NULL, is_active = true)   ← nuevo
--   3. DEFAULT_MODEL hardcoded en `_shared/ai-model.ts`
--
-- El SuperAdmin (cross-tenant) edita la fila platform-default desde
-- /app/admin/ai-prompts → Modelo. Acá ALSO se almacena la "Gemini API
-- key global" — los Admins de tenants que no quieran usar la suya
-- propia heredan la key del SuperAdmin.
-- ──────────────────────────────────────────────────────────────────────

-- 1. Permitir tenant_id NULL.
ALTER TABLE public.ai_model_settings
  ALTER COLUMN tenant_id DROP NOT NULL;

-- 2. Unique partial: garantiza UNA fila platform-default activa a la vez.
-- El partial pre-existente (mig 20260625) cubre las activas por tenant
-- (porque NULL no es tratado como "valor" en index parcial estándar:
-- `tenant_id = X WHERE is_active = TRUE` con NULL no aplica, así que
-- coexisten múltiples filas con tenant_id NULL). Para platform default
-- agregamos una segunda partial específica.
DROP INDEX IF EXISTS idx_ai_model_platform_default_active;
CREATE UNIQUE INDEX idx_ai_model_platform_default_active
  ON public.ai_model_settings((1))
  WHERE is_active = TRUE AND tenant_id IS NULL;

-- 3. Trigger auto-set tenant_id — antes era el genérico
-- `tg_set_tenant_id` (compartido con otras tablas). Lo reemplazamos por
-- uno específico que respeta el `tenant_id IS NULL` cuando es SuperAdmin
-- (igual patrón que el de ai_prompts post-mig 20260718000000).
CREATE OR REPLACE FUNCTION public.tg_ai_model_settings_set_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- SuperAdmin que envía tenant_id NULL: respetamos, es platform default.
  IF public.is_super_admin() THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS NULL THEN
    NEW.tenant_id := public.current_tenant_id();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_model_settings_set_tenant ON public.ai_model_settings;
CREATE TRIGGER trg_ai_model_settings_set_tenant
  BEFORE INSERT ON public.ai_model_settings
  FOR EACH ROW EXECUTE FUNCTION public.tg_ai_model_settings_set_tenant();

-- 4. RLS — agregar policies para platform default.
-- Las pre-existentes (`ai_model_settings_select/insert/update`) ya
-- contemplan `is_super_admin()` para escribir; pero el SELECT estaba
-- acotado a `tenant_id = current_tenant_id() OR is_super_admin()`, lo
-- que NO incluye la fila platform-default cuando un usuario común
-- (Admin/Docente/Estudiante) consulta. Necesitamos que esa fila sea
-- LEGIBLE para todos los authenticated — la resolución del modelo
-- en edges la requiere como fallback cuando el tenant no tiene fila.
DROP POLICY IF EXISTS ai_model_settings_select_platform_default ON public.ai_model_settings;
CREATE POLICY ai_model_settings_select_platform_default
  ON public.ai_model_settings FOR SELECT TO authenticated
  USING (tenant_id IS NULL);

-- Las policies insert/update ya admiten is_super_admin() — no hay que
-- tocarlas. Un Admin común NO podrá tocar la fila platform default
-- (su tenant_id IS NULL falla el check `tenant_id = current_tenant_id()`).

NOTIFY pgrst, 'reload schema';
