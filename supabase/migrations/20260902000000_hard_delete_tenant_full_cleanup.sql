-- ──────────────────────────────────────────────────────────────────────
-- hard_delete_tenant — cleanup explícito de dependencias.
--
-- Bug reportado: el SuperAdmin no podía hard-delete tenants desde la
-- papelera. La UI mostraba "0 eliminado(s), 2 con error" sin detalle.
--
-- Causa: el RPC original hacía solo `DELETE FROM tenants WHERE id = X`
-- y confiaba en el cascade de las FKs. Pero VARIAS tablas tienen
-- `ON DELETE RESTRICT` sobre tenants.id — diseño defensivo histórico
-- para evitar borrados accidentales:
--   - profiles            (mig 20260621000000:81)
--   - courses             (mig 20260622000000:201)
--   - academic_programs   (mig 20260622000000:32)
--   - academic_periods    (mig 20260622000000:96)
--   - academic_subjects   (mig 20260622000000:145)
--   - videos              (mig 20260528020000:24)
--
-- Con esos RESTRICT, el DELETE del tenant fallaba con SQLSTATE 23503
-- pero el RPC original lo dejaba burbujear como error genérico — la
-- UI lo recibía y mostraba "error" sin nombrar la tabla bloqueante.
--
-- Fix de este script:
--   1. Profiles → SET tenant_id = NULL (no los borramos — el SuperAdmin
--      probablemente quiere re-asignarlos o conservarlos huérfanos para
--      auditoría). Sin SET NULL, los profiles bloquearían el DELETE.
--   2. Cleanup explícito de las tablas RESTRICT: borramos academic_*,
--      videos y courses (con todos sus hijos via cascade de las FKs de
--      courses → exams/workshops/projects/sesiones/etc.).
--   3. DELETE del tenant envuelto en BEGIN/EXCEPTION para devolver
--      SQLERRM completo si una FK desconocida sigue bloqueando — al
--      menos el SuperAdmin sabe QUÉ tabla queda y puede limpiarla.
--
-- Las tablas con CASCADE o SET NULL (notifications, audit_logs,
-- whiteboards, app_settings, certificate_settings, ai_model_settings,
-- ai_prompts, module_visibility) se manejan solas al borrar el tenant
-- — no necesitan cleanup explícito.
-- ──────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.hard_delete_tenant(UUID);

CREATE OR REPLACE FUNCTION public.hard_delete_tenant(_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_is_super BOOLEAN;
  v_in_trash BOOLEAN;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = 'P0001';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = v_caller AND role = 'SuperAdmin'
  ) INTO v_is_super;

  IF NOT v_is_super THEN
    RAISE EXCEPTION 'Solo SuperAdmin puede eliminar definitivamente una institución'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = _tenant_id AND deleted_at IS NOT NULL
  ) INTO v_in_trash;

  IF NOT v_in_trash THEN
    RAISE EXCEPTION 'La institución debe estar en papelera antes del borrado definitivo'
      USING ERRCODE = 'P0001';
  END IF;

  -- ── 1) Desafiliar profiles ──
  -- Setear tenant_id = NULL preserva los usuarios pero los deja sin
  -- institución. Quedan inactivos (el selector de /auth filtra por
  -- tenant válido) pero recuperables si el SuperAdmin los re-asigna.
  IF to_regclass('public.profiles') IS NOT NULL THEN
    UPDATE public.profiles
       SET tenant_id = NULL
     WHERE tenant_id = _tenant_id;
  END IF;

  -- ── 2) Cleanup de tablas RESTRICT ──
  -- academic_* y videos tienen ON DELETE RESTRICT directo a tenants.
  -- Sin estos DELETEs explícitos, el cascade del tenant falla.

  IF to_regclass('public.academic_periods') IS NOT NULL THEN
    DELETE FROM public.academic_periods WHERE tenant_id = _tenant_id;
  END IF;

  IF to_regclass('public.academic_subjects') IS NOT NULL THEN
    DELETE FROM public.academic_subjects WHERE tenant_id = _tenant_id;
  END IF;

  IF to_regclass('public.academic_programs') IS NOT NULL THEN
    DELETE FROM public.academic_programs WHERE tenant_id = _tenant_id;
  END IF;

  IF to_regclass('public.videos') IS NOT NULL THEN
    DELETE FROM public.videos WHERE tenant_id = _tenant_id;
  END IF;

  -- ── 3) Cleanup de courses ──
  -- courses.tenant_id es RESTRICT. Sus hijos (exams, workshops, projects,
  -- attendance_sessions, polls, generated_contents, course_enrollments,
  -- course_teachers, course_schedules, etc.) tienen FK con CASCADE a
  -- courses, así que basta borrar courses para que todo lo demás caiga.
  IF to_regclass('public.courses') IS NOT NULL THEN
    DELETE FROM public.courses WHERE tenant_id = _tenant_id;
  END IF;

  -- ── 4) DELETE del tenant ──
  -- Envuelto en BEGIN/EXCEPTION para que si una FK desconocida sigue
  -- bloqueando, el SuperAdmin reciba el mensaje original de PG (con el
  -- nombre de la tabla violadora). Mejor que el "error genérico" que
  -- tiraba antes.
  BEGIN
    DELETE FROM public.tenants WHERE id = _tenant_id;
  EXCEPTION
    WHEN foreign_key_violation THEN
      RAISE EXCEPTION
        'No se pudo eliminar la institución: hay datos relacionados que lo impiden. Detalle: %',
        SQLERRM
        USING ERRCODE = 'P0001';
    WHEN OTHERS THEN
      RAISE EXCEPTION
        'No se pudo eliminar la institución. Detalle: %',
        SQLERRM
        USING ERRCODE = 'P0001';
  END;
END;
$$;

COMMENT ON FUNCTION public.hard_delete_tenant(UUID) IS
  'Borrado fisico de un tenant que ya esta en papelera. Limpia dependencias RESTRICT explicitamente (profiles SET NULL, academic_*, videos, courses con CASCADE a sus hijos). Devuelve SQLERRM si una FK desconocida sigue bloqueando. Solo SuperAdmin.';

GRANT EXECUTE ON FUNCTION public.hard_delete_tenant(UUID) TO authenticated;
