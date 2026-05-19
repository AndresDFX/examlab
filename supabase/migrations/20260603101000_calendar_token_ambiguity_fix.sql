-- ──────────────────────────────────────────────────────────────────────
-- Fix: "column reference 'token' is ambiguous" en las RPCs del calendario.
--
-- Síntoma: al entrar a /app/student/calendar (o cualquier sitio que
-- invoque `get_or_create_calendar_token`/`regenerate_calendar_token`)
-- Supabase devuelve:
--   42702: column reference "token" is ambiguous
--
-- Causa: las funciones declaran `RETURNS TABLE(token text, created_at …)`,
-- lo cual mete `token` como una variable OUT en scope dentro del cuerpo
-- de la función. Cuando hacemos `WHERE token = _new_token` sobre
-- `public.student_calendar_tokens`, Postgres no sabe si `token` se
-- refiere a la columna de la tabla o a la variable OUT — error.
--
-- Solución: usar alias de tabla y prefijo `tbl.token` en todos los
-- lugares donde se referencia la columna. La misma fix se aplica a
-- `regenerate_calendar_token`. `resolve_calendar_token(_token TEXT)` no
-- usa RETURNS TABLE así que no tiene el conflicto, pero la re-creamos
-- también con alias por consistencia.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_or_create_calendar_token()
RETURNS TABLE(token text, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _user uuid := auth.uid();
  _row record;
  _new_token text;
  i INT;
BEGIN
  IF _user IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT tbl.token AS tok, tbl.created_at AS ts INTO _row
    FROM public.student_calendar_tokens tbl
    WHERE tbl.user_id = _user AND tbl.revoked_at IS NULL
    LIMIT 1;

  IF FOUND THEN
    -- `token` y `created_at` aquí refieren a las columnas OUT del
    -- RETURNS TABLE; las llenamos con los valores del registro.
    token := _row.tok;
    created_at := _row.ts;
    RETURN NEXT;
    RETURN;
  END IF;

  FOR i IN 1..10 LOOP
    _new_token := translate(
      encode(extensions.gen_random_bytes(24), 'base64'),
      '+/=', '-_'
    );
    _new_token := substring(_new_token, 1, 32);
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.student_calendar_tokens tbl
       WHERE tbl.token = _new_token
    );
  END LOOP;

  INSERT INTO public.student_calendar_tokens (user_id, token)
    VALUES (_user, _new_token);

  token := _new_token;
  created_at := now();
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_create_calendar_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_or_create_calendar_token() TO authenticated;

CREATE OR REPLACE FUNCTION public.regenerate_calendar_token()
RETURNS TABLE(token text, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _user uuid := auth.uid();
  _new_token text;
  i INT;
BEGIN
  IF _user IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  UPDATE public.student_calendar_tokens tbl
     SET revoked_at = now()
   WHERE tbl.user_id = _user AND tbl.revoked_at IS NULL;

  FOR i IN 1..10 LOOP
    _new_token := translate(
      encode(extensions.gen_random_bytes(24), 'base64'),
      '+/=', '-_'
    );
    _new_token := substring(_new_token, 1, 32);
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.student_calendar_tokens tbl
       WHERE tbl.token = _new_token
    );
  END LOOP;

  INSERT INTO public.student_calendar_tokens (user_id, token)
    VALUES (_user, _new_token);

  token := _new_token;
  created_at := now();
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.regenerate_calendar_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.regenerate_calendar_token() TO authenticated;

NOTIFY pgrst, 'reload schema';
