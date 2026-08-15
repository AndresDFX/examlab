-- ──────────────────────────────────────────────────────────────────────
-- FIX: el módulo de Errores no listaba NADA en producción.
--
-- Síntoma: cualquier llamada a `list_error_events` fallaba con
--   42804: structure of query does not match function result type
--   Returned type text does not match expected type uuid in column 15.
-- O sea: el panel de Errores (ErrorsPanel) quedaba vacío/roto para TODOS los
-- Admin y SuperAdmin, sin importar el tenant ni el filtro.
--
-- Causa: la migración 20261064000010 agregó `entity_id` al RETURNS TABLE
-- declarándola **UUID**, pero `audit_logs.entity_id` es **TEXT** desde su
-- creación (20260509150000_audit_logs.sql). Postgres valida el row type de los
-- OUT params contra lo que realmente devuelve el SELECT, así que la función
-- abortaba en la PRIMERA fila. Nunca funcionó desde que se agregó la columna.
--
-- Por qué TEXT y NO castear a UUID: `entity_id` es deliberadamente TEXT porque
-- guarda identificadores de naturaleza distinta según el `action` (id de job,
-- slug, email, id externo), no solo UUIDs. Un `al.entity_id::uuid` volvería a
-- romper la función —esta vez en runtime y solo para ciertos errores— el día
-- que un evento guarde algo que no sea un UUID. Además el cliente ya la tipa
-- como TEXT: `entity_id: string | null` en ErrorsPanel.tsx:107, y el único
-- consumidor (`requeue_ai_grading_job(_job_id)`) recibe el valor tal cual.
--
-- Cambio mínimo: se recrea la función IDÉNTICA a 20261064000010, con
-- `entity_id TEXT` en el RETURNS TABLE. Cuerpo, scoping y autorización por
-- rol/tenant sin tocar. Como cambia el row type de OUT params, Postgres exige
-- DROP antes del CREATE (no basta CREATE OR REPLACE).
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.audit_logs') IS NULL THEN
    RAISE NOTICE 'skip fix list_error_events: audit_logs ausente';
    RETURN;
  END IF;

  DROP FUNCTION IF EXISTS public.list_error_events(UUID, TEXT, INT);

  CREATE FUNCTION public.list_error_events(
    _tenant_filter UUID DEFAULT NULL,
    _status_filter TEXT DEFAULT NULL,
    _limit INT DEFAULT 300
  )
  RETURNS TABLE (
    id UUID,
    created_at TIMESTAMPTZ,
    action TEXT,
    category TEXT,
    actor_email TEXT,
    actor_role TEXT,
    entity_type TEXT,
    entity_name TEXT,
    course_name TEXT,
    metadata JSONB,
    status TEXT,
    reviewed_at TIMESTAMPTZ,
    tenant_id UUID,
    tenant_name TEXT,
    entity_id TEXT   -- ← era UUID: audit_logs.entity_id es TEXT (ver encabezado)
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
  AS $fn$
  DECLARE
    v_is_super BOOLEAN := public.is_super_admin();
    v_is_admin BOOLEAN := public.has_role(auth.uid(), 'Admin');
    v_my_tenant UUID := public.current_tenant_id();
  BEGIN
    IF NOT v_is_super AND NOT v_is_admin THEN
      RETURN;  -- sin permiso → 0 filas
    END IF;

    RETURN QUERY
    SELECT
      al.id,
      al.created_at,
      al.action,
      al.category,
      al.actor_email,
      al.actor_role,
      al.entity_type,
      al.entity_name,
      al.course_name,
      al.metadata,
      COALESCE(es.status, 'nuevo') AS status,
      es.reviewed_at,
      t.id AS tenant_id,
      t.name AS tenant_name,
      al.entity_id
    FROM public.audit_logs al
    LEFT JOIN public.error_event_status es ON es.audit_log_id = al.id
    LEFT JOIN LATERAL (
      SELECT public._error_event_tenant(al.actor_id, al.course_id) AS tid
    ) der ON true
    LEFT JOIN public.tenants t ON t.id = der.tid
    WHERE al.severity = 'error'
      AND (
        v_is_super
        OR (v_is_admin AND der.tid = v_my_tenant)
      )
      AND (
        NOT v_is_super
        OR _tenant_filter IS NULL
        OR der.tid = _tenant_filter
      )
      AND (
        _status_filter IS NULL
        OR COALESCE(es.status, 'nuevo') = _status_filter
      )
    ORDER BY al.created_at DESC
    LIMIT GREATEST(1, LEAST(_limit, 1000));
  END;
  $fn$;

  GRANT EXECUTE ON FUNCTION public.list_error_events(UUID, TEXT, INT) TO authenticated;
END $$;

NOTIFY pgrst, 'reload schema';
