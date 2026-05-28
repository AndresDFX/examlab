-- ──────────────────────────────────────────────────────────────────────
-- Módulo de gestión de errores de la plataforma
--
-- Fuente: `audit_logs` con severity='error' (errores runtime, edges,
-- crons, etc.). El Admin gestiona los de SU institución; el SuperAdmin
-- los de TODA la plataforma y puede filtrar por institución.
--
-- audit_logs NO tiene tenant_id y es append-only. Por eso:
--   - El TENANT de un error se DERIVA: tenant del actor (profiles), o
--     si no hay actor, tenant del curso (courses). Errores de sistema
--     (cron, sin actor ni curso) → tenant NULL → solo SuperAdmin.
--   - El ESTADO vive en una tabla lateral `error_event_status`
--     (audit_logs queda inmutable). Sin fila ⇒ estado 'nuevo'.
--
-- Estados: nuevo → revisando → resuelto | ignorado. Aplicables en bulk.
-- Todo el scoping + autorización vive en RPCs SECURITY DEFINER (no se
-- toca la RLS existente de audit_logs, que otros módulos ya usan).
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.error_event_status (
  audit_log_id UUID PRIMARY KEY REFERENCES public.audit_logs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'nuevo'
    CHECK (status IN ('nuevo', 'revisando', 'resuelto', 'ignorado')),
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.error_event_status ENABLE ROW LEVEL SECURITY;

-- Lectura/escritura directa solo Admin/SuperAdmin; igual el acceso real
-- pasa por los RPCs (que además scopean por tenant).
DROP POLICY IF EXISTS "error_event_status_manage" ON public.error_event_status;
CREATE POLICY "error_event_status_manage"
  ON public.error_event_status FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin())
  WITH CHECK (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin());

-- Tenant derivado de un error: actor → profiles.tenant_id, si no, curso.
CREATE OR REPLACE FUNCTION public._error_event_tenant(_actor_id UUID, _course_id UUID)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT p.tenant_id FROM public.profiles p WHERE p.id = _actor_id),
    (SELECT c.tenant_id FROM public.courses c WHERE c.id = _course_id)
  );
$$;

-- ── Listado de errores (scopeado + con estado) ──────────────────────
-- _tenant_filter: solo lo respeta el SuperAdmin ('all' o un tenant). El
-- Admin SIEMPRE se acota a su propio tenant, ignora el filtro.
CREATE OR REPLACE FUNCTION public.list_error_events(
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
  tenant_name TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
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
    t.name AS tenant_name
  FROM public.audit_logs al
  LEFT JOIN public.error_event_status es ON es.audit_log_id = al.id
  LEFT JOIN LATERAL (
    SELECT public._error_event_tenant(al.actor_id, al.course_id) AS tid
  ) der ON true
  LEFT JOIN public.tenants t ON t.id = der.tid
  WHERE al.severity = 'error'
    -- Scope por rol:
    AND (
      v_is_super
      OR (v_is_admin AND der.tid = v_my_tenant)
    )
    -- Filtro de institución (solo SuperAdmin):
    AND (
      NOT v_is_super
      OR _tenant_filter IS NULL
      OR der.tid = _tenant_filter
    )
    -- Filtro de estado:
    AND (
      _status_filter IS NULL
      OR COALESCE(es.status, 'nuevo') = _status_filter
    )
  ORDER BY al.created_at DESC
  LIMIT GREATEST(1, LEAST(_limit, 1000));
END;
$$;

-- ── Conteo por estado (para los tiles "cantidad de eventos") ─────────
CREATE OR REPLACE FUNCTION public.error_event_counts(
  _tenant_filter UUID DEFAULT NULL
)
RETURNS TABLE (status TEXT, count BIGINT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_is_super BOOLEAN := public.is_super_admin();
  v_is_admin BOOLEAN := public.has_role(auth.uid(), 'Admin');
  v_my_tenant UUID := public.current_tenant_id();
BEGIN
  IF NOT v_is_super AND NOT v_is_admin THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT COALESCE(es.status, 'nuevo') AS status, COUNT(*)::bigint
  FROM public.audit_logs al
  LEFT JOIN public.error_event_status es ON es.audit_log_id = al.id
  LEFT JOIN LATERAL (
    SELECT public._error_event_tenant(al.actor_id, al.course_id) AS tid
  ) der ON true
  WHERE al.severity = 'error'
    AND (v_is_super OR (v_is_admin AND der.tid = v_my_tenant))
    AND (NOT v_is_super OR _tenant_filter IS NULL OR der.tid = _tenant_filter)
  GROUP BY COALESCE(es.status, 'nuevo');
END;
$$;

-- ── Aplicar estado en bulk ───────────────────────────────────────────
-- Re-valida el scope: el Admin solo puede tocar errores de su tenant; el
-- SuperAdmin cualquiera. Upsert idempotente con reviewed_by/at.
CREATE OR REPLACE FUNCTION public.set_error_events_status(
  _ids UUID[],
  _status TEXT
)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_is_super BOOLEAN := public.is_super_admin();
  v_is_admin BOOLEAN := public.has_role(auth.uid(), 'Admin');
  v_my_tenant UUID := public.current_tenant_id();
  v_uid UUID := auth.uid();
  v_count INT;
BEGIN
  IF NOT v_is_super AND NOT v_is_admin THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  IF _status NOT IN ('nuevo', 'revisando', 'resuelto', 'ignorado') THEN
    RAISE EXCEPTION 'Estado inválido' USING ERRCODE = '22023';
  END IF;
  IF _ids IS NULL OR cardinality(_ids) = 0 THEN
    RETURN 0;
  END IF;

  WITH allowed AS (
    SELECT al.id
    FROM public.audit_logs al
    LEFT JOIN LATERAL (
      SELECT public._error_event_tenant(al.actor_id, al.course_id) AS tid
    ) der ON true
    WHERE al.id = ANY(_ids)
      AND al.severity = 'error'
      AND (v_is_super OR (v_is_admin AND der.tid = v_my_tenant))
  )
  INSERT INTO public.error_event_status (audit_log_id, status, reviewed_by, reviewed_at, updated_at)
  SELECT a.id, _status, v_uid, now(), now()
  FROM allowed a
  ON CONFLICT (audit_log_id) DO UPDATE
    SET status = EXCLUDED.status,
        reviewed_by = EXCLUDED.reviewed_by,
        reviewed_at = EXCLUDED.reviewed_at,
        updated_at = now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_error_events(UUID, TEXT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.error_event_counts(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_error_events_status(UUID[], TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
