-- ──────────────────────────────────────────────────────────────────────
-- Módulo "Soporte": canal Admin (tenant) → SuperAdmin para PQRS.
--
-- Caso de uso: el Admin de una institución abre un ticket (petición,
-- queja, reclamo, sugerencia) hacia el dueño de plataforma. Puede
-- adjuntar archivos y mantener una conversación con el SuperAdmin
-- dentro del ticket. Cuando se resuelve, queda registrado en historial
-- con fecha de resolución + notas.
--
-- Modelo:
--   - support_tickets (cabecera: subject + status + dates + assignment)
--   - support_ticket_messages (conversación dentro del ticket)
--   - support_ticket_attachments (archivos del ticket o de una respuesta)
--   - Bucket Storage `support-attachments` (privado, RLS por ticket)
--
-- Flujo de notificaciones:
--   - NUEVO ticket → notif a todos los SuperAdmins (+ email via trigger
--     existente de notifications → email).
--   - NUEVO mensaje → notif al "otro lado" (si el sender es Admin →
--     notif al SA asignado o a todos los SA si sin asignar; si es SA →
--     notif al Admin que creó el ticket).
--   - Cambio de status → notif al Admin creator.
--
-- Soft-delete:
--   - support_tickets tiene deleted_at/deleted_by (no se incluye en la
--     papelera generalista — solo el SuperAdmin puede borrar tickets).
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) Tabla support_tickets ──
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  category TEXT NOT NULL CHECK (category IN ('peticion', 'queja', 'reclamo', 'sugerencia', 'otro')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 3 AND 200),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 10 AND 10000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'in_progress', 'waiting_admin', 'resolved', 'closed')
  ),
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_tenant ON public.support_tickets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created_by ON public.support_tickets(created_by);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON public.support_tickets(status)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned ON public.support_tickets(assigned_to)
  WHERE deleted_at IS NULL AND assigned_to IS NOT NULL;

-- Trigger para updated_at automático.
CREATE OR REPLACE FUNCTION public._support_tickets_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  -- Si pasa a resolved/closed y resolved_at está vacío, lo seteamos.
  IF NEW.status IN ('resolved', 'closed') AND OLD.status NOT IN ('resolved', 'closed')
     AND NEW.resolved_at IS NULL THEN
    NEW.resolved_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_support_tickets_touch ON public.support_tickets;
CREATE TRIGGER tg_support_tickets_touch
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public._support_tickets_touch_updated_at();

-- ── 2) Tabla support_ticket_messages ──
CREATE TABLE IF NOT EXISTS public.support_ticket_messages (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON public.support_ticket_messages(ticket_id, created_at);

-- ── 3) Tabla support_ticket_attachments ──
CREATE TABLE IF NOT EXISTS public.support_ticket_attachments (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  message_id UUID REFERENCES public.support_ticket_messages(id) ON DELETE SET NULL,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size BIGINT,
  mime_type TEXT,
  uploaded_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_attachments_ticket ON public.support_ticket_attachments(ticket_id);

-- ── 4) Storage bucket ──
INSERT INTO storage.buckets (id, name, public)
VALUES ('support-attachments', 'support-attachments', false)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: el caller puede leer/subir si es creator del ticket O SuperAdmin.
-- Path convention: <ticket_id>/<random-uuid>.<ext>. La primera parte del
-- path es el ticket_id — la usamos para joinear con support_tickets.
DROP POLICY IF EXISTS "support_attachments_read" ON storage.objects;
CREATE POLICY "support_attachments_read"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'support-attachments'
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.support_tickets t
        WHERE t.id::text = split_part(name, '/', 1)
          AND t.created_by = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "support_attachments_insert" ON storage.objects;
CREATE POLICY "support_attachments_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'support-attachments'
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.support_tickets t
        WHERE t.id::text = split_part(name, '/', 1)
          AND t.created_by = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "support_attachments_delete" ON storage.objects;
CREATE POLICY "support_attachments_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'support-attachments'
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.support_tickets t
        WHERE t.id::text = split_part(name, '/', 1)
          AND t.created_by = auth.uid()
      )
    )
  );

-- ── 5) RLS de las tablas ──
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_ticket_attachments ENABLE ROW LEVEL SECURITY;

