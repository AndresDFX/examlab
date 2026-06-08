-- ──────────────────────────────────────────────────────────────────────
-- Fix: al crear un tenant NO se sembraban sus prompts GLOBALES de IA
-- (ai_prompts con course_id IS NULL). El trigger tg_provision_tenant_defaults
-- (migs 20260821100000 / 20260824000000 / 20260828000000 / 20260829000000)
-- ya sembraba app_settings, certificate_settings, ai_model_settings y el
-- snapshot de module_visibility — pero NUNCA ai_prompts.
--
-- Síntoma reportado (tenant FESNA): el panel de Prompts (Docente y Admin)
-- mostraba "(sin prompt global definido)" en los 10 casos de uso, sin nada
-- que heredar/ver. (La calificación igual funcionaba por el fallback
-- hardcodeado del edge `resolveSystemPrompt`, pero el global no era visible
-- ni editable.)
--
-- Jerarquía de resolución (mig 20260718000000):
--   1. course override  (course_id NOT NULL)
--   2. tenant global     (course_id IS NULL, tenant_id = <tenant>)
--   3. PLATFORM DEFAULT  (course_id IS NULL, tenant_id IS NULL)  ← SuperAdmin
--   4. fallback hardcodeado en el edge
--
-- IMPORTANTE — fuente de la copia: NO se asume un tenant 'default' (en
-- producción ese tenant fue renombrado; verificado en vivo: los globales
-- históricos viven en el tenant más antiguo, no en uno con slug='default').
-- Se usa una fuente SOURCE-AGNOSTIC: por cada use_case, la fila global
-- existente más antigua, prefiriendo el platform-default (tenant_id IS NULL)
-- si ya está sembrado. CHECK-safe: COPIA filas que ya existen (nunca inserta
-- use_cases hardcodeados que podrían violar el CHECK de use_case).
--
-- Fix (3 partes, idempotentes):
--   A. Sembrar el PLATFORM DEFAULT (tenant_id IS NULL) copiándolo de los
--      globales existentes (capa 3 + "global de referencia" del SA).
--   B. Extender tg_provision_tenant_defaults para que cada tenant NUEVO
--      reciba su snapshot de globales (capa 2).
--   C. Backfill: sembrar los globales per-tenant para TODOS los tenants
--      existentes que no los tengan (cubre FESNA).
-- ──────────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════════
-- A) PLATFORM DEFAULT (tenant_id IS NULL): copiar de los globales de
--    tenant existentes (el más antiguo por use_case). Idempotente vía el
--    unique parcial idx_ai_prompts_platform_default(use_case)
--    WHERE course_id IS NULL AND tenant_id IS NULL.
-- ════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.ai_prompts') IS NOT NULL THEN
    INSERT INTO public.ai_prompts (use_case, course_id, tenant_id, system_prompt)
    SELECT s.use_case, NULL::uuid, NULL::uuid, s.system_prompt
      FROM (
        SELECT DISTINCT ON (ap.use_case) ap.use_case, ap.system_prompt
          FROM public.ai_prompts ap
         WHERE ap.course_id IS NULL
           AND ap.tenant_id IS NOT NULL
         ORDER BY ap.use_case, ap.created_at ASC
      ) s
    ON CONFLICT (use_case) WHERE course_id IS NULL AND tenant_id IS NULL
      DO NOTHING;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- B) Extender el trigger de provisión. Reproduce EXACTAMENTE el cuerpo de
--    la mig 20260829000000 (app_settings, certificate_settings,
--    ai_model_settings, module_visibility sin SuperAdmin) + agrega el
--    bloque ai_prompts. Mantener sincronizado si se vuelve a editar.
-- ════════════════════════════════════════════════════════════════════
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

  -- ai_model_settings: provider=gemini + keys NULL (mig 20260824000000).
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

  -- module_visibility: snapshot SOLO de roles del scope tenant
  -- (Admin / Docente / Estudiante). SuperAdmin se gestiona desde el panel
  -- global (mig 20260829000000).
  IF to_regclass('public.module_visibility') IS NOT NULL THEN
    INSERT INTO public.module_visibility (
      tenant_id, module_key, role, enabled, display_order, updated_by
    )
    SELECT NEW.id, module_key, role, enabled, display_order, NULL
      FROM public.module_visibility
     WHERE tenant_id IS NULL
       AND role <> 'SuperAdmin'
    ON CONFLICT DO NOTHING;
  END IF;

  -- ai_prompts: snapshot de los prompts GLOBALES (course_id IS NULL) como
  -- baseline editable por el Admin del tenant. Copia UNA fila por use_case
  -- desde la fuente canónica: prefiere el PLATFORM DEFAULT (tenant_id IS
  -- NULL); si no existe, la fila global más antigua de cualquier tenant.
  -- Sin secretos (solo system_prompt). CHECK-safe (copia filas existentes).
  -- Idempotente vía idx_ai_prompts_global_per_tenant.
  IF to_regclass('public.ai_prompts') IS NOT NULL THEN
    INSERT INTO public.ai_prompts (use_case, course_id, system_prompt, tenant_id)
    SELECT s.use_case, NULL::uuid, s.system_prompt, NEW.id
      FROM (
        SELECT DISTINCT ON (ap.use_case) ap.use_case, ap.system_prompt
          FROM public.ai_prompts ap
         WHERE ap.course_id IS NULL
         ORDER BY ap.use_case, (ap.tenant_id IS NOT NULL) ASC, ap.created_at ASC
      ) s
    ON CONFLICT (tenant_id, use_case) WHERE course_id IS NULL
      DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tg_provision_tenant_defaults() IS
  'Provisión automática al crear un tenant: app_settings, certificate_settings, ai_model_settings, snapshot de module_visibility (Admin/Docente/Estudiante) y snapshot de los prompts globales de IA (ai_prompts course_id IS NULL). El Admin de cada tenant puede sobrescribir sus propias filas sin afectar a otros tenants ni al global.';

-- ════════════════════════════════════════════════════════════════════
-- C) Backfill one-time: sembrar los globales per-tenant para todos los
--    tenants existentes que no los tengan (cubre FESNA y cualquier otro
--    creado antes de este fix). Idempotente por el ON CONFLICT. La fuente
--    prefiere el platform-default recién sembrado en (A); si no, la fila
--    global más antigua de cualquier tenant.
-- ════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  r RECORD;
BEGIN
  IF to_regclass('public.ai_prompts') IS NOT NULL
     AND to_regclass('public.tenants') IS NOT NULL THEN
    FOR r IN SELECT id FROM public.tenants WHERE deleted_at IS NULL LOOP
      INSERT INTO public.ai_prompts (use_case, course_id, system_prompt, tenant_id)
      SELECT s.use_case, NULL::uuid, s.system_prompt, r.id
        FROM (
          SELECT DISTINCT ON (ap.use_case) ap.use_case, ap.system_prompt
            FROM public.ai_prompts ap
           WHERE ap.course_id IS NULL
           ORDER BY ap.use_case, (ap.tenant_id IS NOT NULL) ASC, ap.created_at ASC
        ) s
      ON CONFLICT (tenant_id, use_case) WHERE course_id IS NULL
        DO NOTHING;
    END LOOP;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
