-- ══════════════════════════════════════════════════════════════════════
-- Correos de notificación: kind='attendance' quedó FUERA del predicado SQL
-- _notification_kind_emails → los correos de check-in de asistencia nunca se
-- despachaban (notify_send_email consulta este predicado antes de invocar la
-- edge send-email; con attendance ausente, retornaba false → sin correo).
--
-- El cliente (notification-email.ts CRITICAL_KINDS) y la edge (send-email
-- CRITICAL_KINDS) SÍ tenían 'attendance' → la edge lo habría enviado, pero el
-- gate de dispatch SQL nunca la invocaba. Se agrega 'attendance' a la lista
-- incondicional para cerrar el invariante de 3 lados.
--
-- (El fix simétrico de 'support' — que la edge/cliente lo aceptaran — va en el
--  código de la edge + notification-email.ts; support ya estaba gated acá por
--  platform_settings.support_emails_enabled y no cambia.)
--
-- CREATE OR REPLACE (misma firma y RETURNS boolean → sin DROP). Guard defensivo.
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    CREATE OR REPLACE FUNCTION public._notification_kind_emails(_kind text, _link text)
      RETURNS boolean
      LANGUAGE sql
      STABLE
      AS $fn$
        SELECT
          _kind IN ('grade', 'exam', 'feedback', 'workshop', 'project', 'attendance', 'broadcast')
          OR (_kind = 'info' AND _link IS NOT NULL AND _link LIKE '/app/messages%')
          OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/app/admin/system%')
          OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/auth/reset-password%')
          OR (
            _kind = 'support'
            AND COALESCE(
              (SELECT ps.support_emails_enabled FROM public.platform_settings ps WHERE ps.id = 1),
              true
            )
          );
      $fn$;
  END IF;
END $$;
