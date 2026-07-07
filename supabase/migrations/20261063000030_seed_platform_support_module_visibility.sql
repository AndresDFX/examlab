-- ──────────────────────────────────────────────────────────────────────
-- Seed: módulo `support_assistant` en `module_visibility`.
--
-- El "Asistente IA de plataforma" (ruta /app/admin/support-assistant) es
-- un chat de ayuda de uso de ExamLab para el Admin. Esta migración lo
-- registra en `module_visibility` para que aparezca en el panel
-- "Visibilidad y orden de módulos" y participe del sort.
--
-- Defaults:
--   - Admin      enabled=true  (destinatario principal del asistente).
--   - SuperAdmin enabled=true  (hereda el nav de Admin; RLS le deja usarlo).
--   - Docente / Estudiante: SIN fila (no hay ítem de nav para ellos).
--
-- display_order = 235: justo antes de "Soporte" (240) — primero intentas
-- el asistente de autoservicio y, si no resuelve, abres un ticket.
-- Guard to_regclass + ON CONFLICT DO NOTHING (idempotente).
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.module_visibility') IS NULL THEN
    RAISE NOTICE 'public.module_visibility no existe — se omite el seed';
    RETURN;
  END IF;

  INSERT INTO public.module_visibility (tenant_id, module_key, role, enabled, display_order)
  VALUES
    (NULL, 'support_assistant', 'Admin',      true, 235),
    (NULL, 'support_assistant', 'SuperAdmin', true, 235)
  ON CONFLICT (tenant_id, module_key, role) DO NOTHING;
END $$;

NOTIFY pgrst, 'reload schema';
