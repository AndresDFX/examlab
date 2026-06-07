-- ──────────────────────────────────────────────────────────────────────
-- handle_new_user: tolerar UNIQUE violation contra `profiles` huérfanos.
--
-- Bug raíz del bulk-import:
--   Cuando un import fallido a mitad deja `profiles` huérfanos (sin fila
--   correspondiente en `auth.users`), el siguiente intento de crear el
--   mismo usuario falla así:
--     1. Auth.createUser inserta en `auth.users` → trigger
--        `on_auth_user_created` dispara `handle_new_user`.
--     2. `handle_new_user` hace `INSERT INTO profiles (id, ...email...)`
--        ON CONFLICT (id) DO NOTHING — pero el unique index
--        `profiles_institutional_email_lower_idx` (mig 20260514000000)
--        NO está cubierto por ese ON CONFLICT.
--     3. Choca: 23505 unique_violation → Postgres rollback-ea el INSERT
--        en `auth.users` → Supabase Auth devuelve "Database error
--        creating new user" sin nombrar la causa.
--
-- Resultado reportado: el primer usuario del CSV pasa (su email no
-- existe en profiles), los siguientes 92 chocan contra residuos de
-- intentos previos y fallan con error genérico.
--
-- Fix: envolver el INSERT en BEGIN/EXCEPTION que captura
-- `unique_violation`. Si choca por email duplicado, intentamos
-- "re-vincular" el profile huérfano al `auth.users.id` nuevo —
-- el profile ya existe con el email correcto, pero su `id` apunta a
-- un auth.user borrado. Hacemos UPDATE en lugar de fallar.
--
-- Si el conflicto NO es por email (otro UNIQUE inesperado), RAISE para
-- que el error real aparezca en los logs (no swallow silent).
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_provider TEXT;
  v_match_exists BOOLEAN;
  v_existing_profile_id UUID;
BEGIN
  v_provider := COALESCE(NEW.raw_app_meta_data->>'provider', 'email');

  IF v_provider NOT IN ('email', 'phone') THEN
    -- OAuth signup: exige pre-aprovisionamiento (mismo comportamiento
    -- que la migración 20260830000000).
    SELECT EXISTS (
      SELECT 1 FROM public.profiles
       WHERE LOWER(institutional_email) = LOWER(NEW.email)
          OR LOWER(personal_email) = LOWER(NEW.email)
    ) INTO v_match_exists;

    IF NOT v_match_exists THEN
      RAISE EXCEPTION 'SSO_NOT_PROVISIONED: El correo % no está registrado en la plataforma. Pídele a un administrador que cree tu cuenta antes de intentar el inicio de sesión con SSO.', NEW.email
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- INSERT del profile. Si choca por:
  --   - PK (id ya existe): silent (la fila ya está, otro flow la creó).
  --   - unique_violation contra institutional_email_lower: detectar si
  --     hay un profile huérfano (id apunta a auth.user inexistente) y
  --     re-vincularlo al NEW.id. Eso recupera el flujo del bulk-import
  --     cuando hubo intentos parciales previos.
  BEGIN
    INSERT INTO public.profiles (id, full_name, personal_email, institutional_email)
    VALUES (
      NEW.id,
      COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
      NEW.raw_user_meta_data->>'personal_email',
      COALESCE(NEW.raw_user_meta_data->>'institutional_email', NEW.email)
    )
    ON CONFLICT (id) DO NOTHING;
  EXCEPTION
    WHEN unique_violation THEN
      -- Buscar el profile que tiene este email pero con un id distinto.
      SELECT p.id INTO v_existing_profile_id
        FROM public.profiles p
       WHERE LOWER(p.institutional_email) = LOWER(NEW.email)
       LIMIT 1;

      IF v_existing_profile_id IS NULL THEN
        -- No es nuestro caso conocido — re-RAISE para no esconder el error.
        RAISE;
      END IF;

      -- Si el profile existente apunta a un auth.user que YA NO existe
      -- (huérfano de intento previo), re-vinculamos su id al NEW.id.
      -- Si apunta a un auth.user vivo, NO tocamos nada — es duplicado
      -- legítimo y dejamos que el error suba.
      IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_existing_profile_id) THEN
        UPDATE public.profiles
           SET id = NEW.id,
               full_name = COALESCE(
                 NEW.raw_user_meta_data->>'full_name',
                 profiles.full_name,
                 split_part(NEW.email, '@', 1)
               )
         WHERE id = v_existing_profile_id;
        -- El profile ahora apunta correctamente al auth.user nuevo.
        -- INSERT en auth.users sigue, todo OK.
      ELSE
        -- Email duplicado de un user vivo — esto es bug real, RAISE.
        RAISE;
      END IF;
  END;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'AFTER INSERT trigger en auth.users. Crea o re-vincula el profile. Para OAuth signups exige pre-aprovisionamiento. Si hay un profile huérfano (id apuntando a auth.user borrado) con el mismo email, lo re-vincula al NEW.id en lugar de fallar — recupera bulk-imports parcialmente fallidos.';
