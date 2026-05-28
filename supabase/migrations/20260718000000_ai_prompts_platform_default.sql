-- ──────────────────────────────────────────────────────────────────────
-- ai_prompts: nivel "platform default" del SuperAdmin
--
-- Antes la jerarquía era 2 capas:
--   - tenant global         (course_id IS NULL, tenant_id = <tenant>)
--   - course override       (course_id NOT NULL)
--
-- Ahora 3 capas + el fallback hardcodeado del edge:
--   1. course override      (course_id NOT NULL)
--   2. tenant global        (course_id IS NULL, tenant_id = <tenant>)
--   3. PLATFORM DEFAULT     (course_id IS NULL, tenant_id IS NULL)  ← nuevo
--   4. fallback hardcodeado en `resolveSystemPrompt` (TS edge)
--
-- El SuperAdmin (cross-tenant) edita la fila PLATFORM DEFAULT desde
-- /app/admin/ai-prompts. Cada Admin sigue editando la suya de tenant; si
-- no la tiene, la calificación cae al platform default del SuperAdmin
-- (en vez de saltarse al fallback hardcodeado, que era poco mantenible).
-- ──────────────────────────────────────────────────────────────────────

-- 1. Permitir tenant_id NULL (era NOT NULL desde mig 20260625).
ALTER TABLE public.ai_prompts
  ALTER COLUMN tenant_id DROP NOT NULL;

-- 2. Unique para garantizar UNA SOLA fila platform-default por use_case.
-- (Las filas tenant-global y course-override ya tienen sus propias
-- unique indexes pre-existentes.)
DROP INDEX IF EXISTS idx_ai_prompts_platform_default;
CREATE UNIQUE INDEX idx_ai_prompts_platform_default
  ON public.ai_prompts(use_case)
  WHERE course_id IS NULL AND tenant_id IS NULL;

-- 3. Trigger auto-set tenant_id ya no debe disparar para SuperAdmin
-- intencionalmente subiendo una fila NULL. Refactor: si `is_super_admin()`,
-- respetamos lo que el cliente envió (sea NULL o un tenant específico);
-- para otros usuarios, el comportamiento previo (auto-derivar) se mantiene.
CREATE OR REPLACE FUNCTION public.tg_ai_prompts_set_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- SuperAdmin: si dejó tenant_id NULL es PORQUE quiere platform default.
  -- No tocar.
  IF public.is_super_admin() THEN
    RETURN NEW;
  END IF;
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

-- 4. RLS — agregar policies específicas para platform default.
-- Las policies anteriores (admin_write_global / teacher_write_course /
-- select) siguen valiendo; agregamos una más para que SuperAdmin pueda
-- escribir filas con tenant_id IS NULL (platform default).
DROP POLICY IF EXISTS ai_prompts_super_write_platform ON public.ai_prompts;
CREATE POLICY ai_prompts_super_write_platform
  ON public.ai_prompts FOR ALL TO authenticated
  USING (
    public.is_super_admin()
    AND course_id IS NULL
    AND tenant_id IS NULL
  )
  WITH CHECK (
    public.is_super_admin()
    AND course_id IS NULL
    AND tenant_id IS NULL
  );

-- Y un policy de SELECT amplio para que TODOS los authenticated puedan
-- leer la fila platform default (la resolución del prompt necesita
-- caer al global cuando no hay tenant row). El SELECT existente acota
-- por tenant_id = current_tenant_id() — no incluye NULL.
DROP POLICY IF EXISTS ai_prompts_select_platform_default ON public.ai_prompts;
CREATE POLICY ai_prompts_select_platform_default
  ON public.ai_prompts FOR SELECT TO authenticated
  USING (course_id IS NULL AND tenant_id IS NULL);

NOTIFY pgrst, 'reload schema';
