-- ──────────────────────────────────────────────────────────────────────
-- Seed `module_visibility` per-tenant a partir del default global del
-- SuperAdmin cuando se crea un tenant.
--
-- Comportamiento deseado (clarificación del usuario):
--   "La organización en los otros roles aplica a la hora de crear el
--    tenant. Luego de creado, el administrador puede sobrescribir ese
--    orden. Cada tenant tiene su propio orden pero viene de la base
--    que creó el SuperAdmin en su momento."
--
-- Es decir: snapshot del global en el momento de creación. Si el SA
-- cambia el orden global DESPUÉS de crear el tenant, ese tenant NO se
-- actualiza automáticamente (el snapshot del Admin local no se pisa).
--
-- Implementación:
--   1. Extender `tg_provision_tenant_defaults` (mig 20260821100000 +
--      20260824000000) para copiar todas las filas globales
--      (`tenant_id IS NULL`) a filas per-tenant (`tenant_id = NEW.id`).
--      Si una fila ya existe (ON CONFLICT por el unique compuesto),
--      la dejamos — defensiva en caso de re-ejecución.
--   2. Backfill one-time para tenants existentes que NO tengan
--      override propio: copiar los globales como baseline. Idempotente
--      por el mismo ON CONFLICT.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_provision_tenant_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF to_regclass('public.app_settings') IS NOT NULL THEN
    INSERT INTO public.app_settings (tenant_id)
    VALUES (NEW.id)
    ON CONFLICT DO NOTHING;
  END IF;

  IF to_regclass('public.certificate_settings') IS NOT NULL THEN
    INSERT INTO public.certificate_settings (tenant_id)
    VALUES (NEW.id)
    ON CONFLICT DO NOTHING;
  END IF;

  -- ai_model_settings: row default por tenant con provider=gemini +
  -- keys NULL. Si el admin no configura su propia key, el resolver
  -- cae al platform default del SuperAdmin (mig 20260719000000).
  IF to_regclass('public.ai_model_settings') IS NOT NULL THEN
    INSERT INTO public.ai_model_settings (
      tenant_id, provider, model, is_active,
      gemini_api_key, openai_api_key, lovable_api_key
    )
    VALUES (
      NEW.id, 'gemini', 'gemini-2.5-flash', true,
      NULL, NULL, NULL
    )
    ON CONFLICT DO NOTHING;
  END IF;

  -- ── module_visibility: snapshot del global como baseline editable
  -- por el Admin de este tenant. Copiamos (module_key, role, enabled,
  -- display_order) de todas las filas con tenant_id IS NULL — esos
  -- son los defaults que definió el SA en su panel global. El Admin
  -- podrá sobrescribir cualquiera desde su propio panel.
  --
  -- ON CONFLICT DO NOTHING: si el unique compuesto (tenant_id,
  -- module_key, role) ya tiene una fila (raro al crear, pero
  -- defensivo en caso de re-trigger), no la pisamos.
  IF to_regclass('public.module_visibility') IS NOT NULL THEN
    INSERT INTO public.module_visibility (
      tenant_id, module_key, role, enabled, display_order, updated_by
    )
    SELECT NEW.id, module_key, role, enabled, display_order, NULL
      FROM public.module_visibility
     WHERE tenant_id IS NULL
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tg_provision_tenant_defaults() IS
  'Provisión automática al crear un tenant: app_settings, certificate_settings, ai_model_settings y SNAPSHOT de module_visibility (orden + visibilidad) desde los defaults globales del SuperAdmin. El Admin de cada tenant puede luego sobrescribir libremente sus propias filas sin afectar a otros tenants ni al global.';

-- ── Backfill one-time: para tenants existentes que NO tienen filas
-- de module_visibility (es decir, hoy heredan implícitamente del global
-- via el merge cliente), creamos su snapshot. Idempotente por el ON
-- CONFLICT.
DO $$
BEGIN
  IF to_regclass('public.module_visibility') IS NOT NULL
     AND to_regclass('public.tenants') IS NOT NULL THEN
    INSERT INTO public.module_visibility (
      tenant_id, module_key, role, enabled, display_order, updated_by
    )
    SELECT t.id, mv.module_key, mv.role, mv.enabled, mv.display_order, NULL
      FROM public.tenants t
      CROSS JOIN public.module_visibility mv
     WHERE mv.tenant_id IS NULL
       AND t.deleted_at IS NULL
       -- Solo tenants que NO tienen NINGUNA fila per-tenant todavía.
       -- Si ya tienen overrides parciales (algunos módulos editados),
       -- los respetamos: copiamos solo lo que falte vía ON CONFLICT.
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
