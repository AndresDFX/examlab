-- ════════════════════════════════════════════════════════════════════════
-- Módulo comercial de Instituciones (SuperAdmin) — Fase 0/1 + capa DB de Fase 2.
--
-- Da al SuperAdmin visibilidad "de un vistazo" por institución: plan, servicios
-- contratados, modo de IA (compartida/propia/gestionada), licencias (uso vs cupo)
-- y ciclo de facturación (fechas + estado). Todo lo COMERCIAL es SA-only.
--
-- Defaults = realidad actual (cortesía, IA compartida, sin servicio contratado,
-- auto_suspend=false) → CERO cambio de comportamiento y el cron de facturación
-- (Fase 3) NUNCA corta a nadie por accidente (guard billing_end IS NOT NULL).
--
-- Contador de licencias: `tenant_role_count` deja de contar usuarios en borrado
-- lógico (`profiles.deleted_at`), así desactivar/eliminar baja el cupo.
--
-- Bloqueo de acceso: `current_tenant_id()` devuelve NULL para un usuario
-- desactivado o eliminado lógicamente → la RLS tenant-scoped (USING tenant_id =
-- current_tenant_id()) le da CERO filas en lectura y escritura, en TODAS las
-- tablas, sin tocar policy por policy. El SuperAdmin no se afecta (bypassa por
-- is_super_admin()). Patrón verificado contra prod con SET LOCAL ROLE.
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. Columnas comerciales en tenants (defensivo: solo si la tabla existe) ──
DO $$
BEGIN
  IF to_regclass('public.tenants') IS NOT NULL THEN
    ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS plan_tier TEXT NOT NULL DEFAULT 'cortesia'
      CHECK (plan_tier IN ('cortesia','esencial','profesional','institucional','custom'));
    ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS contracted_services JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS ai_mode TEXT NOT NULL DEFAULT 'shared'
      CHECK (ai_mode IN ('shared','own','managed'));
    ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS storage_quota_mb INTEGER;
    ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'active'
      CHECK (subscription_status IN ('trial','active','past_due','suspended','cancelled','expired'));
    ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS billing_start DATE;
    ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS billing_end DATE;
    ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS billing_cycle TEXT NOT NULL DEFAULT 'monthly'
      CHECK (billing_cycle IN ('monthly','quarterly','yearly'));
    ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS monthly_amount NUMERIC(12,2);
    ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
    ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS grace_business_days SMALLINT NOT NULL DEFAULT 5
      CHECK (grace_business_days >= 0 AND grace_business_days <= 60);
    ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS auto_suspend BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
    ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS suspended_reason TEXT;
    ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS billing_contact_email TEXT;
    ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS billing_notes TEXT;
    -- Backfill: antigüedad = fecha de creación. El resto queda en defaults.
    UPDATE public.tenants SET billing_start = created_at::date WHERE billing_start IS NULL;
  END IF;
END $$;

-- ── 2. Borrado lógico de usuarios (profiles) ────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_profiles_deleted ON public.profiles(tenant_id) WHERE deleted_at IS NOT NULL;
  END IF;
END $$;

-- ── 3. Contador de licencias: excluir usuarios en borrado lógico ────────────
-- Misma firma → OR REPLACE toca el único punto de verdad (trigger de cupo +
-- card tenant_user_counts + reactivación). Desactivar (is_active=false) o
-- eliminar (deleted_at) baja el conteo automáticamente.
CREATE OR REPLACE FUNCTION public.tenant_role_count(_tenant uuid, _role public.app_role)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT COUNT(DISTINCT ur.user_id)::int
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
   WHERE ur.role = _role
     AND p.tenant_id = _tenant
     AND COALESCE(p.is_active, true) = true
     AND p.deleted_at IS NULL;
$fn$;

-- ── 4. Bloqueo de acceso: current_tenant_id() = NULL si bloqueado ───────────
-- Un usuario desactivado o eliminado lógicamente pierde su tenant → la RLS
-- tenant-scoped lo deja sin filas. El SA (tenant_id NULL + is_super_admin) no
-- se ve afectado por esta rama.
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS UUID
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT tenant_id FROM public.profiles
   WHERE id = auth.uid()
     AND COALESCE(is_active, true) = true
     AND deleted_at IS NULL;
$$;

