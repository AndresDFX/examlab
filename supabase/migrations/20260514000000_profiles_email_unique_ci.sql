-- ──────────────────────────────────────────────────────────────────────
-- profiles: unicidad case-insensitive de emails + RPC para chequeo
-- proactivo antes de submit.
--
-- BUG actual:
--   Los constraints UNIQUE de `institutional_email` y `personal_email`
--   creados en 20260419051958 son CASE-SENSITIVE — Postgres trata
--   "Juan@X.com" y "juan@x.com" como diferentes. Resultado: dos perfiles
--   pueden cohabitar con el mismo email en distinto casing, y al login
--   uno bloquea al otro.
--
-- FIX:
--   1. Quitamos los constraints UNIQUE actuales.
--   2. Creamos UNIQUE INDEXES sobre LOWER(email) — case-insensitive.
--      Para `personal_email` el índice es PARCIAL (WHERE NOT NULL) para
--      no rechazar múltiples NULL (que es válido).
--   3. RPC `check_email_taken(p_email, p_exclude_user_id)` que la app
--      llama antes de enviar el form para mostrar feedback inmediato
--      ("este correo ya está en uso") en vez del error técnico de UNIQUE.
--      Mira AMBAS columnas + auth.users.email — si el correo aparece
--      en cualquiera de los 3 lugares (que no sea el propio usuario),
--      retorna true.
-- ──────────────────────────────────────────────────────────────────────

-- 1) Drop UNIQUE constraints viejos (si existen — idempotente).
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_institutional_email_key;
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_personal_email_key;

-- 2) UNIQUE INDEXES case-insensitive.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_institutional_email_lower_idx
  ON public.profiles (LOWER(institutional_email));

CREATE UNIQUE INDEX IF NOT EXISTS profiles_personal_email_lower_idx
  ON public.profiles (LOWER(personal_email))
  WHERE personal_email IS NOT NULL;

-- 3) RPC para validación proactiva client-side.
-- Devuelve `true` si el email YA está en uso por alguien que NO es
-- `p_exclude_user_id`. En modo create, el caller pasa NULL como
-- exclude; en modo edit pasa el id del user que se está editando para
-- que el chequeo no se choque consigo mismo.
CREATE OR REPLACE FUNCTION public.check_email_taken(
  p_email TEXT,
  p_exclude_user_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_email TEXT := LOWER(TRIM(p_email));
  v_found BOOLEAN;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN
    RETURN FALSE;
  END IF;

  -- Buscar en institutional_email
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE LOWER(institutional_email) = v_email
      AND (p_exclude_user_id IS NULL OR id <> p_exclude_user_id)
  ) INTO v_found;
  IF v_found THEN RETURN TRUE; END IF;

  -- Buscar en personal_email
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE LOWER(personal_email) = v_email
      AND (p_exclude_user_id IS NULL OR id <> p_exclude_user_id)
  ) INTO v_found;
  IF v_found THEN RETURN TRUE; END IF;

  -- Buscar en auth.users.email — atrapa el caso "alguien se registró
  -- con este correo pero su profile aún no se sincronizó", aunque el
  -- trigger handle_new_user típicamente lo crea de inmediato.
  SELECT EXISTS (
    SELECT 1 FROM auth.users
    WHERE LOWER(email) = v_email
      AND (p_exclude_user_id IS NULL OR id <> p_exclude_user_id)
  ) INTO v_found;
  RETURN v_found;
END;
$$;

REVOKE ALL ON FUNCTION public.check_email_taken(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_email_taken(TEXT, UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
