-- ──────────────────────────────────────────────────────────────────────
-- handle_new_user: normalizar campos vacíos ("") → NULL (fix del 500
-- "Database error creating new user" al crear usuarios desde el Admin).
--
-- BUG RAÍZ
--   El form de crear usuario (app.admin.users.tsx) manda
--   `personal_email: editing.personal_email ?? ""` → cuando el admin deja
--   el campo en blanco llega "" (string VACÍO, no null). `handle_new_user`
--   lo insertaba crudo en `profiles.personal_email`.
--
--   El unique index `profiles_personal_email_lower_idx` (mig 20260514000000)
--   es PARCIAL: `... ON profiles (LOWER(personal_email)) WHERE personal_email
--   IS NOT NULL`. Un "" IS NOT NULL → SÍ entra al índice (LOWER("") = "").
--   El PRIMER usuario con personal vacío indexa "" sin problema; el SEGUNDO
--   choca con 23505 unique_violation. El handler de excepción de
--   handle_new_user solo sabe re-vincular un profile huérfano buscándolo por
--   `institutional_email` — como la colisión es por personal_email, no
--   encuentra nada (v_existing_profile_id NULL) y hace RAISE. Postgres
--   rollback-ea el INSERT en auth.users → Supabase Auth devuelve el 500
--   genérico "Database error creating new user".
--
--   Diag reportado calza exacto: error_status 500, diag_auth_user_exists
--   false (el auth user se revirtió), diag_orphan_profile_id null (no hay
--   profile con ESE institutional_email — el que colisiona es otro profile
--   con personal_email=""), diag_likely_cause "unknown_trigger_failure".
--   Explica además "antes funcionaba": basta que UN profile tenga
--   personal_email = "" para que todo create posterior con personal vacío
--   falle.
--
-- FIX (2 partes, idempotentes):
--   A. Limpieza: pasar a NULL los `personal_email = ''` ya existentes. Quita
--      la colisión presente y es semánticamente correcto ("" = sin email).
--   B. handle_new_user usa NULLIF(...,'') para personal_email (y por robustez
--      full_name / institutional_email) → un campo vacío entra como NULL y no
--      toca el índice parcial. El trigger es la autoridad; el cliente también
--      se ajusta a mandar null (defensa-en-profundidad), pero esto blinda el
--      flujo ante cualquier caller que mande "".
-- ──────────────────────────────────────────────────────────────────────

-- ─── A) Limpieza de los "" ya guardados ───────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    UPDATE public.profiles SET personal_email = NULL WHERE personal_email = '';
  END IF;
END $$;

-- ─── B) handle_new_user con NULLIF en los campos de texto ─────────────
-- Cuerpo idéntico al de mig 20260906000000 (tolerancia a unique_violation
-- por re-vinculación de huérfanos + gate de OAuth pre-aprovisionado), solo
-- cambian los VALUES del INSERT para normalizar "" → NULL.
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
    -- OAuth signup: exige pre-aprovisionamiento (mig 20260830000000).
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
      COALESCE(NULLIF(NEW.raw_user_meta_data->>'full_name', ''), split_part(NEW.email, '@', 1)),
      -- NULLIF: un personal_email "" entra como NULL y NO toca el índice
      -- parcial `WHERE personal_email IS NOT NULL` (evita la colisión por "").
      NULLIF(NEW.raw_user_meta_data->>'personal_email', ''),
      COALESCE(NULLIF(NEW.raw_user_meta_data->>'institutional_email', ''), NEW.email)
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
        RAISE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_existing_profile_id) THEN
        UPDATE public.profiles
           SET id = NEW.id,
               full_name = COALESCE(
                 NULLIF(NEW.raw_user_meta_data->>'full_name', ''),
                 profiles.full_name,
                 split_part(NEW.email, '@', 1)
               )
         WHERE id = v_existing_profile_id;
      ELSE
        RAISE;
      END IF;
  END;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'AFTER INSERT trigger en auth.users. Crea o re-vincula el profile. Normaliza campos de texto vacíos ("") → NULL para no chocar con el índice parcial de personal_email. Para OAuth signups exige pre-aprovisionamiento. Si hay un profile huérfano con el mismo email, lo re-vincula al NEW.id en lugar de fallar.';

NOTIFY pgrst, 'reload schema';
