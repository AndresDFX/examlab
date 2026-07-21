-- ════════════════════════════════════════════════════════════════════════
-- Módulo comercial — almacenamiento por institución en el overview del SA.
--
-- Agrega storage_bytes (uso real) + storage_quota_mb (cupo) a
-- superadmin_tenant_overview, para que el SA vea "de un vistazo" cuánto ocupa
-- cada institución. Se computa EN VIVO (storage.objects es chico hoy — ~150
-- filas; el agregado es instantáneo). Si crece mucho, migrar a un snapshot
-- materializado refrescado por cron (ver WF3 §2.6).
--
-- Mapeo owner→tenant: los buckets owner-keyed guardan el path como
-- `<ownerUserId>/...`; se joina el 1er segmento con profiles.tenant_id (mismo
-- patrón que 20260998). Buckets de entregas grupales (project-files/
-- workshop-files) usan group_id en el 1er segmento → no mapean con este join;
-- para visibilidad basta generated-contents (dominante) + feedback/support/certs.
-- ════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.superadmin_tenant_overview();

CREATE FUNCTION public.superadmin_tenant_overview()
RETURNS TABLE (
  tenant_id uuid, name text, slug text, is_active boolean,
  plan_tier text, ai_mode text, has_own_ai_key boolean, contracted_services jsonb,
  admins int, teachers int, students int,
  max_admins int, max_teachers int, max_students int,
  storage_bytes bigint, storage_quota_mb int,
  subscription_status text, billing_start date, billing_end date,
  billing_cycle text, monthly_amount numeric, currency text,
  grace_business_days smallint, auto_suspend boolean, suspended_at timestamptz,
  days_left int
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, storage
AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Solo el SuperAdmin.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT
      t.id, t.name, t.slug, t.is_active,
      t.plan_tier, t.ai_mode,
      EXISTS (
        SELECT 1 FROM public.ai_model_settings ams
         WHERE ams.tenant_id = t.id
           AND (COALESCE(ams.gemini_api_key,'') <> '' OR COALESCE(ams.openai_api_key,'') <> '')
      ) AS has_own_ai_key,
      t.contracted_services,
      public.tenant_role_count(t.id, 'Admin'::public.app_role),
      public.tenant_role_count(t.id, 'Docente'::public.app_role),
      public.tenant_role_count(t.id, 'Estudiante'::public.app_role),
      t.max_admins::int, t.max_teachers::int, t.max_students::int,
      st.bytes, t.storage_quota_mb,
      t.subscription_status, t.billing_start, t.billing_end,
      t.billing_cycle, t.monthly_amount, t.currency,
      t.grace_business_days, t.auto_suspend, t.suspended_at,
      CASE WHEN t.billing_end IS NULL THEN NULL ELSE (t.billing_end - current_date) END
    FROM public.tenants t
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM((o.metadata->>'size')::bigint), 0)::bigint AS bytes
        FROM storage.objects o
        JOIN public.profiles p2 ON p2.id::text = (storage.foldername(o.name))[1]
       WHERE p2.tenant_id = t.id
         AND o.bucket_id IN ('generated-contents','feedback-attachments','support-attachments','certificates')
    ) st ON true
    ORDER BY t.name ASC;
END $$;

REVOKE ALL ON FUNCTION public.superadmin_tenant_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.superadmin_tenant_overview() TO authenticated;

NOTIFY pgrst, 'reload schema';
