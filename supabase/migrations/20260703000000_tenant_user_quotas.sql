-- ──────────────────────────────────────────────────────────────────────
-- Cuotas de usuarios por institución (SuperAdmin la configura).
--
-- Cada institución tiene un tope de usuarios por rol. El SuperAdmin
-- (dueño de la plataforma) define el plan al crear/editar el tenant.
-- Cuando un Admin del tenant intenta crear un usuario que excede su
-- cuota, el INSERT en user_roles falla con mensaje accionable.
--
-- Diseño:
--   - 3 columnas en tenants: max_admins / max_teachers / max_students.
--     NULL = ilimitado (default; comportamiento previo).
--   - SuperAdmin se cuenta aparte: NO entra en max_admins (es cross-tenant).
--   - Trigger BEFORE INSERT en user_roles que chequea cuota.
--   - El conteo es por user_id distintos con ese rol asignado en
--     ESE tenant. Si un user tiene roles Admin+Docente, cuenta para AMBOS
--     contadores (cada rol cuenta independiente).
--
-- Errores devueltos al exceder cuota:
--   P0001 + mensaje custom para que friendlyError() lo muestre tal cual.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS max_admins SMALLINT,
  ADD COLUMN IF NOT EXISTS max_teachers SMALLINT,
  ADD COLUMN IF NOT EXISTS max_students SMALLINT;

COMMENT ON COLUMN public.tenants.max_admins IS
  'Tope de usuarios con rol Admin en esta institucion. NULL = ilimitado.';
COMMENT ON COLUMN public.tenants.max_teachers IS
  'Tope de usuarios con rol Docente. NULL = ilimitado.';
COMMENT ON COLUMN public.tenants.max_students IS
  'Tope de usuarios con rol Estudiante. NULL = ilimitado.';

-- CHECK: si se setea, debe ser >= 0.
ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_max_admins_check,
  DROP CONSTRAINT IF EXISTS tenants_max_teachers_check,
  DROP CONSTRAINT IF EXISTS tenants_max_students_check;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_max_admins_check
    CHECK (max_admins IS NULL OR max_admins >= 0),
  ADD CONSTRAINT tenants_max_teachers_check
    CHECK (max_teachers IS NULL OR max_teachers >= 0),
  ADD CONSTRAINT tenants_max_students_check
    CHECK (max_students IS NULL OR max_students >= 0);

-- ─── Trigger BEFORE INSERT en user_roles ────────────────────────────
-- Cuenta usuarios con el rol que se va a agregar EN el tenant del user
-- destino. Si excede el max correspondiente, rechaza.
CREATE OR REPLACE FUNCTION public.tg_check_tenant_user_quota()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant      UUID;
  v_max         INT;
  v_current     INT;
  v_label       TEXT;
  v_column      TEXT;
BEGIN
  -- SuperAdmin no consume cuota (es cross-tenant). Salimos rapido.
  IF NEW.role::text = 'SuperAdmin' THEN
    RETURN NEW;
  END IF;

  -- Tenant del usuario destino. Si el profile no tiene tenant (caso
  -- transitorio), no aplicamos cuota — el trigger de profiles lo
  -- forzara a default y la prox INSERT respetara la cuota.
  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id = NEW.user_id;
  IF v_tenant IS NULL THEN
    RETURN NEW;
  END IF;

  -- Resolver el max correspondiente al rol nuevo.
  CASE NEW.role::text
    WHEN 'Admin'      THEN v_column := 'max_admins';   v_label := 'administradores';
    WHEN 'Docente'    THEN v_column := 'max_teachers'; v_label := 'docentes';
    WHEN 'Estudiante' THEN v_column := 'max_students'; v_label := 'estudiantes';
    ELSE RETURN NEW;  -- rol desconocido: no aplicamos cuota
  END CASE;

  EXECUTE format(
    'SELECT %I FROM public.tenants WHERE id = $1', v_column
  ) INTO v_max USING v_tenant;

  -- NULL = ilimitado.
  IF v_max IS NULL THEN
    RETURN NEW;
  END IF;

  -- Conteo actual de usuarios distintos con ese rol en ESE tenant.
  -- COUNT(DISTINCT) por si user_id se repite en user_roles (unique constraint
  -- ya lo previene; pero defensivo).
  SELECT COUNT(DISTINCT ur.user_id) INTO v_current
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
   WHERE ur.role = NEW.role
     AND p.tenant_id = v_tenant;

  IF v_current >= v_max THEN
    RAISE EXCEPTION 'Cuota de % alcanzada (% / %). Aumenta el cupo desde el panel SuperAdmin o libera espacio quitando el rol a un usuario existente.',
      v_label, v_current, v_max
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_roles_quota_check ON public.user_roles;
CREATE TRIGGER trg_user_roles_quota_check
  BEFORE INSERT ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.tg_check_tenant_user_quota();

-- ─── Helper: contar usuarios actuales por rol en el tenant del caller ─
-- El AdminMyTenantPanel lo usa para mostrar "X / Y" en cada cuota sin
-- joinear desde el cliente.
CREATE OR REPLACE FUNCTION public.tenant_user_counts()
RETURNS JSONB
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (SELECT public.current_tenant_id() AS tid)
  SELECT jsonb_build_object(
    'admins', COALESCE((
      SELECT COUNT(DISTINCT ur.user_id)::INT
        FROM public.user_roles ur
        JOIN public.profiles p ON p.id = ur.user_id
       WHERE ur.role::text = 'Admin' AND p.tenant_id = (SELECT tid FROM me)
    ), 0),
    'teachers', COALESCE((
      SELECT COUNT(DISTINCT ur.user_id)::INT
        FROM public.user_roles ur
        JOIN public.profiles p ON p.id = ur.user_id
       WHERE ur.role::text = 'Docente' AND p.tenant_id = (SELECT tid FROM me)
    ), 0),
    'students', COALESCE((
      SELECT COUNT(DISTINCT ur.user_id)::INT
        FROM public.user_roles ur
        JOIN public.profiles p ON p.id = ur.user_id
       WHERE ur.role::text = 'Estudiante' AND p.tenant_id = (SELECT tid FROM me)
    ), 0)
  );
$$;

GRANT EXECUTE ON FUNCTION public.tenant_user_counts() TO authenticated;

NOTIFY pgrst, 'reload schema';
