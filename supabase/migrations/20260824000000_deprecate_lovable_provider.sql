-- ──────────────────────────────────────────────────────────────────────
-- Deprecate Lovable AI Gateway como provider.
--
-- Razón: el "Lovable AI Gateway" usaba la key compartida del proyecto
-- Lovable (LOVABLE_API_KEY) para ruterar a Gemini bajo el hood. Esa
-- key ya no se actualiza ni se mantiene; el flow correcto es que cada
-- tenant configure su propia GEMINI_API_KEY directa (o use la global
-- del SuperAdmin).
--
-- Síntoma reportado: error "La API key del proveedor de IA (lovable)
-- está inválida o expirada. Pídele al administrador que actualice el
-- secret LOVABLE_API_KEY…" al generar contenido en un tenant nuevo.
--
-- Fix:
--  1. Backfill: rows con `provider='lovable'` → `provider='gemini'`.
--     Si la fila tenía model "google/gemini-2.5-flash" lo cambiamos
--     a "gemini-2.5-flash" (formato Gemini directo, sin el prefijo
--     "google/" que era específico del gateway).
--  2. Actualizar el trigger `tg_provision_tenant_defaults` para que
--     tenants nuevos arranquen con `provider='gemini'` + key NULL
--     (caen al platform default del SuperAdmin si no configuran la
--     suya).
--  3. La columna `lovable_api_key` se mantiene por compat de schema
--     (no rompemos queries existentes que la SELECTean). Se puede
--     dropear en una migración futura cuando ningún código la
--     referencie.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) Backfill provider lovable → gemini ─────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.ai_model_settings') IS NOT NULL THEN
    UPDATE public.ai_model_settings
       SET provider = 'gemini',
           model = CASE
             WHEN model LIKE 'google/%' THEN substring(model FROM 'google/(.*)')
             ELSE model
           END,
           -- Limpiamos la key vieja por higiene. Si el admin necesita
           -- la nueva Gemini key, la pone en gemini_api_key.
           lovable_api_key = NULL
     WHERE provider = 'lovable';
    RAISE NOTICE 'Backfill: % rows actualizadas de lovable → gemini',
      (SELECT COUNT(*) FROM public.ai_model_settings WHERE provider = 'gemini');
  END IF;
END $$;

-- ── 2) Actualizar trigger de provisión de defaults para tenants nuevos
-- El trigger original (mig 20260821100000) hace `INSERT (tenant_id)
-- VALUES (NEW.id)` que toma los DEFAULTS del schema. Si el schema
-- todavía tiene DEFAULT 'lovable' para `provider`, los tenants nuevos
-- arrancarían con la opción deprecada. Reemplazamos para que el
-- trigger setee explícitamente `provider='gemini'`.
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

  RETURN NEW;
END;
$$;

-- ── 3) Cambiar DEFAULT del schema para que cualquier INSERT futuro sin
-- provider explícito caiga en 'gemini'. Idempotente.
DO $$
BEGIN
  IF to_regclass('public.ai_model_settings') IS NOT NULL THEN
    ALTER TABLE public.ai_model_settings
      ALTER COLUMN provider SET DEFAULT 'gemini';
    -- Si hay CHECK constraint con valores enumerados, lo actualizamos
    -- para QUITAR 'lovable' del enum permitido. El nombre del check
    -- puede variar — buscamos uno que contenga "provider".
    DECLARE
      v_check_name TEXT;
    BEGIN
      SELECT conname INTO v_check_name
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'ai_model_settings'
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) ILIKE '%provider%lovable%';
      IF v_check_name IS NOT NULL THEN
        EXECUTE format(
          'ALTER TABLE public.ai_model_settings DROP CONSTRAINT %I',
          v_check_name
        );
        ALTER TABLE public.ai_model_settings
          ADD CONSTRAINT chk_ai_model_settings_provider
          CHECK (provider IN ('openai', 'gemini'));
        RAISE NOTICE 'Provider CHECK constraint actualizado: lovable removido del enum';
      END IF;
    END;
  END IF;
END $$;

-- ── 4) Backfill: asegurar que tenants existentes sin row tienen una.
-- Defensivo — si la mig 20260821100000 no corrió en algún entorno o
-- algún tenant quedó sin row, la creamos acá con el provider correcto.
DO $$
BEGIN
  IF to_regclass('public.ai_model_settings') IS NOT NULL THEN
    INSERT INTO public.ai_model_settings (
      tenant_id, provider, model, is_active,
      gemini_api_key, openai_api_key, lovable_api_key
    )
    SELECT t.id, 'gemini', 'gemini-2.5-flash', true, NULL, NULL, NULL
      FROM public.tenants t
     WHERE NOT EXISTS (
       SELECT 1 FROM public.ai_model_settings s
        WHERE s.tenant_id = t.id
     );
  END IF;
END $$;
