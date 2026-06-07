-- ──────────────────────────────────────────────────────────────────────
-- Platform settings — controles cross-tenant manejados SOLO por SuperAdmin.
--
-- Diferencia con `email_settings` y `app_settings`:
--   - `email_settings`: toggles que el Admin del tenant puede tocar para
--     SU institución (kinds de email habilitados, welcome email, etc.).
--   - `app_settings`: defaults per-tenant para courses/exams/etc.
--   - `platform_settings` (NUEVO): controles del DUEÑO de la plataforma
--     que aplican a TODOS los tenants. El Admin del tenant NO puede
--     editarlos — solo el SA.
--
-- Primer setting: `support_emails_enabled`.
--   true (default) = los triggers del módulo Soporte envían email cuando
--   se abre un ticket, llega respuesta o cambia el status. Esto pasa
--   notificación in-app + email.
--   false = sigue habiendo notificación in-app pero NO email. Útil cuando
--   el SA prefiere gestionar todo desde el dashboard sin saturar su
--   bandeja, o durante un debug.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.platform_settings (
  -- Single-row table. Usamos un id fijo = 1 para que siempre exista
  -- exactamente una fila. Si alguien intenta insertar otra, el CHECK
  -- la rechaza.
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  support_emails_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Seed UNA fila — el resto del sistema asume que existe.
INSERT INTO public.platform_settings (id, support_emails_enabled)
VALUES (1, true)
ON CONFLICT (id) DO NOTHING;

-- Trigger touch updated_at.
CREATE OR REPLACE FUNCTION public._platform_settings_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_platform_settings_touch ON public.platform_settings;
CREATE TRIGGER tg_platform_settings_touch
  BEFORE UPDATE ON public.platform_settings
  FOR EACH ROW EXECUTE FUNCTION public._platform_settings_touch();

-- RLS: cualquier authenticated puede LEER (el predicate de email del
-- trigger de notifications corre como caller normal). Solo SA puede
-- UPDATE. No se permite INSERT/DELETE — la única fila vive seteada por
-- siempre.
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "platform_settings_select" ON public.platform_settings;
CREATE POLICY "platform_settings_select"
  ON public.platform_settings FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "platform_settings_update_super" ON public.platform_settings;
CREATE POLICY "platform_settings_update_super"
  ON public.platform_settings FOR UPDATE TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- ── Predicate de emails: ahora STABLE y considera `support` kind ──
-- Antes era IMMUTABLE; lo cambiamos a STABLE para poder consultar
-- platform_settings. La penalidad es despreciable (la fila siempre cabe
-- en cache porque la tabla tiene 1 sola fila).
CREATE OR REPLACE FUNCTION public._notification_kind_emails(
  _kind TEXT,
  _link TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT
    _kind IN ('grade', 'exam', 'feedback', 'workshop', 'project', 'broadcast')
    OR (_kind = 'info' AND _link IS NOT NULL AND _link LIKE '/app/messages%')
    OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/app/admin/system%')
    OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/auth/reset-password%')
    -- Soporte: gobernado por platform_settings.support_emails_enabled.
    -- Default true (la fila se seedea con true), pero si el SA lo apaga
    -- desde el panel, los triggers seguirán insertando la notif in-app
    -- pero el email NO sale.
    OR (
      _kind = 'support'
      AND COALESCE(
        (SELECT ps.support_emails_enabled FROM public.platform_settings ps WHERE ps.id = 1),
        true
      )
    );
$$;

-- ── Actualizar los 3 triggers del módulo Soporte a kind='support' ──
-- Antes usaban kind='info', que SOLO emailaba si el link era /app/messages.
-- Como los links del soporte son /app/{admin,superadmin}/support, esos
-- nunca emailaban. Pasamos a kind='support' que ahora SÍ entra al
-- predicate (gobernado por el toggle del SA).

CREATE OR REPLACE FUNCTION public._support_notify_new_ticket()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_admin_name TEXT;
  v_tenant_name TEXT;
BEGIN
  SELECT full_name INTO v_admin_name FROM public.profiles WHERE id = NEW.created_by;
  SELECT name INTO v_tenant_name FROM public.tenants WHERE id = NEW.tenant_id;

  INSERT INTO public.notifications (user_id, title, body, kind, link, source_role)
  SELECT
    ur.user_id,
    '🎫 Nuevo ticket de soporte',
    format('%s (%s) — %s', COALESCE(v_admin_name, 'Admin'), COALESCE(v_tenant_name, 'tenant'), NEW.subject),
    'support',
    '/app/superadmin/support?ticket=' || NEW.id::text,
    'Admin'
  FROM public.user_roles ur
  WHERE ur.role = 'SuperAdmin';

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public._support_notify_status_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status_label TEXT;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  v_status_label := CASE NEW.status
    WHEN 'open' THEN 'Abierto'
    WHEN 'in_progress' THEN 'En progreso'
    WHEN 'waiting_admin' THEN 'Esperando tu respuesta'
    WHEN 'resolved' THEN 'Resuelto'
    WHEN 'closed' THEN 'Cerrado'
    ELSE NEW.status
  END;
  IF auth.uid() IS DISTINCT FROM NEW.created_by THEN
    INSERT INTO public.notifications (user_id, title, body, kind, link, source_role)
    VALUES (
      NEW.created_by,
      '🎫 Ticket actualizado',
      format('%s: %s', NEW.subject, v_status_label),
      'support',
      '/app/admin/support?ticket=' || NEW.id::text,
      'SuperAdmin'
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public._support_notify_new_message()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ticket RECORD;
  v_sender_is_super BOOLEAN;
BEGIN
  SELECT id, created_by, assigned_to, subject INTO v_ticket
    FROM public.support_tickets WHERE id = NEW.ticket_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = NEW.sender_id AND role = 'SuperAdmin'
  ) INTO v_sender_is_super;

  IF v_sender_is_super THEN
    INSERT INTO public.notifications (user_id, title, body, kind, link, source_role)
    VALUES (
      v_ticket.created_by,
      '💬 Respuesta en tu ticket',
      format('%s: %s', v_ticket.subject, substring(NEW.body, 1, 100)),
      'support',
      '/app/admin/support?ticket=' || v_ticket.id::text,
      'SuperAdmin'
    );
  ELSE
    IF v_ticket.assigned_to IS NOT NULL THEN
      INSERT INTO public.notifications (user_id, title, body, kind, link, source_role)
      VALUES (
        v_ticket.assigned_to,
        '💬 Respuesta en ticket',
        format('%s: %s', v_ticket.subject, substring(NEW.body, 1, 100)),
        'support',
        '/app/superadmin/support?ticket=' || v_ticket.id::text,
        'Admin'
      );
    ELSE
      INSERT INTO public.notifications (user_id, title, body, kind, link, source_role)
      SELECT
        ur.user_id,
        '💬 Respuesta en ticket sin asignar',
        format('%s: %s', v_ticket.subject, substring(NEW.body, 1, 100)),
        'support',
        '/app/superadmin/support?ticket=' || v_ticket.id::text,
        'Admin'
      FROM public.user_roles ur
      WHERE ur.role = 'SuperAdmin';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
