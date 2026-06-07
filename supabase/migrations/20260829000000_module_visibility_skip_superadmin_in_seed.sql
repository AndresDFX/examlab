-- ──────────────────────────────────────────────────────────────────────
-- Fix: el seed per-tenant nunca debe crear filas con role='SuperAdmin'.
--
-- Causa: la mig 20260828000000 copia el global a cada tenant para que
-- el Admin tenga un baseline editable. Pero esa COPY incluye TODOS los
-- roles (Admin, Docente, Estudiante, SuperAdmin). El rol SuperAdmin
-- NO debería materializarse per-tenant porque:
--
--   1. El panel "Módulos" en scope tenant oculta la columna
--      SuperAdmin (refactor previo). Un Admin de un tenant no puede
--      editar esas filas — pero si existen como "shadow", el merge
--      cliente las lee igual.
--
--   2. Cuando el SA (cross-tenant) carga su mapa de visibilidad, el
--      merge prioriza tenant > global. Múltiples tenant rows para el
--      mismo (módulo, SuperAdmin) hacen que el ÚLTIMO iterado gane
--      (orden no determinístico de Postgres) — los toggles del SA en
--      el panel global quedan shadow-eados por filas con valores
--      stale (típicamente del seed inicial enabled=true para todo).
--
-- Síntoma reportado por el usuario:
--   "Quité Certificados del módulo SuperAdmin y aún así sigue apareciendo"
--   → causada exactamente por esto: FESNA tenía `(certificates,
--   SuperAdmin, enabled=true)` shadow del seed inicial, ganaba sobre
--   el global toggleado a false.
--
-- Fix:
--   1. Backfill: DELETE de TODAS las filas (role='SuperAdmin' AND
--      tenant_id IS NOT NULL). No hay info que perder — esas filas
--      nunca debieron existir.
--   2. Recreate el trigger `tg_provision_tenant_defaults` para que el
--      INSERT del seed FILTRE `role != 'SuperAdmin'`. Tenants nuevos
--      arrancan con baseline solo de los 3 roles del scope tenant.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) Cleanup ────────────────────────────────────────────────────────
DELETE FROM public.module_visibility
 WHERE role = 'SuperAdmin'
   AND tenant_id IS NOT NULL;

-- ── 2) Recrear trigger sin la fila SuperAdmin en el seed ──────────────
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

  -- module_visibility: snapshot SOLO de los roles del scope tenant
  -- (Admin / Docente / Estudiante). El rol SuperAdmin se gestiona
  -- exclusivamente desde el panel global (tenant_id IS NULL) — no
  -- materializamos shadows per-tenant que romperían el merge cliente.
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

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tg_provision_tenant_defaults() IS
  'Provisión automática al crear un tenant: app_settings, certificate_settings, ai_model_settings y snapshot de module_visibility (Admin/Docente/Estudiante solamente — SuperAdmin se gestiona desde el panel global). El Admin de cada tenant puede luego sobrescribir libremente sus propias filas sin afectar a otros tenants ni al global.';

NOTIFY pgrst, 'reload schema';
