-- ═══════════════════════════════════════════════════════════════════════
-- Judge0 como compilador + configuración de ejecución POR INSTITUCIÓN.
--
-- Tres cambios, en este orden:
--
--  1) Judge0 NO entra como provider nuevo: Judge0 ES lo que corre en la VM
--     propia, detrás del provider `aws_lambda` que ya existe. Agregarlo como
--     quinta opción obligaría al admin a elegir entre "el Lambda" y "Judge0"
--     siendo lo mismo. El CHECK queda igual (4 providers); lo que cambia es que
--     `aws_lambda` ahora ejecuta Kotlin (ver `language-support.ts`).
--
--  2) `tenant_id` en `code_execution_settings`. Hasta ahora la tabla era un
--     singleton GLOBAL (una fila con `is_active`), así que todas las
--     instituciones compartían compilador: no se podía dar Judge0 propio a una
--     y dejar las demás en OnlineCompiler. Ahora `tenant_id IS NULL` = default
--     de plataforma y una fila con `tenant_id` = override de esa institución.
--     Mismo patrón de resolución que `ai_model_settings`.
--
--  3) Se CIERRA un agujero que el punto 2 abriría. La policy vigente es
--     `has_role(auth.uid(),'Admin') OR is_super_admin()` SIN scope de tenant
--     (mig 20260714000000). Con la tabla global eso era solo un tema de
--     privilegio; con `tenant_id` se vuelve un leak de ESCRITURA cross-tenant:
--     el Admin de la institución A podría cambiarle el compilador a la B. Es
--     exactamente el anti-patrón documentado en CLAUDE.md ("has_role en una
--     policy SIN scope de tenant = leak cross-tenant").
--
-- El SELECT sigue abierto a `authenticated` A PROPÓSITO: el alumno necesita
-- resolver el proveedor durante un examen. La tabla no guarda secretos — las
-- credenciales de cada proveedor viven como env vars del edge.
--
-- Defensiva: sale limpio si la tabla no existe (Lovable a veces marca
-- migraciones como aplicadas sin que el CREATE TABLE haya corrido, y una
-- migración que falla ABORTA el deploy completo).
-- ═══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.code_execution_settings') IS NULL THEN
    RAISE NOTICE 'code_execution_settings no existe — se omite la migración.';
    RETURN;
  END IF;

  -- ── 1) judge0 como provider válido ─────────────────────────────────────
  ALTER TABLE public.code_execution_settings
    DROP CONSTRAINT IF EXISTS code_execution_settings_provider_check;
  ALTER TABLE public.code_execution_settings
    ADD CONSTRAINT code_execution_settings_provider_check
    CHECK (provider IN ('onlinecompiler', 'jdoodle', 'cheerp', 'aws_lambda', 'judge0'));

  -- ── 2) tenant_id (NULL = default de plataforma) ────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'code_execution_settings'
       AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE public.code_execution_settings
      ADD COLUMN tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Una sola fila activa POR institución (y una sola para el default de
-- plataforma). `COALESCE` es necesario: en un índice UNIQUE los NULL se
-- consideran distintos entre sí, así que sin él podrían coexistir varias filas
-- activas de plataforma — el bug clásico de este patrón.
DROP INDEX IF EXISTS code_execution_settings_active_per_tenant;
CREATE UNIQUE INDEX IF NOT EXISTS code_execution_settings_active_per_tenant
  ON public.code_execution_settings (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_active;

-- ── 3) RLS con scope de tenant ───────────────────────────────────────────
-- SELECT: cualquier autenticado (el alumno lo necesita en examen). No hay
-- secretos en la tabla.
DROP POLICY IF EXISTS "code_execution_settings_select" ON public.code_execution_settings;
CREATE POLICY "code_execution_settings_select"
  ON public.code_execution_settings FOR SELECT TO authenticated
  USING (true);

-- WRITE: el Admin gestiona SOLO la fila de SU institución; el SuperAdmin todas
-- (incluida la de plataforma, `tenant_id IS NULL`).
DROP POLICY IF EXISTS "Admin can manage code_execution_settings" ON public.code_execution_settings;
DROP POLICY IF EXISTS "code_execution_settings_admin_manage" ON public.code_execution_settings;
CREATE POLICY "code_execution_settings_admin_manage"
  ON public.code_execution_settings FOR ALL TO authenticated
  USING (
    public.is_super_admin()
    OR (
      public.has_role(auth.uid(), 'Admin')
      AND tenant_id IS NOT NULL
      AND tenant_id = public.current_tenant_id()
    )
  )
  WITH CHECK (
    public.is_super_admin()
    OR (
      public.has_role(auth.uid(), 'Admin')
      AND tenant_id IS NOT NULL
      AND tenant_id = public.current_tenant_id()
    )
  );

-- ── Resolución del ajuste efectivo ───────────────────────────────────────
-- SECURITY DEFINER para poder leer la fila de plataforma (`tenant_id IS NULL`)
-- sin depender de la RLS del caller, y devolver SIEMPRE algo usable.
-- Precedencia: fila activa del tenant del caller → fila activa de plataforma →
-- defaults duros. El edge y la UI consumen ESTA función, así que el
-- "compilador por defecto" es el mismo en toda la app por construcción.
CREATE OR REPLACE FUNCTION public.get_active_code_execution_settings()
RETURNS TABLE (
  provider TEXT,
  java_gui_provider TEXT,
  python_gui_provider TEXT,
  tenant_id UUID,
  is_tenant_override BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _tenant UUID;
BEGIN
  IF to_regclass('public.code_execution_settings') IS NULL THEN
    RETURN QUERY SELECT 'onlinecompiler'::TEXT, 'cheerp'::TEXT, 'aws_screenshot'::TEXT, NULL::UUID, false;
    RETURN;
  END IF;

  _tenant := public.current_tenant_id();

  IF _tenant IS NOT NULL THEN
    RETURN QUERY
      SELECT s.provider, s.java_gui_provider, s.python_gui_provider, s.tenant_id, true
        FROM public.code_execution_settings s
       WHERE s.is_active AND s.tenant_id = _tenant
       LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  RETURN QUERY
    SELECT s.provider, s.java_gui_provider, s.python_gui_provider, s.tenant_id, false
      FROM public.code_execution_settings s
     WHERE s.is_active AND s.tenant_id IS NULL
     LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- Ni override ni default de plataforma: se responde algo usable en vez de
  -- vacío, para que el alumno no quede sin poder ejecutar.
  RETURN QUERY SELECT 'onlinecompiler'::TEXT, 'cheerp'::TEXT, 'aws_screenshot'::TEXT, NULL::UUID, false;
END;
$$;

REVOKE ALL ON FUNCTION public.get_active_code_execution_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_active_code_execution_settings() TO authenticated, service_role;

COMMENT ON FUNCTION public.get_active_code_execution_settings() IS
  'Ajuste de ejecución de código efectivo para el tenant del caller: override del tenant → default de plataforma → defaults duros. La consumen el edge execute-code y la UI, para que el compilador por defecto sea el mismo en toda la app.';

NOTIFY pgrst, 'reload schema';
