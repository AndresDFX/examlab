-- ──────────────────────────────────────────────────────────────────────
-- Custom password reset flow — para usar nuestro pipeline de correo
-- (send-email + Brevo) con plantilla unificada en vez del flow nativo
-- de Supabase Auth.
--
-- Pieza 1: tabla de tokens. Cada solicitud de reset crea una fila con
-- un token random de 32 chars, validez 1h, single-use. Los edge
-- functions `request-password-reset` y `confirm-password-reset` operan
-- sobre esta tabla con service_role (no RLS-exposable a authenticated).
--
-- Pieza 2: extensión del predicado de email para permitir que el link
-- '/auth/reset-password?token=...' dispare correo via send-email.
-- Restringido a este path específico para no abrir kind='system' a
-- todos los enlaces.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Token URL-safe de 32 chars. Generado por la edge function con
  -- crypto.getRandomValues. Se almacena en plano — la entropía es
  -- suficiente para que adivinarlo sea infeasible. Si en el futuro hay
  -- preocupación por leaks de DB, se puede pasar a sha256 hash.
  token       TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  -- NULL = no usado todavía. Una vez populado, el token es inutilizable.
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- IP / user-agent del request — útil para auditoría / detección de
  -- abuso. Se llenan desde la edge si están disponibles en headers.
  request_ip  TEXT,
  request_ua  TEXT
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON public.password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON public.password_reset_tokens(token);
-- Para limpieza de tokens expirados (job futuro o manual).
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires
  ON public.password_reset_tokens(expires_at) WHERE used_at IS NULL;

ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;

-- NO policies para authenticated/anon → solo service_role accede.
-- Las edge functions usan service_role, así pasan. Cualquier intento
-- desde el cliente con JWT del usuario queda bloqueado por RLS.

-- ─── Extensión del predicado de email ─────────────────────────────────
-- Permite que notificaciones con kind='system' + link='/auth/reset-password%'
-- disparen correo. Mantiene la regla previa de '/app/admin/system%'.

CREATE OR REPLACE FUNCTION public._notification_kind_emails(
  _kind TEXT,
  _link TEXT
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    _kind IN ('grade', 'exam', 'feedback', 'workshop', 'project')
    OR (_kind = 'info' AND _link IS NOT NULL AND _link LIKE '/app/messages%')
    OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/app/admin/system%')
    OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/auth/reset-password%');
$$;

NOTIFY pgrst, 'reload schema';
