-- ──────────────────────────────────────────────────────────────────────
-- Configuración global de envío de correos — controlable desde Admin.
--
-- Permite al admin:
--  - Activar/desactivar TODOS los correos globalmente (kill switch)
--  - Activar/desactivar por TIPO específico (exam, workshop, grade,
--    feedback, messages, etc.) sin tocar el resto
--
-- Default: todo habilitado. El admin puede deshabilitar grupos
-- específicos sin tocar código ni redeployar.
--
-- La edge function `send-email` lee esta tabla en cada envío y skipea
-- con audit log `email.skipped` + reason='disabled_by_admin' si el
-- toggle apaga el envío. La notificación in-app sigue funcionando
-- normalmente — solo se suprime el correo.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_settings (
  -- Singleton: siempre id=1. CHECK constraint + INSERT inicial garantiza
  -- que solo existe esa fila y no se puede crear duplicada.
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- Kill switch global: si está en false, NADIE recibe correos hasta
  -- que el admin lo reactive. Las notifs in-app + push siguen.
  globally_enabled BOOLEAN NOT NULL DEFAULT TRUE,

  -- Toggles por categoría. La key del JSON es la "categoría visible"
  -- al admin (no el `kind` SQL crudo, para que sea legible en la UI):
  --   - exam      → notificaciones de exámenes (asignación, publicación,
  --                 recordatorios, etc.)
  --   - workshop  → talleres
  --   - project   → proyectos
  --   - grade     → calificaciones
  --   - feedback  → conversaciones de retroalimentación
  --   - messages  → mensajes 1-a-1 (chat interno)
  --   - summary   → resúmenes diarios al docente
  enabled_kinds JSONB NOT NULL DEFAULT jsonb_build_object(
    'exam',     TRUE,
    'workshop', TRUE,
    'project',  TRUE,
    'grade',    TRUE,
    'feedback', TRUE,
    'messages', TRUE,
    'summary',  TRUE
  ),

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Garantiza que la fila singleton existe desde el inicio. Si ya está
-- (re-run de la migración), DO NOTHING.
INSERT INTO public.email_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.email_settings ENABLE ROW LEVEL SECURITY;

-- SELECT: todos los autenticados pueden leer (la edge function y el
-- frontend del admin necesitan saber el estado). La info no es sensible
-- — saber si los correos están on/off no expone secrets.
DROP POLICY IF EXISTS "email_settings_select" ON public.email_settings;
CREATE POLICY "email_settings_select" ON public.email_settings
  FOR SELECT TO authenticated
  USING (true);

-- UPDATE: solo Admin. No INSERT/DELETE — la fila singleton ya existe.
DROP POLICY IF EXISTS "email_settings_update_admin" ON public.email_settings;
CREATE POLICY "email_settings_update_admin" ON public.email_settings
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Admin'));

-- Trigger que actualiza `updated_at` + `updated_by` automáticamente
-- en cada UPDATE. Evita olvidos.
CREATE OR REPLACE FUNCTION public._email_settings_audit_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := NOW();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_email_settings_audit ON public.email_settings;
CREATE TRIGGER trg_email_settings_audit
  BEFORE UPDATE ON public.email_settings
  FOR EACH ROW EXECUTE FUNCTION public._email_settings_audit_update();

NOTIFY pgrst, 'reload schema';