-- ── 5. Guard: solo el SuperAdmin cambia columnas COMERCIALES + cupos ────────
-- Cierra el gap "un Admin eleva sus propios cupos / cambia su plan" vía PATCH
-- REST directo. Exime al service_role / contextos sin auth.uid() (backfill,
-- provisión, edges) para no romper esos flujos.
CREATE OR REPLACE FUNCTION public.tg_guard_tenant_commercial_columns()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- Contextos internos (sin JWT de usuario) o SuperAdmin: pasan.
  IF auth.uid() IS NULL OR public.is_super_admin() THEN
    RETURN NEW;
  END IF;
  IF (
       NEW.plan_tier            IS DISTINCT FROM OLD.plan_tier
    OR NEW.contracted_services  IS DISTINCT FROM OLD.contracted_services
    OR NEW.ai_mode              IS DISTINCT FROM OLD.ai_mode
    OR NEW.storage_quota_mb     IS DISTINCT FROM OLD.storage_quota_mb
    OR NEW.subscription_status  IS DISTINCT FROM OLD.subscription_status
    OR NEW.billing_start        IS DISTINCT FROM OLD.billing_start
    OR NEW.billing_end          IS DISTINCT FROM OLD.billing_end
    OR NEW.billing_cycle        IS DISTINCT FROM OLD.billing_cycle
    OR NEW.monthly_amount       IS DISTINCT FROM OLD.monthly_amount
    OR NEW.currency             IS DISTINCT FROM OLD.currency
    OR NEW.grace_business_days  IS DISTINCT FROM OLD.grace_business_days
    OR NEW.auto_suspend         IS DISTINCT FROM OLD.auto_suspend
    OR NEW.suspended_at         IS DISTINCT FROM OLD.suspended_at
    OR NEW.suspended_reason     IS DISTINCT FROM OLD.suspended_reason
    OR NEW.billing_contact_email IS DISTINCT FROM OLD.billing_contact_email
    OR NEW.billing_notes        IS DISTINCT FROM OLD.billing_notes
    OR NEW.max_admins           IS DISTINCT FROM OLD.max_admins
    OR NEW.max_teachers         IS DISTINCT FROM OLD.max_teachers
    OR NEW.max_students         IS DISTINCT FROM OLD.max_students
  ) THEN
    RAISE EXCEPTION 'Solo el SuperAdmin puede modificar el plan, los cupos o la facturación de la institución.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF to_regclass('public.tenants') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS tg_guard_tenant_commercial_columns ON public.tenants;
    CREATE TRIGGER tg_guard_tenant_commercial_columns
      BEFORE UPDATE ON public.tenants
      FOR EACH ROW EXECUTE FUNCTION public.tg_guard_tenant_commercial_columns();
  END IF;
END $$;

-- ── 6. RPC consolidado para el grid SA (evita N+1) ──────────────────────────
CREATE OR REPLACE FUNCTION public.superadmin_tenant_overview()
RETURNS TABLE (
  tenant_id uuid, name text, slug text, is_active boolean,
  plan_tier text, ai_mode text, has_own_ai_key boolean, contracted_services jsonb,
  admins int, teachers int, students int,
  max_admins int, max_teachers int, max_students int,
  subscription_status text, billing_start date, billing_end date,
  billing_cycle text, monthly_amount numeric, currency text,
  grace_business_days smallint, auto_suspend boolean, suspended_at timestamptz,
  days_left int
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
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
      t.subscription_status, t.billing_start, t.billing_end,
      t.billing_cycle, t.monthly_amount, t.currency,
      t.grace_business_days, t.auto_suspend, t.suspended_at,
      CASE WHEN t.billing_end IS NULL THEN NULL ELSE (t.billing_end - current_date) END
    FROM public.tenants t
    ORDER BY t.name ASC;
END $$;

REVOKE ALL ON FUNCTION public.superadmin_tenant_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.superadmin_tenant_overview() TO authenticated;

-- ── 7. RPC para el Admin del tenant: su estado de facturación (sin sensibles) ─
CREATE OR REPLACE FUNCTION public.my_tenant_billing()
RETURNS TABLE (subscription_status text, plan_tier text, billing_end date, days_left int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_tenant uuid := public.current_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT t.subscription_status, t.plan_tier, t.billing_end,
           CASE WHEN t.billing_end IS NULL THEN NULL ELSE (t.billing_end - current_date) END
      FROM public.tenants t WHERE t.id = v_tenant;
END $$;

REVOKE ALL ON FUNCTION public.my_tenant_billing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_tenant_billing() TO authenticated;

NOTIFY pgrst, 'reload schema';
