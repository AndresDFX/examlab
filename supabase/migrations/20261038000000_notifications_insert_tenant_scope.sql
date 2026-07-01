-- ══════════════════════════════════════════════════════════════════════
-- Notificaciones: cerrar el spoofing/phishing cross-tenant en el INSERT.
--
-- Hallazgo (validación rol-a-rol, ciclo 6, 2026-06-30): la policy
-- `notifications_insert` permitía:
--   (auth.uid() = user_id)                          -- auto-notificarse (OK)
--   OR has_role('Admin')                            -- ⚠ GLOBAL, sin tenant
--   OR (has_role('Docente') AND kind IN (...))      -- ⚠ GLOBAL, sin tenant
-- Como has_role es un rol GLOBAL, un Docente/Admin de CUALQUIER institución
-- podía INSERTAR una notificación para CUALQUIER user_id (otra institución,
-- otro curso) con title/body/link arbitrarios. El `link` se renderiza como
-- acción "Ver" clickeable en el toast/campana → vector de PHISHING cross-tenant
-- (ej. "🔒 Verifica tu cuenta" → link malicioso) a usuarios de otra institución.
--
-- Fix: scopear las ramas de rol a MISMO TENANT (el user_id destino debe
-- pertenecer al tenant del caller) + `OR is_super_admin()` (el dueño de
-- plataforma sí puede cross-tenant). La rama de auto-notificación
-- (auth.uid() = user_id) se preserva. Los flujos legítimos del docente
-- (notificar a estudiantes de SU curso, que son del mismo tenant: asignar
-- examen/taller/proyecto) y del admin (auto-test de push) siguen funcionando.
-- Las notificaciones del sistema (triggers/edges) van por service_role → RLS
-- bypass, no afectadas.
-- ══════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF to_regclass('public.notifications') IS NOT NULL THEN
    ALTER POLICY notifications_insert ON public.notifications
    WITH CHECK (
      (auth.uid() = user_id)
      OR (
        (
          has_role(auth.uid(), 'Admin'::app_role)
          OR (
            has_role(auth.uid(), 'Docente'::app_role)
            AND kind = ANY (ARRAY['exam'::text, 'info'::text, 'grade'::text, 'workshop'::text, 'system'::text])
          )
        )
        AND EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = notifications.user_id
            AND p.tenant_id = public.current_tenant_id()
        )
      )
      OR public.is_super_admin()
    );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
