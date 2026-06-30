-- ══════════════════════════════════════════════════════════════════════
-- Eliminar curso: contar contenido + cascada opcional + restore cascada.
--
-- Problema: el soft-delete de un curso NO cascadea → su contenido
-- (exámenes/talleres/proyectos/sesiones/pizarras/contenidos/encuestas) queda
-- HUÉRFANO (activo bajo un curso en papelera). Las RLS lo ocultan al alumno
-- (pases de auditoría 20261023/24), pero el docente/admin que borra el curso no
-- recibía aviso ni opción de qué hacer con ese contenido.
--
-- Este migration agrega 3 RPCs (espejo del patrón soft_delete_tenant/
-- restore_tenant, scopeado a UN curso):
--   1. course_content_summary(_course_id)  → conteo del contenido asociado
--      (para la advertencia en el diálogo de borrado).
--   2. soft_delete_course_cascade(_course_id, _cascade) → trashea el curso y,
--      si _cascade, todo su contenido con el MISMO timestamp (para restaurar en
--      bloque). Si _cascade=false, solo el curso (contenido queda huérfano/oculto).
--   3. restore_course_cascade(_course_id) → restaura el curso + los children que
--      cascadearon en la MISMA operación (mismo deleted_at). Los borrados
--      individualmente antes (timestamp distinto) permanecen en papelera.
--
-- Autorización (las 3): Admin del tenant del curso O docente del curso O SuperAdmin.
-- generated_contents/polls se cascadean por su course_id ANCLA (igual que
-- soft_delete_tenant); el contenido independiente (course_id NULL) no se toca.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public._can_manage_course(_course_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT public.is_super_admin()
    OR public.is_admin_of_course_tenant(_course_id)
    OR EXISTS (SELECT 1 FROM public.course_teachers ct WHERE ct.course_id = _course_id AND ct.user_id = auth.uid());
$fn$;
REVOKE ALL ON FUNCTION public._can_manage_course(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._can_manage_course(uuid) TO authenticated;

-- ── 1) Conteo de contenido asociado (para la advertencia) ──
CREATE OR REPLACE FUNCTION public.course_content_summary(_course_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  r jsonb;
BEGIN
  IF NOT public._can_manage_course(_course_id) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'exams',       (SELECT count(*) FROM public.exams               WHERE course_id = _course_id AND deleted_at IS NULL),
    'workshops',   (SELECT count(*) FROM public.workshops           WHERE course_id = _course_id AND deleted_at IS NULL),
    'projects',    (SELECT count(*) FROM public.projects            WHERE course_id = _course_id AND deleted_at IS NULL),
    'sessions',    (SELECT count(*) FROM public.attendance_sessions WHERE course_id = _course_id AND deleted_at IS NULL),
    'whiteboards', (SELECT count(*) FROM public.whiteboards         WHERE course_id = _course_id AND deleted_at IS NULL),
    'contents',    (SELECT count(*) FROM public.generated_contents  WHERE course_id = _course_id AND deleted_at IS NULL),
    'polls',       (SELECT count(*) FROM public.polls               WHERE course_id = _course_id AND deleted_at IS NULL),
    'enrollments', (SELECT count(*) FROM public.course_enrollments  WHERE course_id = _course_id),
    'forums',      COALESCE((SELECT count(*) FROM public.forums     WHERE course_id = _course_id), 0)
  ) INTO r;
  RETURN r;
END;
$fn$;
REVOKE ALL ON FUNCTION public.course_content_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.course_content_summary(uuid) TO authenticated;

-- ── 2) Soft-delete del curso, con cascada opcional ──
CREATE OR REPLACE FUNCTION public.soft_delete_course_cascade(_course_id uuid, _cascade boolean DEFAULT true)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller UUID := auth.uid();
  v_ts TIMESTAMPTZ := now();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public._can_manage_course(_course_id) THEN
    RAISE EXCEPTION 'No autorizado para eliminar este curso' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.courses WHERE id = _course_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'El curso no existe o ya está en la papelera' USING ERRCODE = 'P0001';
  END IF;

  -- Marcar el curso.
  UPDATE public.courses SET deleted_at = v_ts, deleted_by = v_caller
   WHERE id = _course_id AND deleted_at IS NULL;

  IF _cascade THEN
    -- Cascada con el MISMO timestamp (para restore en bloque). Solo filas
    -- aún activas (no se pisan timestamps de borrados individuales previos).
    UPDATE public.exams               SET deleted_at = v_ts, deleted_by = v_caller WHERE course_id = _course_id AND deleted_at IS NULL;
    UPDATE public.workshops           SET deleted_at = v_ts, deleted_by = v_caller WHERE course_id = _course_id AND deleted_at IS NULL;
    UPDATE public.projects            SET deleted_at = v_ts, deleted_by = v_caller WHERE course_id = _course_id AND deleted_at IS NULL;
    UPDATE public.attendance_sessions SET deleted_at = v_ts, deleted_by = v_caller WHERE course_id = _course_id AND deleted_at IS NULL;
    UPDATE public.whiteboards         SET deleted_at = v_ts, deleted_by = v_caller WHERE course_id = _course_id AND deleted_at IS NULL;
    UPDATE public.generated_contents  SET deleted_at = v_ts, deleted_by = v_caller WHERE course_id = _course_id AND deleted_at IS NULL;
    UPDATE public.polls               SET deleted_at = v_ts, deleted_by = v_caller WHERE course_id = _course_id AND deleted_at IS NULL;
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION public.soft_delete_course_cascade(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.soft_delete_course_cascade(uuid, boolean) TO authenticated;

-- ── 3) Restore del curso + cascada de la MISMA operación (mismo timestamp) ──
CREATE OR REPLACE FUNCTION public.restore_course_cascade(_course_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller UUID := auth.uid();
  v_ts TIMESTAMPTZ;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public._can_manage_course(_course_id) THEN
    RAISE EXCEPTION 'No autorizado para restaurar este curso' USING ERRCODE = '42501';
  END IF;

  SELECT deleted_at INTO v_ts FROM public.courses WHERE id = _course_id;
  IF v_ts IS NULL THEN
    RAISE EXCEPTION 'El curso no está en la papelera' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.courses SET deleted_at = NULL, deleted_by = NULL WHERE id = _course_id;

  -- Restaurar SOLO los children con el mismo timestamp (los que cascadearon
  -- al borrar el curso). Borrados individuales previos quedan en papelera.
  UPDATE public.exams               SET deleted_at = NULL, deleted_by = NULL WHERE course_id = _course_id AND deleted_at = v_ts;
  UPDATE public.workshops           SET deleted_at = NULL, deleted_by = NULL WHERE course_id = _course_id AND deleted_at = v_ts;
  UPDATE public.projects            SET deleted_at = NULL, deleted_by = NULL WHERE course_id = _course_id AND deleted_at = v_ts;
  UPDATE public.attendance_sessions SET deleted_at = NULL, deleted_by = NULL WHERE course_id = _course_id AND deleted_at = v_ts;
  UPDATE public.whiteboards         SET deleted_at = NULL, deleted_by = NULL WHERE course_id = _course_id AND deleted_at = v_ts;
  UPDATE public.generated_contents  SET deleted_at = NULL, deleted_by = NULL WHERE course_id = _course_id AND deleted_at = v_ts;
  UPDATE public.polls               SET deleted_at = NULL, deleted_by = NULL WHERE course_id = _course_id AND deleted_at = v_ts;
END;
$fn$;
REVOKE ALL ON FUNCTION public.restore_course_cascade(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.restore_course_cascade(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
