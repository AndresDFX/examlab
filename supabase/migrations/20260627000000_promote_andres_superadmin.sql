-- ──────────────────────────────────────────────────────────────────────
-- One-off: promover a andres_dfx@hotmail.com como SuperAdmin.
--
-- Esta migración asigna el rol SuperAdmin (rol cross-tenant agregado en
-- la migración 20260621_tenants_foundation) al usuario existente con ese
-- email. Idempotente — si ya tiene el rol, no hace nada.
--
-- Después de aplicarse:
--   - El usuario aparece como SuperAdmin en useAuth().roles del cliente.
--   - El sidebar muestra la sección "Instituciones" (Fase 6).
--   - RLS de tenants y otras tablas le da bypass cross-tenant.
--   - NO requiere re-login: useAuth lee user_roles en cada mount → un
--     refresh basta para que el cliente vea el rol nuevo.
--
-- Si en el futuro hay que promover/demoter más usuarios, lo correcto
-- será hacerlo desde el panel SuperAdmin (todavía no implementado;
-- pendiente Fase 6 extendida). Por ahora migraciones one-off.
-- ──────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_uid   UUID;
  v_email TEXT := 'andres_dfx@hotmail.com';
BEGIN
  SELECT id INTO v_uid
    FROM auth.users
   WHERE LOWER(email) = LOWER(v_email);

  IF v_uid IS NULL THEN
    RAISE NOTICE 'No se encontró un usuario con email %. La migración se aplicó sin cambios — revisa el email y aplica otra migración si hay typo.',
      v_email;
    RETURN;
  END IF;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (v_uid, 'SuperAdmin'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  RAISE NOTICE 'Usuario % (id %) promovido a SuperAdmin.', v_email, v_uid;
END
$$;
