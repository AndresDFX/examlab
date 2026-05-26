-- ──────────────────────────────────────────────────────────────────────
-- Broadcast → correo por destinatario
--
-- Antes: la edge `broadcast-course-message` insertaba notifs
-- `kind='broadcast'` (que el predicado `_notification_kind_emails`
-- EXCLUÍA a propósito, para no mandar N correos) y enviaba UN correo
-- BCC aparte. En la práctica el BCC no llegaba de forma confiable y el
-- audit mostraba `email.skipped / kind_not_critical`, confundiendo al
-- admin.
--
-- Ahora: `broadcast` es un kind que SÍ emaila por el camino estándar
-- (trigger notify_send_email → edge send-email, por destinatario). Eso
-- reusa la infra probada (preferencias por usuario, toggles, render,
-- pg_net) que ya entrega grade/exam/feedback. La edge deja de mandar el
-- BCC (ver cambio en broadcast-course-message/index.ts) para no
-- duplicar.
--
-- Sincronizar SIEMPRE los 3 lados de este predicado:
--   - SQL `_notification_kind_emails` (acá)
--   - `supabase/functions/send-email/index.ts` (CRITICAL_KINDS)
--   - `src/modules/notifications/notification-email.ts` (CRITICAL_KINDS)
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._notification_kind_emails(
  _kind TEXT,
  _link TEXT
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    _kind IN ('grade', 'exam', 'feedback', 'workshop', 'project', 'broadcast')
    OR (_kind = 'info' AND _link IS NOT NULL AND _link LIKE '/app/messages%')
    OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/app/admin/system%')
    OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/auth/reset-password%');
$$;

NOTIFY pgrst, 'reload schema';
