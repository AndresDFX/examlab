-- ──────────────────────────────────────────────────────────────────────
-- hard_delete_tenant — borrar profiles + auth.users del tenant.
--
-- Cambio respecto a la versión anterior (mig 20260902000000):
--   - Antes: profiles del tenant se DESAFILIABAN (tenant_id = NULL).
--     Los users quedaban en `auth.users` pero sin institución y por
--     tanto sin acceso (el selector de /auth filtra tenant válido).
--   - Ahora: profiles del tenant se BORRAN FÍSICAMENTE + sus filas en
--     `auth.users` también. El user reportó que tras eliminar un tenant
--     el "usuario de prueba" seguía vivo en la base — comportamiento
--     no deseado para hard-delete (deja huellas).
--
-- Defensiva:
--   - NUNCA borrar al propio caller (SuperAdmin) aunque por error tenga
--     `tenant_id = _tenant_id` (no debería, pero por las dudas).
--   - NUNCA borrar a OTROS SuperAdmins (caso raro pero defensa-en-
--     profundidad — un SA cross-tenant no debería ser arrastrado por
--     borrar un tenant que casualmente comparte tenant_id).
--   - Las FKs hacia auth.users que el repo declara como CASCADE
--     (course_enrollments, submissions, etc.) se resuelven solas. Las
--     SET NULL (support_tickets.created_by, audit_logs.actor_id) dejan
--     histórico anónimo. Si una FK desconocida tiene RESTRICT, el
--     EXCEPTION handler devuelve SQLERRM con la tabla bloqueante.
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
  v_user_ids UUID[];
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

  -- ── 1) Capturar los user_ids a eliminar ──
  -- Filtros defensivos:
  --   - id <> v_caller: nunca eliminar al SA que está ejecutando la RPC.
  --   - NOT EXISTS user_roles SuperAdmin: nunca eliminar a OTROS SuperAdmins.
  --     (Caso raro: un SA podría tener tenant_id seteado por accidente.)
  SELECT ARRAY(
    SELECT p.id
      FROM public.profiles p
     WHERE p.tenant_id = _tenant_id
       AND p.id <> v_caller
       AND NOT EXISTS (
         SELECT 1 FROM public.user_roles ur
          WHERE ur.user_id = p.id AND ur.role = 'SuperAdmin'
       )
  ) INTO v_user_ids;

  -- ── 2) Cleanup de tablas RESTRICT ──
  -- academic_* y videos tienen ON DELETE RESTRICT directo a tenants.
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
  -- course_teachers, course_schedules) cascadean via FK a courses.
  IF to_regclass('public.courses') IS NOT NULL THEN
    DELETE FROM public.courses WHERE tenant_id = _tenant_id;
  END IF;

  -- ── 4) Borrar profiles del tenant ──
  -- Antes era `UPDATE ... SET tenant_id = NULL`. Ahora DELETE físico para
  -- que no queden cuentas huérfanas tras un hard-delete del tenant.
  -- Mismos filtros defensivos que el SELECT de v_user_ids.
  DELETE FROM public.profiles
   WHERE tenant_id = _tenant_id
     AND id <> v_caller
     AND NOT EXISTS (
       SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = profiles.id AND ur.role = 'SuperAdmin'
     );

  -- ── 5) DELETE del tenant ──
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

  -- ── 6) Borrar auth.users de los miembros ──
  -- AL FINAL — para que las cascadas (course_enrollments → user_id,
  -- submissions → user_id, etc.) ya hayan corrido vía cleanup de courses.
  -- Si una FK desconocida tiene RESTRICT sobre auth.users, el EXCEPTION
  -- handler devuelve SQLERRM para que el SA sepa qué tabla bloquea.
  IF cardinality(v_user_ids) > 0 THEN
    BEGIN
      DELETE FROM auth.users WHERE id = ANY(v_user_ids);
    EXCEPTION
      WHEN foreign_key_violation THEN
        RAISE EXCEPTION
          'La institución se eliminó pero quedaron usuarios con referencias. Detalle: %',
          SQLERRM
          USING ERRCODE = 'P0001';
      WHEN OTHERS THEN
        RAISE EXCEPTION
          'La institución se eliminó pero falló el borrado de usuarios. Detalle: %',
          SQLERRM
          USING ERRCODE = 'P0001';
    END;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.hard_delete_tenant(UUID) IS
  'Borrado fisico de un tenant que ya esta en papelera. Limpia academic_*, videos, courses (cascade a hijos), profiles del tenant y auth.users de esos profiles. Excluye al caller y a SuperAdmins. Solo SuperAdmin.';

GRANT EXECUTE ON FUNCTION public.hard_delete_tenant(UUID) TO authenticated;
