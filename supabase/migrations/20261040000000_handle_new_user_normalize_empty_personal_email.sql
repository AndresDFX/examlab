-- ══════════════════════════════════════════════════════════════════════
-- CAUSA DE FONDO — bulk import "Database error creating new user" (FESNA).
--
-- Reproducido contra prod: al importar estudiantes con `personal_email` VACÍO
-- (columna en blanco del CSV → el edge manda `personal_email = ''`),
-- handle_new_user insertaba en profiles `personal_email = ''` TAL CUAL. El
-- índice único parcial:
--     profiles_personal_email_lower_idx = UNIQUE (lower(personal_email))
--                                         WHERE personal_email IS NOT NULL
-- trata `''` como un VALOR (solo excluye NULL). Como ya existía ≥1 profile con
-- personal_email='' (y entre sí las filas del import también chocan), el INSERT
-- viola el índice → unique_violation. El handler de excepción de handle_new_user
-- solo sabe re-vincular huérfanos por INSTITUTIONAL_email; el choque es por
-- personal_email → no encuentra huérfano → RAISE → GoTrue devuelve
-- 500 "Database error creating new user" en TODAS las filas.
-- (diag_likely_cause='unknown_trigger_failure' en audit_logs, sin duplicado ni
--  huérfano — el fallo NO era del path de institutional_email arreglado en
--  20260906, sino este otro trigger.)
--
-- FIX (raíz): normalizar cadena vacía / whitespace → NULL antes de insertar. El
-- índice parcial ignora NULL (y Postgres permite múltiples NULL), así que los
-- usuarios sin correo personal ya no colisionan. Se aplica a personal_email
-- (el que rompía) y, defensivamente, a full_name/institutional_email.
-- Además se limpia la deuda: los profiles existentes con personal_email='' → NULL.
--
-- Resto de la lógica (SSO provisioning, re-vinculación de huérfanos por
-- institutional_email) se copia VERBATIM de la versión vigente.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data->>'full_name'), ''), split_part(NEW.email, '@', 1)),
      -- CLAVE: '' / whitespace → NULL para no chocar con el índice único parcial
      -- de personal_email (que solo excluye NULL, no la cadena vacía).
      NULLIF(TRIM(NEW.raw_user_meta_data->>'personal_email'), ''),
      COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data->>'institutional_email'), ''), NEW.email)
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
               NULLIF(TRIM(NEW.raw_user_meta_data->>'full_name'), ''),
               profiles.full_name,
               split_part(NEW.email, '@', 1)
             )
       WHERE id = v_existing_profile_id;
  END;
  RETURN NEW;
END;
$function$;

-- Limpieza de deuda: normalizar los personal_email='' existentes a NULL para
-- que el índice único parcial solo contenga correos reales.
DO $$ BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    UPDATE public.profiles SET personal_email = NULL WHERE personal_email = '';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
