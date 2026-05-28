-- ──────────────────────────────────────────────────────────────────────
-- profiles.last_sign_in_at — replica del último login del usuario
--
-- El cliente NO puede consultar `auth.users` directamente (RLS de Supabase
-- impide acceso a esa tabla desde authenticated). Para mostrar "Último
-- acceso" en `/app/admin/users` necesitamos exponer ese dato en
-- `public.profiles`, que sí es legible vía RLS.
--
-- Solución: columna `last_sign_in_at` en `profiles`, sincronizada por un
-- trigger que escucha cambios de `auth.users.last_sign_in_at`. Los
-- usuarios que ya iniciaron sesión antes de esta migración se rellenan
-- con el backfill de abajo.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_sign_in_at TIMESTAMPTZ;

-- Backfill: copia el último sign-in actual de cada usuario.
UPDATE public.profiles p
SET last_sign_in_at = u.last_sign_in_at
FROM auth.users u
WHERE u.id = p.id
  AND p.last_sign_in_at IS DISTINCT FROM u.last_sign_in_at;

-- Trigger sync: cuando Supabase actualiza last_sign_in_at en auth.users
-- (lo hace en cada login), replicamos al profile. SECURITY DEFINER porque
-- el trigger corre con permisos del owner (puede escribir en profiles).
CREATE OR REPLACE FUNCTION public._sync_profile_last_sign_in()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.last_sign_in_at IS DISTINCT FROM OLD.last_sign_in_at THEN
    UPDATE public.profiles
    SET last_sign_in_at = NEW.last_sign_in_at
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_sync_profile_last_sign_in ON auth.users;
CREATE TRIGGER tg_sync_profile_last_sign_in
  AFTER UPDATE OF last_sign_in_at ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public._sync_profile_last_sign_in();

NOTIFY pgrst, 'reload schema';
