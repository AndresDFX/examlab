-- ──────────────────────────────────────────────────────────────────────
-- Forzar cambio de contraseña en el primer inicio de sesión
--
-- Los usuarios los crea el Admin/SuperAdmin con una contraseña temporal
-- (bulk-import-users). En el primer login deben cambiarla antes de usar
-- la app. Marcamos eso con `profiles.must_change_password`:
--   - true  → la app muestra un diálogo bloqueante (ForceChangePasswordDialog)
--             hasta que el usuario setea una contraseña nueva.
--   - false → flujo normal.
--
-- Quién la pone en true:
--   - bulk-import-users (edge) al CREAR un usuario nuevo (contraseña temp).
--   - admin-update-password (edge) cuando un Admin resetea la contraseña
--     de otro usuario → ese usuario debe re-cambiarla.
-- Quién la pone en false:
--   - El propio usuario al cambiar su contraseña (ForceChangePasswordDialog
--     o ChangePasswordDialog) — UPDATE sobre su propia fila (RLS
--     "Users update own profile" ya lo permite).
--
-- Backfill: los usuarios EXISTENTES quedan en false (ya tienen contraseña
-- en uso; no los forzamos retroactivamente).
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;

NOTIFY pgrst, 'reload schema';
