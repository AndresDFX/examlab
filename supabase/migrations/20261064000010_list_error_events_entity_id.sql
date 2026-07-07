-- ──────────────────────────────────────────────────────────────────────
-- Feature B — exponer `entity_id` en list_error_events.
--
-- El módulo de Errores (ErrorsPanel) gana una safe-action "Reintentar
-- calificación" que reusa la RPC EXISTENTE `requeue_ai_grading_job(_job_id)`.
-- Esa RPC necesita el id del job de `ai_grading_queue`, que para los
-- errores del worker (`ai_grading.job_failed`, entity_type='ai_grading_queue')
-- vive en `audit_logs.entity_id`. La versión previa de `list_error_events`
-- (mig 20260713000000) NO devolvía `entity_id`, así que el cliente no
-- tenía forma de resolver el job a reencolar.
--
-- Cambio mínimo y aditivo: se recrea `list_error_events` idéntica pero
-- agregando la columna `entity_id UUID` al final del RETURNS TABLE (y su
-- `al.entity_id` en el SELECT). Como cambia el row type de OUT params,
-- Postgres exige DROP antes del CREATE (no basta CREATE OR REPLACE).
-- El scoping + autorización por rol/tenant NO se toca: mismo cuerpo.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.audit_logs') IS NULL THEN
    RAISE NOTICE 'skip list_error_events entity_id: audit_logs ausente';
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
    entity_id UUID
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
