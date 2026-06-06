-- ──────────────────────────────────────────────────────────────────────
-- Seed: módulo `trash` en `module_visibility`.
--
-- El módulo "Papelera" (ruta /app/trash) existe tras la migración
-- 20260816000000 (soft-delete columns + cron de purga). Esta migración
-- lo registra en `module_visibility` para que aparezca en el panel
-- Admin "Visibilidad y orden de módulos" y participe del sort.
--
-- Defaults:
--   - Docente    enabled=true  (puede restaurar lo que él u otro docente
--                                del mismo curso borró; RLS aplica).
--   - Admin      enabled=true  (gestiona la papelera de su tenant).
--   - SuperAdmin enabled=true  (cross-tenant; RLS le permite ver todo).
--   - Estudiante enabled=false (no tiene capacidad de borrar las 8
--                                entidades soft-deletables; la papelera
--                                no le aplica).
--
-- display_order = 250: al FINAL del menú. La papelera es utility, no
-- módulo de trabajo cotidiano. Cuando el admin guarda orden desde el
-- panel, los valores se renormalizan a múltiplos de 10.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.module_visibility') IS NULL THEN
    RAISE NOTICE 'public.module_visibility no existe — se omite el seed';
    RETURN;
  END IF;

  INSERT INTO public.module_visibility (tenant_id, module_key, role, enabled, display_order)
  VALUES
    (NULL, 'trash', 'Docente',    true,  250),
    (NULL, 'trash', 'Admin',      true,  250),
    (NULL, 'trash', 'SuperAdmin', true,  250),
    (NULL, 'trash', 'Estudiante', false, 250)
  ON CONFLICT (tenant_id, module_key, role) DO NOTHING;
END $$;

NOTIFY pgrst, 'reload schema';
