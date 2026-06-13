-- ═══════════════════════════════════════════════════════════════════════
-- handle_new_user: re-vinculación de huérfanos DETERMINISTA y solo-huérfanos.
--
-- Contexto: la auditoría del flujo de cambio de correo encontró que el
-- exception handler de UNIQUE_VIOLATION (mig 20260906000000) buscaba el
-- profile a re-vincular con:
--     SELECT p.id WHERE LOWER(institutional_email) = LOWER(NEW.email) LIMIT 1
-- SIN restringir a huérfanos y SIN orden determinista. Cuando coexisten un
-- profile HUÉRFANO (id sin auth.user vivo) y un profile VIVO con el MISMO
-- correo —caso posible si un admin acaba de cambiar el correo de OTRO usuario
-- a esa dirección vía admin-update-email + el trigger de sync 20260939—, el
-- LIMIT 1 podía elegir al VIVO. El guard `IF NOT EXISTS (auth.users...)` evita
-- robarle la identidad (en ese caso RAISE), pero el resultado es un FALLO
-- ESPURIO: la creación del usuario nuevo aborta aunque SÍ existía un huérfano
-- legítimo que debía re-vincularse.
--
-- Fix: buscar SOLO huérfanos (id sin auth.user vivo) y de forma determinista
-- (el más antiguo). Así:
--   - nunca se considera un profile vivo (imposible robar identidad),
--   - si hay un huérfano, siempre se re-vincula (no más fallo espurio),
--   - si NO hay huérfano (el correo pertenece a un usuario vivo, o el
--     conflicto es por otro UNIQUE) → RAISE, que es lo correcto.
--
-- Idéntico al resto de handle_new_user (gate OAuth, INSERT del profile);
-- solo cambia el bloque EXCEPTION.
-- ═══════════════════════════════════════════════════════════════════════

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
    -- OAuth signup: exige pre-aprovisionamiento.
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
      -- Buscar SOLO profiles HUÉRFANOS (id sin auth.user vivo) con este
      -- correo, de forma DETERMINISTA (el más antiguo). Nunca toca un
      -- profile vivo aunque otro usuario tenga el mismo correo.
      SELECT p.id INTO v_existing_profile_id
        FROM public.profiles p
       WHERE LOWER(p.institutional_email) = LOWER(NEW.email)
         AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id)
       ORDER BY p.created_at ASC
       LIMIT 1;

      IF v_existing_profile_id IS NULL THEN
        -- No hay huérfano que re-vincular: el correo pertenece a un usuario
        -- vivo (duplicado real) o el conflicto es por otro UNIQUE → RAISE.
        RAISE;
      END IF;

      -- Re-vincular el huérfano al auth.user nuevo (garantizado huérfano por
      -- el WHERE de arriba).
      UPDATE public.profiles
         SET id = NEW.id,
             full_name = COALESCE(
               NEW.raw_user_meta_data->>'full_name',
               profiles.full_name,
               split_part(NEW.email, '@', 1)
             )
       WHERE id = v_existing_profile_id;
  END;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'AFTER INSERT trigger en auth.users. Crea o re-vincula el profile. Para OAuth signups exige pre-aprovisionamiento. Si hay un profile HUÉRFANO (id sin auth.user vivo) con el mismo correo, re-vincula el más antiguo al NEW.id (determinista, nunca toca profiles vivos) — recupera bulk-imports parcialmente fallidos sin riesgo de robar identidad ante correos colisionantes.';
