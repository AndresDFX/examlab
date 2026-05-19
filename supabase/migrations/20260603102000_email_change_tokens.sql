-- ──────────────────────────────────────────────────────────────────────
-- Custom email change flow — reemplaza el correo de confirmación que
-- Supabase Auth dispara desde su SMTP opaco cuando se invoca
-- `auth.updateUser({ email })`. Nuevo flujo (mismo patrón que
-- broadcast-course-message: edge function manda SMTP directo, no pasa
-- por notifications):
--
--   1. EditProfileDialog llama edge `request-email-change`.
--   2. Edge genera token random, guarda en `email_change_tokens` y
--      manda correo SMTP **directamente al nuevo email** (no via
--      notifications/send-email).
--   3. Usuario abre el link → ruta `/auth/confirm-email-change` →
--      edge `confirm-email-change` → `auth.admin.updateUserById` con
--      `email_confirm: true` (suprime el correo nativo de Supabase
--      Auth porque ya hicimos la verificación nosotros).
--
-- Esta migración crea solo la tabla de tokens. NO toca el predicado
-- `_notification_kind_emails` porque el correo va por SMTP directo —
-- nunca pasa por la pipeline de notifications.
--
-- Misma forma que `password_reset_tokens` (TTL 1h, single-use, RLS
-- opaca al cliente) + campo `new_email` que es el target del cambio.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_change_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Nuevo email al que se cambiará la cuenta tras confirmar. Se guarda
  -- en lowercase + trim para que el matching sea predecible.
  new_email   TEXT NOT NULL,
  -- Token URL-safe de 32 chars generado por la edge function.
  token       TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_ip  TEXT,
  request_ua  TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_change_tokens_user
  ON public.email_change_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_change_tokens_token
  ON public.email_change_tokens(token);
-- Limpieza futura de expirados (job manual o pg_cron).
CREATE INDEX IF NOT EXISTS idx_email_change_tokens_expires
  ON public.email_change_tokens(expires_at) WHERE used_at IS NULL;

-- Garantiza que un usuario solo tenga UN cambio pendiente a la vez.
-- Si solicita uno nuevo, la edge function invalida el anterior antes de
-- crear este (lógica en TS, este unique es defensa en profundidad).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_email_change_tokens_pending
  ON public.email_change_tokens(user_id) WHERE used_at IS NULL;

ALTER TABLE public.email_change_tokens ENABLE ROW LEVEL SECURITY;
-- Sin policies para authenticated/anon — solo service_role pasa.
-- Las edge functions usan service_role; el cliente nunca debería tocar
-- esta tabla directamente.

NOTIFY pgrst, 'reload schema';
