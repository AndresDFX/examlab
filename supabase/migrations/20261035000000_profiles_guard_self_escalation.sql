-- ══════════════════════════════════════════════════════════════════════
-- Impedir que un usuario evada controles editando columnas sensibles de SU
-- PROPIO perfil vía REST directo.
--
-- Hallazgo (validación rol-a-rol, ciclo 5, 2026-06-30 — CONFIRMADO contra prod):
-- la policy `profiles_update_self` (USING/CHECK `id = auth.uid()`) permite que un
-- usuario actualice su propia fila, y como la RLS es a nivel FILA (no columna) +
-- `authenticated` tiene GRANT de UPDATE en todas las columnas, un usuario podía:
--
--   PATCH /rest/v1/profiles?id=eq.<mi_id>
--   { "is_active": true, "estado": "activo", "tenant_id": "<otra_institución>" }
--
-- Impacto:
--   • is_active: un usuario DESACTIVADO (feature de licencias) podía auto-
--     reactivarse — el gate de AppLayout (is_active=false) dejaba de bloquearlo.
--   • estado: un estudiante 'retirado'/'aplazado'/'graduado' podía ponerse
--     'activo' y recuperar la escritura (el guard student_can_write se basa en
--     estado).
--   • tenant_id: re-apuntar un tenant ya asignado = fuga cross-tenant
--     (current_tenant_id() pasaría a la institución víctima). El guard previo
--     tg_check_profile_tenant_change lo PERMITÍA si el usuario no tenía cursos
--     activos.
--
-- El único guard existente sobre profiles (tg_check_profile_tenant_change) solo
-- mira tenant_id — no is_active/estado/deactivated_*.
--
-- FIX: trigger BEFORE UPDATE que, para un caller NO-admin, RECHAZA cambiar
-- is_active / deactivated_at / deactivated_by / estado, y RECHAZA re-apuntar un
-- tenant_id ya asignado (se permite la PRIMERA asignación OLD NULL → onboarding).
-- Se PERMITE cuando:
--   • auth.uid() IS NULL → service_role (edge admin-set-user-active, bulk-import
--     que setea estado, y triggers de sistema).
--   • el caller es Admin o SuperAdmin (gestión legítima; la RLS
--     profiles_admin_manage_same_tenant ya lo acota al tenant).
-- NO se protege must_change_password: el diálogo de cambio forzado
-- (ForceChangePasswordDialog) lo pone en false como self-update legítimo.
-- Fast-path: si el UPDATE no toca columnas protegidas (editar full_name, avatar,
-- preferencias, codigo/documento, must_change_password) retorna sin consultar rol.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_guard_profile_self_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_touch boolean;
  v_is_admin boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;  -- service_role / sistema

  v_touch :=
       NEW.is_active      IS DISTINCT FROM OLD.is_active
    OR NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at
    OR NEW.deactivated_by IS DISTINCT FROM OLD.deactivated_by
    OR NEW.estado         IS DISTINCT FROM OLD.estado
    -- tenant_id: la PRIMERA asignación (OLD NULL) es onboarding legítimo; re-
    -- apuntar un tenant ya asignado es escalación cross-tenant.
    OR (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND OLD.tenant_id IS NOT NULL);

  IF NOT v_touch THEN RETURN NEW; END IF;

  v_is_admin := public.is_super_admin() OR public.has_role(v_uid, 'Admin');
  IF v_is_admin THEN RETURN NEW; END IF;

  RAISE EXCEPTION 'No autorizado: solo un administrador puede cambiar el estado de activación, el estado académico o la institución de un usuario';
END
$$;

DO $$ BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_guard_profile_self_escalation ON public.profiles;
    CREATE TRIGGER trg_guard_profile_self_escalation
      BEFORE UPDATE ON public.profiles
      FOR EACH ROW EXECUTE FUNCTION public.tg_guard_profile_self_escalation();
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
