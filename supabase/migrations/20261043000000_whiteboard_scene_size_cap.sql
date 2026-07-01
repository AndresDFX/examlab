-- ══════════════════════════════════════════════════════════════════════
-- Pizarra compartida: cota de tamaño al escribir la escena (anti-abuso).
--
-- Hallazgo (workflow de errores, 2026-07-01): en una sesión con
-- whiteboard_shared=true, CUALQUIER alumno matriculado puede llamar
-- update_session_whiteboard_scene(_session_id, _scene) y el UPDATE escribía
-- _scene TAL CUAL en whiteboard_scene, sin validar tamaño. Un alumno podía
-- inyectar un JSONB gigante, inflando la fila + el broadcast realtime y
-- degradando la pizarra para todos (griefing/DoS de sesión).
--
-- Fix: cota server-side de 5 MB (holgada para una escena Excalidraw legítima)
-- antes de escribir. Se preserva VERBATIM el resto de la validación
-- (papelera, docente/admin/SA bypass, alumno solo si shared + matriculado).
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.update_session_whiteboard_scene(_session_id uuid, _scene jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_course_id UUID;
  v_shared BOOLEAN;
  v_deleted_at TIMESTAMPTZ;
  v_is_teacher BOOLEAN;
  v_is_enrolled BOOLEAN;
BEGIN
  -- Cota de tamaño (anti-abuso): 5 MB es holgado para una escena legítima.
  IF octet_length(_scene::text) > 5 * 1024 * 1024 THEN
    RAISE EXCEPTION 'La escena de la pizarra es demasiado grande (máximo 5 MB)'
      USING ERRCODE = 'P0001';
  END IF;
  -- Cargar curso + estado de share + papelera. NULL = sesión no existe.
  SELECT course_id, COALESCE(whiteboard_shared, false), deleted_at
  INTO v_course_id, v_shared, v_deleted_at
  FROM public.attendance_sessions
  WHERE id = _session_id;
  IF v_course_id IS NULL THEN
    RAISE EXCEPTION 'Sesión no encontrada' USING ERRCODE = 'P0001';
  END IF;
  -- Papelera: una sesión borrada no se edita por nadie.
  IF v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'La sesión está en la papelera' USING ERRCODE = 'P0001';
  END IF;
  -- Docente / Admin / SuperAdmin: bypass directo.
  v_is_teacher := EXISTS (
    SELECT 1 FROM public.course_teachers
    WHERE course_id = v_course_id AND user_id = auth.uid()
  ) OR public.has_role(auth.uid(), 'Admin'::public.app_role)
    OR public.is_super_admin();
  IF NOT v_is_teacher THEN
    -- Alumno: solo si shared=true Y matriculado en el curso.
    IF NOT v_shared THEN
      RAISE EXCEPTION 'La pizarra no está compartida' USING ERRCODE = 'P0001';
    END IF;
    v_is_enrolled := EXISTS (
      SELECT 1 FROM public.course_enrollments
      WHERE course_id = v_course_id AND user_id = auth.uid()
    );
    IF NOT v_is_enrolled THEN
      RAISE EXCEPTION 'No estás matriculado en este curso' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  -- Pasada la validación, escribimos. NO tocamos updated_at — el trigger
  -- existente lo maneja si está configurado para esa tabla.
  UPDATE public.attendance_sessions
  SET whiteboard_scene = _scene
  WHERE id = _session_id;
END;
$function$;

NOTIFY pgrst, 'reload schema';
