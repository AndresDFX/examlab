-- ──────────────────────────────────────────────────────────────────────
-- Re-crea las RPCs del calendario externo de forma defensiva.
--
-- Síntoma reportado: el cliente recibe
--    "Could not find the function public.get_or_create_calendar_token
--     without parameters in the schema cache"
-- cuando entra al módulo Calendario y trata de generar el URL de
-- suscripción .ics.
--
-- Causa probable: la migración 20260519100000_student_calendar_tokens
-- nunca se aplicó al proyecto destino, o se aplicó parcialmente. Esta
-- migración re-define las funciones con CREATE OR REPLACE — es
-- idempotente, no toca la tabla `student_calendar_tokens` (esa existe
-- ya) y solo asegura que las funciones estén presentes + el cache de
-- PostgREST refresque.
--
-- Mantén SINCRONIZADO con 20260519100000 — si cambia el contrato de
-- esas funciones (params, return type), actualiza ambas migraciones.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.student_calendar_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_accessed_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_student_calendar_tokens_user_active
  ON public.student_calendar_tokens (user_id)
  WHERE revoked_at IS NULL;

ALTER TABLE public.student_calendar_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "student_calendar_tokens_read_own" ON public.student_calendar_tokens;
CREATE POLICY "student_calendar_tokens_read_own"
  ON public.student_calendar_tokens FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.get_or_create_calendar_token()
RETURNS TABLE(token text, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user uuid := auth.uid();
  _row record;
  _new_token text;
BEGIN
  IF _user IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT t.token, t.created_at INTO _row
    FROM public.student_calendar_tokens t
    WHERE t.user_id = _user AND t.revoked_at IS NULL
    LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT _row.token, _row.created_at;
    RETURN;
  END IF;

  FOR i IN 1..10 LOOP
    _new_token := translate(
      encode(gen_random_bytes(24), 'base64'),
      '+/=', '-_'
    );
    _new_token := substring(_new_token, 1, 32);
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.student_calendar_tokens WHERE token = _new_token
    );
  END LOOP;

  INSERT INTO public.student_calendar_tokens (user_id, token)
    VALUES (_user, _new_token);

  RETURN QUERY SELECT _new_token, now();
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_create_calendar_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_or_create_calendar_token() TO authenticated;

CREATE OR REPLACE FUNCTION public.regenerate_calendar_token()
RETURNS TABLE(token text, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user uuid := auth.uid();
  _new_token text;
BEGIN
  IF _user IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  UPDATE public.student_calendar_tokens
     SET revoked_at = now()
   WHERE user_id = _user AND revoked_at IS NULL;

  FOR i IN 1..10 LOOP
    _new_token := translate(
      encode(gen_random_bytes(24), 'base64'),
      '+/=', '-_'
    );
    _new_token := substring(_new_token, 1, 32);
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.student_calendar_tokens WHERE token = _new_token
    );
  END LOOP;

  INSERT INTO public.student_calendar_tokens (user_id, token)
    VALUES (_user, _new_token);

  RETURN QUERY SELECT _new_token, now();
END;
$$;

REVOKE ALL ON FUNCTION public.regenerate_calendar_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.regenerate_calendar_token() TO authenticated;

CREATE OR REPLACE FUNCTION public.resolve_calendar_token(_token text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user uuid;
BEGIN
  SELECT user_id INTO _user
    FROM public.student_calendar_tokens
    WHERE token = _token AND revoked_at IS NULL
    LIMIT 1;

  IF _user IS NOT NULL THEN
    UPDATE public.student_calendar_tokens
      SET last_accessed_at = now()
      WHERE token = _token;
  END IF;

  RETURN _user;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_calendar_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_calendar_token(text) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
