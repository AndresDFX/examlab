-- ═══════════════════════════════════════════════════════════════════════
-- notifications — endurecer SELECT: las notificaciones son PERSONALES.
--
-- Problema: la policy previa (`notifications_select_recipient_or_admin`,
-- mig 20260528000000) dejaba que CUALQUIER usuario con el rol Admin
-- leyera TODAS las notificaciones de su tenant — incluidas las personales
-- de cada estudiante/docente. Como un dueño de institución suele tener
-- AMBOS roles (Admin + Docente), eso significaba que, vía REST directo,
-- podía leer la notificación de calificación/sustentación de cualquier
-- alumno. No hay ninguna pantalla que lo necesite: el único consumidor
-- es la campana (`use-notifications`), que SIEMPRE filtra por
-- `user_id = auth.uid()`. El clausula Admin era riesgo latente sin uso.
--
-- Fix: SELECT solo para el DESTINATARIO (`user_id = auth.uid()`) y el
-- SuperAdmin (soporte de plataforma cross-tenant, patrón del resto de la
-- app). Un Admin ya NO lee notificaciones ajenas.
--
-- INSERT/UPDATE no cambian (el INSERT sigue permitiendo a Docente/Admin
-- crear notificaciones para OTROS — eso es correcto: así se notifica al
-- alumno; lo que se restringe es la LECTURA).
-- ═══════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.notifications') IS NOT NULL THEN
    DROP POLICY IF EXISTS notifications_select_recipient_or_admin ON public.notifications;
    DROP POLICY IF EXISTS "notifications_select_recipient_or_admin" ON public.notifications;
    DROP POLICY IF EXISTS notifications_select_recipient ON public.notifications;

    CREATE POLICY "notifications_select_recipient"
      ON public.notifications FOR SELECT TO authenticated
      USING (
        user_id = auth.uid()
        OR public.is_super_admin()
      );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
