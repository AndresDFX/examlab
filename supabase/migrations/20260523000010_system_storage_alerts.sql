-- ──────────────────────────────────────────────────────────────────────
-- Monitoreo de espacio (DB + Storage) + alertas al admin.
--
-- Adds:
--  1) Tabla `system_settings` (singleton) con las cuotas configurables
--     y el umbral % de alerta. Default = Supabase free tier (500MB DB,
--     1GB storage) + 15% threshold.
--  2) Función `system_storage_usage()` — retorna bytes usados de DB +
--     storage + count de objetos y buckets. La llama health-check.
--  3) Función `notify_admins_storage_threshold()` — corre por cron,
--     si el FREE % cae bajo el umbral, inserta notif para CADA Admin
--     con kind='system' y link='/app/admin/system' (que matchea la
--     regla de email para ese link específico).
--  4) Actualiza `_notification_kind_emails` para que las notifs de
--     `kind='system'` con `link LIKE '/app/admin/system%'` disparen
--     correo. Surgical — no afecta otros kind='system' que no
--     apunten a ese link.
-- ──────────────────────────────────────────────────────────────────────

-- 1) ────────────────────────────────────────── Tabla de configuración

CREATE TABLE IF NOT EXISTS public.system_settings (
  -- Singleton: siempre id=1.
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- Cuotas (MB). El admin las ajusta según su plan Supabase.
  -- Defaults = Free tier (500MB DB / 1GB storage).
  db_quota_mb      INTEGER NOT NULL DEFAULT 500,
  storage_quota_mb INTEGER NOT NULL DEFAULT 1024,

  -- Umbral de FREE % bajo el cual se dispara alerta. 15 = alerta
  -- cuando queda menos del 15% libre (= used > 85%).
  alert_threshold_pct INTEGER NOT NULL DEFAULT 15
    CHECK (alert_threshold_pct BETWEEN 1 AND 50),

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

INSERT INTO public.system_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "system_settings_select" ON public.system_settings;
CREATE POLICY "system_settings_select" ON public.system_settings
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "system_settings_update_admin" ON public.system_settings;
CREATE POLICY "system_settings_update_admin" ON public.system_settings
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Admin'));

CREATE OR REPLACE FUNCTION public._system_settings_audit_update()
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

DROP TRIGGER IF EXISTS trg_system_settings_audit ON public.system_settings;
CREATE TRIGGER trg_system_settings_audit
  BEFORE UPDATE ON public.system_settings
  FOR EACH ROW EXECUTE FUNCTION public._system_settings_audit_update();

-- 2) ────────────────────────────── Función de uso (DB + storage)

CREATE OR REPLACE FUNCTION public.system_storage_usage()
RETURNS TABLE(
  db_size_bytes      BIGINT,
  objects_size_bytes BIGINT,
  objects_count      BIGINT,
  buckets_count      BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage
AS $$
DECLARE
  v_storage_exists boolean;
BEGIN
  -- DB size — siempre disponible
  db_size_bytes := pg_database_size(current_database());

  -- Storage size — el schema `storage` puede no existir en setups
  -- muy minimal. Defensa: si falla, dejamos en 0.
  SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'storage')
    INTO v_storage_exists;

  IF v_storage_exists THEN
    BEGIN
      SELECT
        COALESCE(SUM((metadata->>'size')::bigint), 0)::bigint,
        COUNT(*)::bigint
      INTO objects_size_bytes, objects_count
      FROM storage.objects;

      SELECT COUNT(*)::bigint INTO buckets_count FROM storage.buckets;
    EXCEPTION WHEN OTHERS THEN
      objects_size_bytes := 0;
      objects_count := 0;
      buckets_count := 0;
    END;
  ELSE
    objects_size_bytes := 0;
    objects_count := 0;
    buckets_count := 0;
  END IF;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.system_storage_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.system_storage_usage() TO service_role;

-- 3) ───────────────────────── Alerta cuando FREE < threshold

CREATE OR REPLACE FUNCTION public.notify_admins_storage_threshold()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _settings   record;
  _usage      record;
  _db_used_pct      numeric;
  _storage_used_pct numeric;
  _used_threshold   numeric;  -- = 100 - alert_threshold_pct
  _admin_id   uuid;
  _count      int := 0;
  _title      text;
  _body       text;
  _parts      text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO _settings FROM public.system_settings WHERE id = 1;
  IF _settings IS NULL THEN
    RETURN 0;
  END IF;

  SELECT * INTO _usage FROM public.system_storage_usage();
  _used_threshold := 100 - _settings.alert_threshold_pct;

  _db_used_pct := CASE WHEN _settings.db_quota_mb > 0
    THEN (_usage.db_size_bytes::numeric / (_settings.db_quota_mb::numeric * 1024 * 1024)) * 100
    ELSE 0 END;
  _storage_used_pct := CASE WHEN _settings.storage_quota_mb > 0
    THEN (_usage.objects_size_bytes::numeric / (_settings.storage_quota_mb::numeric * 1024 * 1024)) * 100
    ELSE 0 END;

  -- Si ningún recurso supera el threshold, salimos sin alertar.
  IF _db_used_pct <= _used_threshold AND _storage_used_pct <= _used_threshold THEN
    RETURN 0;
  END IF;

  IF _db_used_pct > _used_threshold THEN
    _parts := _parts || format(
      'Base de datos: %s%% usado (%s MB / %s MB)',
      ROUND(_db_used_pct, 1),
      ROUND(_usage.db_size_bytes::numeric / (1024 * 1024), 1),
      _settings.db_quota_mb
    );
  END IF;
  IF _storage_used_pct > _used_threshold THEN
    _parts := _parts || format(
      'Storage: %s%% usado (%s MB / %s MB · %s objetos)',
      ROUND(_storage_used_pct, 1),
      ROUND(_usage.objects_size_bytes::numeric / (1024 * 1024), 1),
      _settings.storage_quota_mb,
      _usage.objects_count
    );
  END IF;

  _title := 'Alerta de espacio del sistema';
  _body := 'Algunos recursos están por encima del umbral de ' ||
           (100 - _settings.alert_threshold_pct) || '% usado:' || E'\n• ' ||
           array_to_string(_parts, E'\n• ') ||
           E'\n\nEntra al panel de Sistema para revisar y considerar limpieza o ' ||
           'upgrade del plan.';

  -- Notificar a CADA Admin. Idempotencia: una alerta por admin por día.
  FOR _admin_id IN
    SELECT ur.user_id FROM public.user_roles ur
     WHERE ur.role::text = 'Admin'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.notifications n
       WHERE n.user_id = _admin_id
         AND n.title = _title
         AND n.created_at::date = CURRENT_DATE
    ) THEN
      INSERT INTO public.notifications (user_id, title, body, kind, link)
      VALUES (_admin_id, _title, _body, 'system', '/app/admin/system');
      _count := _count + 1;
    END IF;
  END LOOP;

  RETURN _count;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_admins_storage_threshold() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_admins_storage_threshold() TO service_role;

-- 4) ──────────────────────── Actualizar predicado de email
-- kind='system' con link='/app/admin/system' dispara correo. Otros
-- system (sin ese link específico) NO disparan correo — evita ruido.

CREATE OR REPLACE FUNCTION public._notification_kind_emails(
  _kind TEXT,
  _link TEXT
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    _kind IN ('grade', 'exam', 'feedback', 'workshop', 'project')
    OR (_kind = 'info' AND _link IS NOT NULL AND _link LIKE '/app/messages%')
    OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/app/admin/system%');
$$;

NOTIFY pgrst, 'reload schema';
