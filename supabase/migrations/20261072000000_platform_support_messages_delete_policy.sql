-- ══════════════════════════════════════════════════════════════════════
-- platform_support_messages tenía RLS habilitada + SOLO policy SELECT (mig
-- 20261063000000). El cliente "Limpiar conversación" (app.admin.support-assistant)
-- hace un DELETE directo con el user client → sin policy DELETE permisiva, Postgres
-- aplica default-deny como filtro: borra 0 filas SIN error → supabase-js devuelve
-- error=null → el UI muestra "Conversación limpiada" pero los mensajes reaparecen al
-- recargar (feature no funcional + datos que el usuario cree borrados persisten).
--
-- FIX: policy DELETE scopeada al DUEÑO de la sesión (análoga al SELECT). El INSERT
-- sigue SIN policy de cliente (solo el edge/service_role inserta 'assistant').
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.platform_support_messages') IS NOT NULL THEN
    DROP POLICY IF EXISTS platform_support_messages_delete ON public.platform_support_messages;
    CREATE POLICY platform_support_messages_delete ON public.platform_support_messages
      FOR DELETE USING (
        EXISTS (
          SELECT 1 FROM public.platform_support_sessions s
          WHERE s.id = platform_support_messages.session_id
            AND s.user_id = auth.uid()
        )
      );
  END IF;
END $$;