-- Tickets: SELECT — creator (admin) ve los suyos, SuperAdmin ve todos.
DROP POLICY IF EXISTS "support_tickets_select" ON public.support_tickets;
CREATE POLICY "support_tickets_select"
  ON public.support_tickets FOR SELECT TO authenticated
  USING (
    created_by = auth.uid()
    OR public.is_super_admin()
  );

-- INSERT: solo Admin de un tenant (no Docente/Estudiante, no SuperAdmin
-- — el SA NO abre tickets a sí mismo). El tenant_id del ticket debe
-- coincidir con el tenant del profile del creator.
DROP POLICY IF EXISTS "support_tickets_insert" ON public.support_tickets;
CREATE POLICY "support_tickets_insert"
  ON public.support_tickets FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND public.has_role(auth.uid(), 'Admin'::public.app_role)
    AND tenant_id = (SELECT tenant_id FROM public.profiles WHERE id = auth.uid())
  );

-- UPDATE: SuperAdmin todo (status, assign, notes). Admin SOLO puede
-- "cerrar" su propio ticket (status = 'closed') o cambiar priority.
-- No puede tocar resolution_notes ni assigned_to.
DROP POLICY IF EXISTS "support_tickets_update" ON public.support_tickets;
CREATE POLICY "support_tickets_update"
  ON public.support_tickets FOR UPDATE TO authenticated
  USING (
    public.is_super_admin()
    OR (created_by = auth.uid() AND deleted_at IS NULL)
  )
  WITH CHECK (
    public.is_super_admin()
    OR (created_by = auth.uid() AND deleted_at IS NULL)
  );

-- DELETE: solo SuperAdmin (soft o hard). Admin no puede borrar sus
-- tickets — debe cerrarlos.
DROP POLICY IF EXISTS "support_tickets_delete" ON public.support_tickets;
CREATE POLICY "support_tickets_delete"
  ON public.support_tickets FOR DELETE TO authenticated
  USING (public.is_super_admin());

-- Messages: SELECT — mismo set que el ticket.
DROP POLICY IF EXISTS "support_messages_select" ON public.support_ticket_messages;
CREATE POLICY "support_messages_select"
  ON public.support_ticket_messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = ticket_id
        AND (t.created_by = auth.uid() OR public.is_super_admin())
    )
  );

-- INSERT: el sender debe poder ver el ticket Y debe ser creator del
-- ticket o SuperAdmin. Esto cubre la conversación bilateral.
DROP POLICY IF EXISTS "support_messages_insert" ON public.support_ticket_messages;
CREATE POLICY "support_messages_insert"
  ON public.support_ticket_messages FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = ticket_id
        AND t.deleted_at IS NULL
        AND (t.created_by = auth.uid() OR public.is_super_admin())
    )
  );

-- Attachments: SELECT — mismo set que el ticket.
DROP POLICY IF EXISTS "support_attachments_select" ON public.support_ticket_attachments;
CREATE POLICY "support_attachments_select"
  ON public.support_ticket_attachments FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = ticket_id
        AND (t.created_by = auth.uid() OR public.is_super_admin())
    )
  );

DROP POLICY IF EXISTS "support_attachments_insert" ON public.support_ticket_attachments;
CREATE POLICY "support_attachments_insert"
  ON public.support_ticket_attachments FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = ticket_id
        AND t.deleted_at IS NULL
        AND (t.created_by = auth.uid() OR public.is_super_admin())
    )
  );

DROP POLICY IF EXISTS "support_attachments_delete" ON public.support_ticket_attachments;
CREATE POLICY "support_attachments_delete"
  ON public.support_ticket_attachments FOR DELETE TO authenticated
  USING (
    public.is_super_admin()
    OR uploaded_by = auth.uid()
  );

-- ── 6) Triggers de notificación ──
-- AFTER INSERT support_tickets → notif a TODOS los SuperAdmins.
-- Body corto + link al panel SuperAdmin.
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
    'info',
    '/app/superadmin/support?ticket=' || NEW.id::text,
    'Admin'
  FROM public.user_roles ur
  WHERE ur.role = 'SuperAdmin';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_support_notify_new_ticket ON public.support_tickets;
