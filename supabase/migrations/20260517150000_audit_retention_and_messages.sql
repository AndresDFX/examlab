-- ──────────────────────────────────────────────────────────────────────
-- 1) Retención configurable de audit_logs.
--    Tabla singleton `audit_retention_settings` con días por severidad.
--    RPC `purge_audit_logs()` borra logs viejos según la config.
--    Admin programa el cron (mensual recomendado).
--
-- 2) Auditoría automática de mensajes 1-a-1.
--    Triggers en `messages` para INSERT/UPDATE/DELETE.
--    Guardamos metadata (sender, recipient, conversation_id) PERO NO el
--    body del mensaje — privacidad.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1a) Tabla singleton de retención ──

CREATE TABLE IF NOT EXISTS public.audit_retention_settings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Días a conservar por severidad. 0 = ilimitado.
  info_days    INT NOT NULL DEFAULT 0 CHECK (info_days >= 0),
  warning_days INT NOT NULL DEFAULT 0 CHECK (warning_days >= 0),
  error_days   INT NOT NULL DEFAULT 0 CHECK (error_days >= 0),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Garantiza una sola fila (patrón singleton).
CREATE UNIQUE INDEX IF NOT EXISTS audit_retention_settings_singleton
  ON public.audit_retention_settings ((true));

INSERT INTO public.audit_retention_settings DEFAULT VALUES
ON CONFLICT DO NOTHING;

ALTER TABLE public.audit_retention_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_retention_settings_select" ON public.audit_retention_settings;
CREATE POLICY "audit_retention_settings_select"
  ON public.audit_retention_settings FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'));

DROP POLICY IF EXISTS "audit_retention_settings_write" ON public.audit_retention_settings;
CREATE POLICY "audit_retention_settings_write"
  ON public.audit_retention_settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Admin'));

-- ── 1b) RPC purge_audit_logs() ──
-- Aplicable por service_role (cron). Devuelve cuántas filas borró por severidad.

CREATE OR REPLACE FUNCTION public.purge_audit_logs()
RETURNS TABLE(info_purged INT, warning_purged INT, error_purged INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_info INT := 0;
  v_warn INT := 0;
  v_err  INT := 0;
  v_cfg  RECORD;
BEGIN
  SELECT info_days, warning_days, error_days INTO v_cfg
    FROM public.audit_retention_settings LIMIT 1;

  IF v_cfg.info_days > 0 THEN
    WITH d AS (
      DELETE FROM public.audit_logs
      WHERE severity = 'info'
        AND created_at < NOW() - (v_cfg.info_days || ' days')::interval
      RETURNING 1
    )
    SELECT COUNT(*) INTO v_info FROM d;
  END IF;

  IF v_cfg.warning_days > 0 THEN
    WITH d AS (
      DELETE FROM public.audit_logs
      WHERE severity = 'warning'
        AND created_at < NOW() - (v_cfg.warning_days || ' days')::interval
      RETURNING 1
    )
    SELECT COUNT(*) INTO v_warn FROM d;
  END IF;

  IF v_cfg.error_days > 0 THEN
    WITH d AS (
      DELETE FROM public.audit_logs
      WHERE severity IN ('error', 'critical')
        AND created_at < NOW() - (v_cfg.error_days || ' days')::interval
      RETURNING 1
    )
    SELECT COUNT(*) INTO v_err FROM d;
  END IF;

  RETURN QUERY SELECT v_info, v_warn, v_err;
END
$$;

REVOKE ALL ON FUNCTION public.purge_audit_logs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_audit_logs() TO service_role;

-- ── 2) Auditoría de mensajes 1-a-1 ──
-- Helper para obtener al "otro" participante de la conversación.

CREATE OR REPLACE FUNCTION public._message_audit(
  _action TEXT,
  _msg_id UUID,
  _conversation_id UUID,
  _sender_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_other UUID;
  v_user_a UUID;
  v_user_b UUID;
BEGIN
  SELECT user_a, user_b INTO v_user_a, v_user_b
    FROM public.conversations WHERE id = _conversation_id;
  v_other := CASE WHEN _sender_id = v_user_a THEN v_user_b ELSE v_user_a END;

  INSERT INTO public.audit_logs (
    actor_id, action, category, severity,
    entity_type, entity_id, metadata
  ) VALUES (
    _sender_id, _action, 'system', 'info',
    'message', _msg_id::text,
    jsonb_build_object(
      'conversation_id', _conversation_id,
      'sender_id', _sender_id,
      'recipient_id', v_other
    )
  );
END
$$;

-- INSERT (envío)
CREATE OR REPLACE FUNCTION public._audit_message_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._message_audit('message.sent', NEW.id, NEW.conversation_id, NEW.sender_id);
  RETURN NEW;
END
$$;

-- UPDATE (edición — detectamos por edited_at o body cambiando)
CREATE OR REPLACE FUNCTION public._audit_message_update()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Solo si cambió el body (no contamos reads/timestamps)
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    PERFORM public._message_audit('message.edited', NEW.id, NEW.conversation_id, NEW.sender_id);
  END IF;
  RETURN NEW;
END
$$;

-- DELETE (borrado)
CREATE OR REPLACE FUNCTION public._audit_message_delete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._message_audit('message.deleted', OLD.id, OLD.conversation_id, OLD.sender_id);
  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS trg_audit_message_insert ON public.messages;
CREATE TRIGGER trg_audit_message_insert
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public._audit_message_insert();

DROP TRIGGER IF EXISTS trg_audit_message_update ON public.messages;
CREATE TRIGGER trg_audit_message_update
  AFTER UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public._audit_message_update();

DROP TRIGGER IF EXISTS trg_audit_message_delete ON public.messages;
CREATE TRIGGER trg_audit_message_delete
  AFTER DELETE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public._audit_message_delete();

NOTIFY pgrst, 'reload schema';

-- ─────────────────────────────────────────────── Cron sugerido
-- Después de aplicar esta migración, programa el purge:
--
--   SELECT cron.schedule(
--     'audit-logs-purge',
--     '0 3 1 * *',  -- 03:00 UTC del día 1 de cada mes
--     $$ SELECT public.purge_audit_logs(); $$
--   );
--
-- Por defecto la tabla tiene days=0 (sin purga). El admin debe ajustar
-- los días desde Configuración → Auditoría.
