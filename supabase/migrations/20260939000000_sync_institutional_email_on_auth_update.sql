-- ============================================================================
-- Sincronización universal del correo de acceso
-- ============================================================================
-- El "correo de acceso" (login) vive en `auth.users.email` y se ESPEJA en
-- `public.profiles.institutional_email` (la app expone éste porque la RLS
-- bloquea leer auth.users directo, y `handle_new_user` / el bulk import
-- MATCHEAN usuarios por `LOWER(institutional_email)`).
--
-- Problema: hasta ahora SOLO la RPC `apply_email_change_now` (flujo de cambio
-- iniciado por el propio usuario) mantenía ambos en sincronía. Si `auth.users.email`
-- cambiaba por CUALQUIER otra vía (panel de Supabase, SQL directo, una edge que
-- llame `auth.admin.updateUserById({email})`), `profiles.institutional_email`
-- quedaba con el correo viejo → el usuario "perdía" su identidad para los flujos
-- que matchean por correo (re-import duplicaría el usuario / chocaría contra el
-- índice único, SSO fallaría con UNIQUE violation, etc.).
--
-- Fix universal: un trigger AFTER UPDATE OF email sobre auth.users que propaga
-- el nuevo correo a profiles.institutional_email AUTOMÁTICAMENTE, sin importar
-- quién haya hecho el cambio. Así `auth.users.email` es la ÚNICA fuente de
-- verdad y profiles.institutional_email siempre la refleja.
--
-- Defensiva (CLAUDE.md): envolver en guards `to_regclass` por si las tablas no
-- existen en el entorno donde Lovable aplica la migración.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._sync_profile_institutional_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Espeja el nuevo correo de login al profile. `IS DISTINCT FROM` evita
  -- escrituras redundantes (y no toca filas si ya coincide, ej. cuando
  -- apply_email_change_now ya actualizó ambas en su transacción).
  UPDATE public.profiles
     SET institutional_email = NEW.email
   WHERE id = NEW.id
     AND institutional_email IS DISTINCT FROM NEW.email;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('auth.users') IS NOT NULL
     AND to_regclass('public.profiles') IS NOT NULL THEN
    -- (Re)crear el trigger de forma idempotente.
    DROP TRIGGER IF EXISTS tg_sync_profile_institutional_email ON auth.users;
    CREATE TRIGGER tg_sync_profile_institutional_email
      AFTER UPDATE OF email ON auth.users
      FOR EACH ROW
      WHEN (OLD.email IS DISTINCT FROM NEW.email)
      EXECUTE FUNCTION public._sync_profile_institutional_email();

    -- Backfill: corregir cualquier desincronización HISTÓRICA. La fuente de
    -- verdad es auth.users.email (es con lo que el usuario inicia sesión), así
    -- que profiles se alinea a él. Solo filas realmente divergentes.
    UPDATE public.profiles p
       SET institutional_email = u.email
      FROM auth.users u
     WHERE p.id = u.id
       AND u.email IS NOT NULL
       AND LOWER(COALESCE(p.institutional_email, '')) <> LOWER(u.email);
  END IF;
END $$;

REVOKE ALL ON FUNCTION public._sync_profile_institutional_email() FROM PUBLIC;
