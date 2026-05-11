-- consolidated_fixes: hardening OAuth Google Calendar
-- Aplica: OAUTH-1 (tabla oauth_states con expiración), OAUTH-2 (validación one-time del state)
-- OAUTH-3 (encriptación de tokens): pendiente — requiere pgsodium + refactor de _shared/calendar-google.ts.
--   Se documenta como TODO en comentario de tabla por ahora; los tokens siguen en text plano.
-- OAUTH-4/5 (revoke + origin allowlist) viven en código de edge functions, no en DB.

CREATE TABLE IF NOT EXISTS public.calendar_oauth_states (
  state         text PRIMARY KEY,
  teacher_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider      text NOT NULL DEFAULT 'google',
  origin        text NOT NULL,
  nonce         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  consumed_at   timestamptz
);

COMMENT ON TABLE public.calendar_oauth_states IS
  'CSRF protection para OAuth: el state se valida one-time en el callback (consumed_at). TODO OAUTH-3: encriptar refresh_token/access_token en teacher_google_tokens con pgsodium.';

CREATE INDEX IF NOT EXISTS calendar_oauth_states_teacher_idx
  ON public.calendar_oauth_states (teacher_id);
CREATE INDEX IF NOT EXISTS calendar_oauth_states_expires_idx
  ON public.calendar_oauth_states (expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE public.calendar_oauth_states ENABLE ROW LEVEL SECURITY;

-- Sin policies: solo se accede via service-role en edge functions.
-- Esto deja la tabla cerrada para clientes anon/auth — el comportamiento deseado.

-- Cleanup periódico — los states expirados o consumidos hace >1 día se borran.
CREATE OR REPLACE FUNCTION public.cleanup_calendar_oauth_states()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _n integer;
BEGIN
  DELETE FROM public.calendar_oauth_states
  WHERE expires_at < now() - interval '1 day'
     OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '1 day');
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END $$;