CREATE TRIGGER tg_support_notify_new_ticket
  AFTER INSERT ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public._support_notify_new_ticket();

-- AFTER UPDATE support_tickets (status change) → notif al creator.
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
  -- Solo notificamos si el cambio NO lo hizo el propio creator.
  IF auth.uid() IS DISTINCT FROM NEW.created_by THEN
    INSERT INTO public.notifications (user_id, title, body, kind, link, source_role)
    VALUES (
      NEW.created_by,
      '🎫 Ticket actualizado',
      format('%s: %s', NEW.subject, v_status_label),
      'info',
      '/app/admin/support?ticket=' || NEW.id::text,
      'SuperAdmin'
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_support_notify_status_change ON public.support_tickets;
CREATE TRIGGER tg_support_notify_status_change
  AFTER UPDATE OF status ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public._support_notify_status_change();

-- AFTER INSERT support_ticket_messages → notif al "otro lado".
CREATE OR REPLACE FUNCTION public._support_notify_new_message()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ticket RECORD;
  v_sender_name TEXT;
  v_sender_is_super BOOLEAN;
BEGIN
  SELECT id, created_by, assigned_to, subject INTO v_ticket
    FROM public.support_tickets WHERE id = NEW.ticket_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT full_name INTO v_sender_name FROM public.profiles WHERE id = NEW.sender_id;
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = NEW.sender_id AND role = 'SuperAdmin'
  ) INTO v_sender_is_super;

  IF v_sender_is_super THEN
    -- SA respondió → notif al creator (Admin).
    INSERT INTO public.notifications (user_id, title, body, kind, link, source_role)
    VALUES (
      v_ticket.created_by,
      '💬 Respuesta en tu ticket',
      format('%s: %s', v_ticket.subject, substring(NEW.body, 1, 100)),
      'info',
      '/app/admin/support?ticket=' || v_ticket.id::text,
      'SuperAdmin'
    );
  ELSE
    -- Admin respondió → notif al SA asignado, o a todos los SA si no
    -- hay asignado todavía.
    IF v_ticket.assigned_to IS NOT NULL THEN
      INSERT INTO public.notifications (user_id, title, body, kind, link, source_role)
      VALUES (
        v_ticket.assigned_to,
        '💬 Respuesta en ticket',
        format('%s: %s', v_ticket.subject, substring(NEW.body, 1, 100)),
        'info',
        '/app/superadmin/support?ticket=' || v_ticket.id::text,
        'Admin'
      );
    ELSE
      INSERT INTO public.notifications (user_id, title, body, kind, link, source_role)
      SELECT
        ur.user_id,
        '💬 Respuesta en ticket sin asignar',
        format('%s: %s', v_ticket.subject, substring(NEW.body, 1, 100)),
        'info',
        '/app/superadmin/support?ticket=' || v_ticket.id::text,
        'Admin'
      FROM public.user_roles ur
      WHERE ur.role = 'SuperAdmin';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_support_notify_new_message ON public.support_ticket_messages;
CREATE TRIGGER tg_support_notify_new_message
  AFTER INSERT ON public.support_ticket_messages
  FOR EACH ROW EXECUTE FUNCTION public._support_notify_new_message();

-- ── 7) Seed module_visibility ──
-- El módulo "support" aplica a Admin y SuperAdmin (no Docente/Estudiante).
-- Default enabled = true para ambos.
DO $$
BEGIN
  IF to_regclass('public.module_visibility') IS NOT NULL THEN
    INSERT INTO public.module_visibility (module_key, role, enabled, display_order, tenant_id)
    VALUES
      ('support', 'Admin', true, 240, NULL),
      ('support', 'SuperAdmin', true, 240, NULL)
    ON CONFLICT (tenant_id, module_key, role) DO NOTHING;
  END IF;
END $$;

-- ── 8) Realtime ──
-- El detalle del ticket (chat) usa realtime para que ambos vean los
-- mensajes y status changes en vivo sin polling.
ALTER PUBLICATION supabase_realtime ADD TABLE public.support_tickets;
ALTER PUBLICATION supabase_realtime ADD TABLE public.support_ticket_messages;

NOTIFY pgrst, 'reload schema';
