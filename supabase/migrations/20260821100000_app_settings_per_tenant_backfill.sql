-- ──────────────────────────────────────────────────────────────────────
-- Fix: tenants nuevos quedaban sin row en `app_settings` y
-- `certificate_settings`, dejando el panel Admin → Configuración →
-- Generales colgado en "Cargando parámetros…" para siempre.
--
-- Causa:
--   - Migración 20260518130000: INSERT inicial de app_settings con
--     DEFAULT VALUES (singleton global).
--   - Migración 20260625000000: convirtió a per-tenant — UPDATE de la
--     row existente a tenant=default, agregó trigger auto-tenant_id en
--     INSERT, pero NO creó rows para tenants existentes ni para
--     futuros tenants.
--   - Resultado: cualquier tenant != default no tenía su row.
--     `.maybeSingle()` retorna null y el panel queda en loading.
--
-- Fix doble:
--   1. Backfill: INSERT de DEFAULTs para cada tenant que no tenga row.
--   2. Trigger AFTER INSERT en tenants → crea row default para el
--      tenant nuevo automáticamente.
--
-- Aplica a app_settings + certificate_settings (mismo problema).
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) Backfill rows faltantes ──
DO $$
BEGIN
  -- app_settings: una row por tenant.
  IF to_regclass('public.app_settings') IS NOT NULL THEN
    INSERT INTO public.app_settings (tenant_id)
    SELECT t.id
      FROM public.tenants t
     WHERE NOT EXISTS (
       SELECT 1 FROM public.app_settings s WHERE s.tenant_id = t.id
     );
    RAISE NOTICE 'app_settings backfill: % rows', (SELECT COUNT(*) FROM public.tenants);
  END IF;

  -- certificate_settings: misma idea.
  IF to_regclass('public.certificate_settings') IS NOT NULL THEN
    INSERT INTO public.certificate_settings (tenant_id)
    SELECT t.id
      FROM public.tenants t
     WHERE NOT EXISTS (
       SELECT 1 FROM public.certificate_settings s WHERE s.tenant_id = t.id
     );
    RAISE NOTICE 'certificate_settings backfill ok';
  END IF;
END $$;

-- ── 2) Trigger AFTER INSERT en tenants → crea rows default ──
-- SECURITY DEFINER para bypasear RLS — el contexto es "el sistema
-- está provisionando un tenant nuevo", no un user concreto.
CREATE OR REPLACE FUNCTION public.tg_provision_tenant_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Inserta SOLO la columna tenant_id; el resto toma defaults del schema.
  -- ON CONFLICT por si una row ya existe (idempotente para el caso de
  -- restore_tenant + alguna race condition).
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

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenants_provision_defaults ON public.tenants;
CREATE TRIGGER trg_tenants_provision_defaults
  AFTER INSERT ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.tg_provision_tenant_defaults();

COMMENT ON FUNCTION public.tg_provision_tenant_defaults() IS
  'Asegura que cada tenant nuevo arranque con su row default en app_settings + certificate_settings. Sin esto el panel Admin → Configuración queda en loading infinito.';
