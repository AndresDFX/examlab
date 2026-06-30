-- ══════════════════════════════════════════════════════════════════════
-- Desactivar usuarios + no consumir licencia.
--
-- profiles.is_active = false → el usuario no inicia sesión (el ban real lo pone
-- la edge admin-set-user-active vía GoTrue ban_duration; este flag es el espejo
-- en DB para UI + conteo de licencia) y NO cuenta para la cuota del tenant.
--
-- NO se reusa profiles.estado (es CHECK académico activo/retirado/graduado/
-- aplazado y studentAccessLevel ignora a staff). is_active es genérico (cualquier rol).
--
-- Centraliza el conteo de "licencia ocupada" en tenant_role_count(tenant, role)
-- — hoy duplicado entre tg_check_tenant_user_quota() y tenant_user_counts()
-- (mig 20260703000000) — y le agrega el filtro is_active=true. Así desactivar
-- libera cupo y el card "X/Y" queda byte-equivalente al gate.
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS deactivated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_profiles_inactive ON public.profiles(tenant_id) WHERE is_active = false;
  END IF;
END $$;

-- Conteo de licencia ocupada por (tenant, rol): usuarios DISTINTOS ACTIVOS con
-- ese rol. Inactivos NO cuentan. SECURITY DEFINER para que el trigger y el card
-- consuman exactamente la misma definición.
CREATE OR REPLACE FUNCTION public.tenant_role_count(_tenant uuid, _role public.app_role)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COUNT(DISTINCT ur.user_id)::int
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
   WHERE ur.role = _role
     AND p.tenant_id = _tenant
     AND COALESCE(p.is_active, true) = true;
$fn$;
REVOKE ALL ON FUNCTION public.tenant_role_count(uuid, public.app_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tenant_role_count(uuid, public.app_role) TO authenticated;

-- Trigger de cuota: usa el helper (inactivos no ocupan cupo).
CREATE OR REPLACE FUNCTION public.tg_check_tenant_user_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant  UUID;
  v_max     INT;
  v_current INT;
  v_label   TEXT;
  v_column  TEXT;
BEGIN
  IF NEW.role::text = 'SuperAdmin' THEN
    RETURN NEW;
  END IF;

  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id = NEW.user_id;
  IF v_tenant IS NULL THEN
    RETURN NEW;
  END IF;

  CASE NEW.role::text
    WHEN 'Admin'      THEN v_column := 'max_admins';   v_label := 'administradores';
    WHEN 'Docente'    THEN v_column := 'max_teachers'; v_label := 'docentes';
    WHEN 'Estudiante' THEN v_column := 'max_students'; v_label := 'estudiantes';
    ELSE RETURN NEW;
  END CASE;

  EXECUTE format('SELECT %I FROM public.tenants WHERE id = $1', v_column)
    INTO v_max USING v_tenant;

  IF v_max IS NULL THEN
    RETURN NEW;
  END IF;

  -- Conteo centralizado (excluye inactivos). Si el usuario destino está
  -- inactivo, no se autocuenta — pero la reactivación NO pasa por aquí (no
  -- inserta user_roles), así que la edge admin-set-user-active re-chequea cuota.
  v_current := public.tenant_role_count(v_tenant, NEW.role);

  IF v_current >= v_max THEN
    RAISE EXCEPTION 'Cuota de % alcanzada (% / %). Aumenta el cupo desde el panel SuperAdmin, desactiva un usuario, o libera espacio quitando el rol a un usuario existente.',
      v_label, v_current, v_max
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;

-- Card "X/Y": mismo helper → el conteo del card y el gate son idénticos.
CREATE OR REPLACE FUNCTION public.tenant_user_counts()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH me AS (SELECT public.current_tenant_id() AS tid)
  SELECT jsonb_build_object(
    'admins',   COALESCE(public.tenant_role_count((SELECT tid FROM me), 'Admin'::public.app_role), 0),
    'teachers', COALESCE(public.tenant_role_count((SELECT tid FROM me), 'Docente'::public.app_role), 0),
    'students', COALESCE(public.tenant_role_count((SELECT tid FROM me), 'Estudiante'::public.app_role), 0)
  );
$function$;

NOTIFY pgrst, 'reload schema';
