-- ════════════════════════════════════════════════════════════════════════
-- IA Compartida: el Admin de la institución puede SOBRESCRIBIR y usar su propia
-- IA (ai_mode: 'shared' ↔ 'own') SIN afectar a otras instituciones.
--
-- Hasta ahora `ai_mode` era SA-only (guard tg_guard_tenant_commercial_columns).
-- El usuario pidió que el Admin pueda optar por su propia IA. Lo permitimos SOLO
-- por una RPC sancionada `set_my_tenant_ai_mode` que:
--   - valida que el caller es Admin,
--   - resuelve SU tenant (nunca toca otro → aislamiento),
--   - limita los valores a 'shared' | 'own' (NO 'managed', que es arreglo comercial SA),
--   - setea un GUC transaction-local que el guard reconoce como ruta autorizada.
-- El resto de columnas comerciales (plan, cupos, facturación) siguen SA-only.
--
-- La ALERTA previa al Admin ("esto se cobra a tu cuenta, si tu key falla tu IA se
-- cae, no afecta a otras instituciones") vive en el UI (AdminModelPanel), que
-- confirma ANTES de invocar esta RPC.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_guard_tenant_commercial_columns()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  -- Ruta autorizada para cambiar SOLO ai_mode (la setea set_my_tenant_ai_mode).
  v_ai_mode_allowed boolean := current_setting('app.allow_ai_mode_change', true) = 'true';
BEGIN
  -- Contextos internos (sin JWT de usuario) o SuperAdmin: pasan.
  IF auth.uid() IS NULL OR public.is_super_admin() THEN
    RETURN NEW;
  END IF;

  -- ai_mode: el Admin lo cambia SOLO por la RPC sancionada (GUC seteado). Fuera
  -- de esa ruta, sigue siendo SA-only como el resto de columnas comerciales.
  IF NEW.ai_mode IS DISTINCT FROM OLD.ai_mode AND NOT v_ai_mode_allowed THEN
    RAISE EXCEPTION 'El modo de IA se cambia desde Configuración → IA (o lo ajusta el SuperAdmin).'
      USING ERRCODE = '42501';
  END IF;

  IF (
       NEW.plan_tier            IS DISTINCT FROM OLD.plan_tier
    OR NEW.contracted_services  IS DISTINCT FROM OLD.contracted_services
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

-- El Admin cambia el modo de IA de SU institución (shared ↔ own). SECURITY
-- DEFINER: la UPDATE bypassa la RLS SA-only de tenants; el GUC transaction-local
-- habilita la excepción del guard SOLO para esta operación.
CREATE OR REPLACE FUNCTION public.set_my_tenant_ai_mode(_mode text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  IF _mode IS NULL OR _mode NOT IN ('shared', 'own') THEN
    RAISE EXCEPTION 'Modo de IA inválido: usa compartida (shared) o propia (own).'
      USING ERRCODE = '22023';
  END IF;
  IF NOT public.has_role(auth.uid(), 'Admin'::public.app_role) THEN
    RAISE EXCEPTION 'Solo un administrador de la institución puede cambiar el modo de IA.'
      USING ERRCODE = '42501';
  END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id = auth.uid();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No se pudo determinar tu institución.' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.allow_ai_mode_change', 'true', true);
  UPDATE public.tenants SET ai_mode = _mode WHERE id = v_tenant;
END $$;

REVOKE ALL ON FUNCTION public.set_my_tenant_ai_mode(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_tenant_ai_mode(text) TO authenticated;

-- Lectura del modo actual para el propio tenant del Admin (no expone otras cols
-- comerciales). SECURITY DEFINER + scope al tenant del caller.
CREATE OR REPLACE FUNCTION public.my_tenant_ai_mode()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT t.ai_mode
    FROM public.tenants t
    JOIN public.profiles p ON p.tenant_id = t.id
   WHERE p.id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.my_tenant_ai_mode() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_tenant_ai_mode() TO authenticated;

NOTIFY pgrst, 'reload schema';
