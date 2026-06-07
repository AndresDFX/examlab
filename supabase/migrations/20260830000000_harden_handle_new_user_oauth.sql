-- ──────────────────────────────────────────────────────────────────────
-- Hardening: `handle_new_user` rechaza INSERTs de auth.users que vienen
-- por OAuth (Google/Microsoft/etc.) si NO existe un `profiles` previo
-- con un email que matchee.
--
-- Bug reportado: un usuario `jcastano@vivetori.com` que NUNCA fue creado
-- por un Admin pudo loguearse vía "Continue with Google". El trigger
-- viejo creaba el profile silenciosamente para cualquier auth.user
-- nuevo — incluyendo OAuth signups. Mi edge `auth-sso-verify` después
-- veía el profile recién creado y devolvía `ok=true` porque
-- `profile.id === auth.user.id` (trigger los acaba de sincronizar).
-- Resultado: el SSO actuaba como sign-up automático, violando la
-- política "el SSO NO crea cuentas".
--
-- Fix: el trigger ahora distingue por `raw_app_meta_data.provider`:
--   - `'email'` o NULL: flujo password (bulk-import / single-user
--     create) → INSERT del profile como siempre. El profile es la fuente
--     canónica de "este usuario está aprovisionado".
--   - Cualquier otro provider (google, azure, github, ...): RAISE
--     EXCEPTION si no hay un profile pre-existente cuyo institutional_email
--     O personal_email matchee con NEW.email. Esto rollback-ea el INSERT
--     en auth.users → Supabase Auth devuelve error al OAuth callback →
--     el cliente ve "tu cuenta no existe, contacta al admin".
--
-- Capa server (este trigger) + capa edge (`auth-sso-verify` borra el
-- huérfano si alcanzó a colarse por algún edge case): defensa en
-- profundidad.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_provider TEXT;
  v_match_exists BOOLEAN;
BEGIN
  -- raw_app_meta_data->>'provider' indica el método de signin que creó
  -- la fila. Default a 'email' si está null (defensiva).
  v_provider := COALESCE(NEW.raw_app_meta_data->>'provider', 'email');

  IF v_provider NOT IN ('email', 'phone') THEN
    -- OAuth signup. Requiere pre-aprovisionamiento del email.
    -- Match case-insensitive contra ambas columnas de email del profile.
    SELECT EXISTS (
      SELECT 1 FROM public.profiles
       WHERE LOWER(institutional_email) = LOWER(NEW.email)
          OR LOWER(personal_email) = LOWER(NEW.email)
    ) INTO v_match_exists;

    IF NOT v_match_exists THEN
      -- P0001 = mensaje personalizado; el cliente lo recibe en el
      -- error.message del OAuth callback (Supabase Auth lo propaga).
      RAISE EXCEPTION 'SSO_NOT_PROVISIONED: El correo % no está registrado en la plataforma. Pídele a un administrador que cree tu cuenta antes de intentar el inicio de sesión con SSO.', NEW.email
        USING ERRCODE = 'P0001';
    END IF;
    -- Match existe. Igual creamos el profile para el NUEVO auth.user.id
    -- — la fila previa puede tener un id distinto si fue creada por
    -- bulk-import. Postgres rechaza si hay conflicto de UNIQUE en
    -- institutional_email; en ese caso la edge `auth-sso-verify`
    -- detectará el mismatch y borrará este auth.user huérfano.
  END IF;

  -- INSERT del profile (flujo común: email/password + OAuth con match).
  -- Si el INSERT viola un UNIQUE (institutional_email ya tomado por OTRO
  -- profile.id), el OAuth callback recibe el error y el cliente lo
  -- maneja como "duplicate_email" en sso-callback.tsx.
  INSERT INTO public.profiles (id, full_name, personal_email, institutional_email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    NEW.raw_user_meta_data->>'personal_email',
    COALESCE(NEW.raw_user_meta_data->>'institutional_email', NEW.email)
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'AFTER INSERT trigger en auth.users. Crea el profile correspondiente. Para OAuth signups (provider != email/phone), EXIGE que el email ya esté pre-aprovisionado como profile — si no, RAISE EXCEPTION rollback-ea el INSERT y el SSO falla con mensaje accionable. El flujo password (bulk-import) crea el profile como siempre.';
