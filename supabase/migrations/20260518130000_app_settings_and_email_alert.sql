-- ──────────────────────────────────────────────────────────────────────
-- 1) Tabla singleton `app_settings` para parámetros globales.
--    Reemplaza el patrón disperso (campos por aquí, campos por allá)
--    con una única fuente para configuraciones que no tienen un módulo
--    propio (defaults nuevos cursos, defaults nuevos exámenes, etc.).
--
-- 2) Email alert threshold + RPC `check_email_alert_threshold()` que
--    notifica a admins cuando los correos de las últimas 24h exceden
--    el umbral. Llamada por cron cada 30 min (ver setup.sql).
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.app_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── Defaults para cursos nuevos ──
  default_grade_scale_min NUMERIC NOT NULL DEFAULT 0,
  default_grade_scale_max NUMERIC NOT NULL DEFAULT 5,
  default_passing_grade NUMERIC NOT NULL DEFAULT 3,

  -- ── Defaults para exámenes nuevos ──
  default_exam_max_warnings INT NOT NULL DEFAULT 3 CHECK (default_exam_max_warnings BETWEEN 0 AND 20),
  default_exam_navigation TEXT NOT NULL DEFAULT 'libre'
    CHECK (default_exam_navigation IN ('libre','secuencial')),
  default_exam_max_attempts INT NOT NULL DEFAULT 1 CHECK (default_exam_max_attempts BETWEEN 1 AND 10),

  -- ── Email alert threshold ──
  -- Si los correos enviados en las últimas 24h exceden este número,
  -- enviamos una notificación a TODOS los admins. 0 = desactivado.
  email_alert_threshold_24h INT NOT NULL DEFAULT 0 CHECK (email_alert_threshold_24h >= 0),

  -- Ventana de gracia para no repetir el alert en exceso (default 6h).
  email_alert_cooldown_hours INT NOT NULL DEFAULT 6 CHECK (email_alert_cooldown_hours BETWEEN 1 AND 168),

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Singleton: una sola fila.
CREATE UNIQUE INDEX IF NOT EXISTS app_settings_singleton
  ON public.app_settings ((true));

INSERT INTO public.app_settings DEFAULT VALUES
ON CONFLICT DO NOTHING;

DROP TRIGGER IF EXISTS trg_app_settings_updated_at ON public.app_settings;
CREATE TRIGGER trg_app_settings_updated_at
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "app_settings_select" ON public.app_settings;
CREATE POLICY "app_settings_select"
  ON public.app_settings FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'));

DROP POLICY IF EXISTS "app_settings_write" ON public.app_settings;
CREATE POLICY "app_settings_write"
  ON public.app_settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Admin'));

-- ── RPC check_email_alert_threshold ──
-- Cuenta correos de las últimas 24h (delivered + failed; skipped no
-- consume cuota del provider). Si excede el threshold y NO se mandó
-- un alert reciente (cooldown), inserta notificaciones para admins.

CREATE OR REPLACE FUNCTION public.check_email_alert_threshold()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _threshold INT;
  _cooldown_h INT;
  _count INT;
  _inserted INT := 0;
BEGIN
  SELECT email_alert_threshold_24h, email_alert_cooldown_hours
    INTO _threshold, _cooldown_h
    FROM public.app_settings LIMIT 1;

  IF _threshold IS NULL OR _threshold = 0 THEN
    RETURN 0;  -- desactivado
  END IF;

  -- Contar emails delivered + failed en últimas 24h (skipped no cuenta)
  SELECT COUNT(*) INTO _count
    FROM public.audit_logs
   WHERE category = 'email'
     AND action IN ('email.delivered', 'email.failed')
     AND created_at > NOW() - INTERVAL '24 hours';

  IF _count <= _threshold THEN
    RETURN 0;
  END IF;

  -- Insertar notif para cada admin que no haya recibido alert reciente
  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT
    ur.user_id,
    'Volumen alto de correos (24h)',
    'Se enviaron ' || _count || ' correos en las últimas 24h (umbral: ' || _threshold ||
      '). Revisa el dashboard para confirmar que no es una falla.',
    'system',
    '/app/admin/audit-logs'
  FROM public.user_roles ur
  WHERE ur.role = 'Admin'
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
      WHERE n.user_id = ur.user_id
        AND n.title = 'Volumen alto de correos (24h)'
        AND n.created_at > NOW() - make_interval(hours => _cooldown_h)
    );

  GET DIAGNOSTICS _inserted = ROW_COUNT;
  RETURN _inserted;
END
$$;

REVOKE ALL ON FUNCTION public.check_email_alert_threshold() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_email_alert_threshold() TO service_role;

NOTIFY pgrst, 'reload schema';
