-- ──────────────────────────────────────────────────────────────────────
-- Multi-tenancy Fase 4: scoping de tablas cross-cutting.
--
-- Tablas a aislar:
--   - audit_logs:      tenant_id NOT NULL, RLS filtra. Admin global ya
--                      no ve auditoría de otros tenants.
--   - notifications:   tenant_id denormalizado para que el filtro RLS
--                      no haga JOIN con profiles en cada SELECT.
--   - conversations:   trigger que rechaza convos entre tenants distintos.
--                      messages/message_attachments quedan aisladas
--                      via FK + RLS existente (membership de conv).
--
-- Tablas NO modificadas (heredan via padre — Fase 2/3 ya las cubre):
--   - feedback_threads / feedback_comments → via exam/workshop/project → course → tenant.
--   - ai_grading_queue → course_id directo, RLS docente filtra por
--     course_teachers que ya es same-tenant.
--   - messages / message_attachments → via conversations (con trigger).
-- ──────────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════════
-- 1) audit_logs.tenant_id
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL;

-- Backfill: resolve tenant del actor_id (si existe). Si no, tenant default.
UPDATE public.audit_logs al
   SET tenant_id = COALESCE(
     (SELECT tenant_id FROM public.profiles WHERE id = al.actor_id),
     (SELECT id FROM public.tenants WHERE slug = 'default')
   )
 WHERE al.tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_id ON public.audit_logs(tenant_id);

-- Trigger: rellena tenant_id en INSERT si llega NULL (caso común: la
-- RPC log_audit_event no lo manda).
DROP TRIGGER IF EXISTS trg_audit_logs_set_tenant ON public.audit_logs;
CREATE TRIGGER trg_audit_logs_set_tenant
  BEFORE INSERT ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_tenant_id();

-- RLS: Admin solo ve auditoría de SU tenant; SuperAdmin ve todo.
DROP POLICY IF EXISTS "audit_logs_admin_select" ON public.audit_logs;
CREATE POLICY "audit_logs_admin_select" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    AND (tenant_id = public.current_tenant_id() OR tenant_id IS NULL)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "audit_logs_teacher_select" ON public.audit_logs;
CREATE POLICY "audit_logs_teacher_select" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'Docente')
    AND (tenant_id = public.current_tenant_id() OR tenant_id IS NULL)
    AND (
      course_id IN (
        SELECT course_id FROM public.course_teachers WHERE user_id = auth.uid()
      )
      OR actor_id = auth.uid()
    )
  );

-- INSERT policy queda como estaba (cualquier authenticated puede
-- insertar SU evento) — el trigger rellena tenant_id.

-- ════════════════════════════════════════════════════════════════════
-- 2) notifications.tenant_id
-- ════════════════════════════════════════════════════════════════════
-- Aunque la policy actual ya filtra por user_id = auth.uid() (lo que
-- implícitamente aísla por tenant porque un usuario solo está en UN
-- tenant), denormalizamos tenant_id para:
--   - Bypass más rápido del SELECT (no JOIN con profiles).
--   - Defense in depth si en el futuro abrimos un endpoint de
--     notificaciones globales.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;

UPDATE public.notifications n
   SET tenant_id = COALESCE(
     (SELECT tenant_id FROM public.profiles WHERE id = n.user_id),
     (SELECT id FROM public.tenants WHERE slug = 'default')
   )
 WHERE n.tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_id ON public.notifications(tenant_id);

-- Trigger BEFORE INSERT: tenant_id = tenant del user_id destinatario.
-- Reutilizar tg_set_tenant_id() NO funciona acá — esa función mira
-- current_tenant_id() (caller), pero el destinatario podría ser otro
-- usuario. Necesitamos derivar del user_id.
CREATE OR REPLACE FUNCTION public.tg_notifications_set_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    SELECT tenant_id INTO NEW.tenant_id FROM public.profiles WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notifications_set_tenant ON public.notifications;
CREATE TRIGGER trg_notifications_set_tenant
  BEFORE INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.tg_notifications_set_tenant();

-- ════════════════════════════════════════════════════════════════════
-- 3) conversations: trigger anti cross-tenant
-- ════════════════════════════════════════════════════════════════════
-- Una conv entre user de tenant A y user de tenant B no debería existir.
-- Bloqueamos en BEFORE INSERT/UPDATE.

CREATE OR REPLACE FUNCTION public.tg_conversations_tenant_check()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_ta UUID;
  v_tb UUID;
BEGIN
  SELECT tenant_id INTO v_ta FROM public.profiles WHERE id = NEW.user_a;
  SELECT tenant_id INTO v_tb FROM public.profiles WHERE id = NEW.user_b;

  IF v_ta IS NULL OR v_tb IS NULL THEN
    RAISE EXCEPTION 'Uno de los usuarios no tiene institución asignada'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_ta <> v_tb THEN
    RAISE EXCEPTION 'No se puede iniciar una conversación entre usuarios de instituciones distintas'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversations_tenant_check ON public.conversations;
CREATE TRIGGER trg_conversations_tenant_check
  BEFORE INSERT OR UPDATE OF user_a, user_b ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.tg_conversations_tenant_check();

NOTIFY pgrst, 'reload schema';
