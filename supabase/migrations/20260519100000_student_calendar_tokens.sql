-- ──────────────────────────────────────────────────────────────────────
-- Tokens de suscripción al calendario integral del estudiante.
--
-- Una sola fila ACTIVA por estudiante. Token URL-safe de 32 chars que se
-- usa en el endpoint público /functions/v1/student-calendar-ics?token=...
-- para devolver un feed .ics suscribible desde Google/Outlook/Apple.
--
-- Modelo:
--   - El estudiante consulta `get_or_create_calendar_token()` para obtener
--     el token actual o crear uno si no tiene.
--   - Si quiere rotarlo (por filtrado accidental, p.ej.), llama
--     `regenerate_calendar_token()` que revoca el viejo y crea uno nuevo.
--   - El edge function `student-calendar-ics` resuelve token → user_id
--     y arma el feed con todos los eventos relevantes.
--
-- Privacidad: el token es la única "auth". Como cualquier link privado
-- de Google Calendar, quien tenga el token ve el feed. Por eso permite
-- regeneración instantánea.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.student_calendar_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token        TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

-- Un solo token ACTIVO por usuario.
CREATE UNIQUE INDEX IF NOT EXISTS idx_student_calendar_tokens_active
  ON public.student_calendar_tokens(user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_student_calendar_tokens_token
  ON public.student_calendar_tokens(token);

ALTER TABLE public.student_calendar_tokens ENABLE ROW LEVEL SECURITY;

-- SELECT: dueño + admin
DROP POLICY IF EXISTS "calendar_tokens_select" ON public.student_calendar_tokens;
CREATE POLICY "calendar_tokens_select"
  ON public.student_calendar_tokens FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'Admin'));

-- INSERT/UPDATE: NO directo del cliente. Solo vía RPCs SECURITY DEFINER.

-- ────────────────────────────────────────────────────────────────────
-- RPC: obtener token (o crear si no existe)
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_or_create_calendar_token()
RETURNS TABLE(token TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user UUID := auth.uid();
  _row RECORD;
  _new_token TEXT;
BEGIN
  IF _user IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  -- ¿Ya tiene uno activo?
  SELECT t.token, t.created_at INTO _row
    FROM public.student_calendar_tokens t
    WHERE t.user_id = _user AND t.revoked_at IS NULL
    LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT _row.token, _row.created_at;
    RETURN;
  END IF;

  -- Generar token URL-safe de 32 chars (base64url ~ 24 chars desde 18 bytes).
  -- Repetimos hasta encontrar uno único (colisión es prácticamente imposible).
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
END
$$;

REVOKE ALL ON FUNCTION public.get_or_create_calendar_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_or_create_calendar_token() TO authenticated;

-- ────────────────────────────────────────────────────────────────────
-- RPC: regenerar token (revoca el anterior, crea uno nuevo)
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.regenerate_calendar_token()
RETURNS TABLE(token TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user UUID := auth.uid();
  _new_token TEXT;
BEGIN
  IF _user IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  -- Revocar TODOS los activos del usuario
  UPDATE public.student_calendar_tokens
    SET revoked_at = now()
    WHERE user_id = _user AND revoked_at IS NULL;

  -- Generar nuevo
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
END
$$;

REVOKE ALL ON FUNCTION public.regenerate_calendar_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.regenerate_calendar_token() TO authenticated;

-- ────────────────────────────────────────────────────────────────────
-- RPC público: resolver token → user_id (lo usa el edge function)
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.resolve_calendar_token(_token TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user UUID;
BEGIN
  IF _token IS NULL OR length(_token) < 16 THEN
    RETURN NULL;
  END IF;

  SELECT user_id INTO _user
    FROM public.student_calendar_tokens
    WHERE token = _token AND revoked_at IS NULL
    LIMIT 1;

  IF _user IS NOT NULL THEN
    -- Update last_accessed_at (fire-and-forget; no afecta retorno)
    UPDATE public.student_calendar_tokens
      SET last_accessed_at = now()
      WHERE token = _token;
  END IF;

  RETURN _user;
END
$$;

REVOKE ALL ON FUNCTION public.resolve_calendar_token(TEXT) FROM PUBLIC;
-- El edge function corre con service_role, no anon. Pero lo dejamos
-- granteable a anon por si después se quiere consumo directo del feed
-- vía un endpoint público que use el role anon.
GRANT EXECUTE ON FUNCTION public.resolve_calendar_token(TEXT) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
