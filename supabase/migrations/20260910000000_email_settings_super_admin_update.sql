-- ──────────────────────────────────────────────────────────────────────
-- email_settings: permitir UPDATE al SuperAdmin.
--
-- Bug: la mig original 20260523000009_email_settings.sql creó la policy
-- `email_settings_update_admin` con `has_role(_,'Admin')` only. Como
-- `email_settings` es una tabla SINGLETON GLOBAL (id=1), tanto el Admin
-- del tenant (cualquier tenant) como el SA gestionan los mismos toggles
-- — pero el SA recibía 403 al guardar desde el tab "Correos" del panel
-- `/app/superadmin/system` que se agregó recientemente.
--
-- Fix: paralelo al patrón establecido (mig 20260903100000 para
-- db_backups, 20260908000000 para storage de generated-contents):
-- extender la policy con `OR public.is_super_admin()`.
--
-- El comportamiento del Admin NO cambia.
-- ──────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF to_regclass('public.email_settings') IS NOT NULL THEN
    DROP POLICY IF EXISTS email_settings_update_admin ON public.email_settings;
    CREATE POLICY email_settings_update_admin
      ON public.email_settings FOR UPDATE TO authenticated
      USING (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin())
      WITH CHECK (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin());
  END IF;
END $$;
