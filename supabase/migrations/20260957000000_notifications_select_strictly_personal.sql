-- ═══════════════════════════════════════════════════════════════════════
-- notifications.SELECT — ESTRICTAMENTE personal (sin bypass de SuperAdmin).
--
-- Auditoría RLS (reporte: "califiqué la sustentación de un estudiante y me
-- llegó la notificación como si fuera el estudiante"):
--   La policy `notifications_select_recipient` (mig 20260946) dejaba leer las
--   notificaciones con `user_id = auth.uid() OR public.is_super_admin()`. El
--   bypass de SuperAdmin significa que un SuperAdmin puede leer (vía REST
--   directo) las notificaciones PERSONALES de CUALQUIER usuario — incluidas
--   las de calificación/sustentación de cada alumno. La propia migración que
--   lo introdujo dice que NINGUNA pantalla lo necesita: el único consumidor es
--   la campana (`use-notifications`), que filtra por `user_id = auth.uid()`.
--
-- Fix: SELECT solo para el DESTINATARIO. Las notificaciones son personales y
-- privadas; no hay caso de uso para que un SuperAdmin (ni nadie) lea las
-- ajenas. El soporte cross-tenant del SuperAdmin NO requiere leer
-- notificaciones individuales.
--
-- INSERT/UPDATE no cambian: el INSERT sigue permitiendo a Docente/Admin crear
-- notificaciones para OTROS (así se notifica al alumno); UPDATE sigue siendo
-- solo del destinatario (marcar leído).
-- ═══════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.notifications') IS NOT NULL THEN
    DROP POLICY IF EXISTS notifications_select_recipient ON public.notifications;
    DROP POLICY IF EXISTS "notifications_select_recipient" ON public.notifications;
    DROP POLICY IF EXISTS notifications_select_recipient_or_admin ON public.notifications;
    DROP POLICY IF EXISTS "notifications_select_recipient_or_admin" ON public.notifications;

    CREATE POLICY "notifications_select_recipient"
      ON public.notifications FOR SELECT TO authenticated
      USING (user_id = auth.uid());
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
