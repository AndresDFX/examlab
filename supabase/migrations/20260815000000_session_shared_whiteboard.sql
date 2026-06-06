-- ──────────────────────────────────────────────────────────────────────
-- Pizarra de sesión compartida con los alumnos.
--
-- Antes: `attendance_sessions.whiteboard_scene` solo el docente la edita.
-- Si el alumno entra a la sesión, no podía ver ni mucho menos pintar.
--
-- Ahora: un flag `whiteboard_shared BOOLEAN` que cuando es TRUE permite
-- a los alumnos matriculados ver Y EDITAR la pizarra de la sesión. La
-- sincronización en vivo se hace client-side via Supabase Realtime
-- broadcast (canal `wb_session:<id>`) — esta migración solo se ocupa
-- de los permisos.
--
-- Permisos:
--   - Docente del curso: siempre puede leer y escribir.
--   - Alumno matriculado: ya podía LEER (RLS existente de
--     attendance_sessions). Para que pueda ESCRIBIR la columna
--     `whiteboard_scene`, expone-mos una RPC `update_session_whiteboard_scene`
--     SECURITY DEFINER que valida `whiteboard_shared=true` + matrícula
--     antes de hacer el UPDATE. El cliente la invoca SIEMPRE (docente
--     y alumno) — un solo path, sin condicionales en el front.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.attendance_sessions') IS NULL THEN
    RAISE NOTICE 'public.attendance_sessions no existe — abortando migración shared whiteboard';
    RETURN;
  END IF;

  -- 1) Columna flag — default false (compatible con datos existentes).
  ALTER TABLE public.attendance_sessions
    ADD COLUMN IF NOT EXISTS whiteboard_shared BOOLEAN NOT NULL DEFAULT false;

  COMMENT ON COLUMN public.attendance_sessions.whiteboard_shared IS
    'Cuando true, los alumnos matriculados pueden EDITAR la pizarra de la sesión (no solo verla). Sincronización en vivo via Supabase Realtime broadcast en el canal wb_session:<id>. Default false.';
END $$;

-- 2) RPC: actualiza whiteboard_scene validando permisos en server-side.
-- Se invoca tanto desde el docente (siempre permitido) como desde el
-- alumno (permitido solo si whiteboard_shared=true).
--
-- SECURITY DEFINER + SET search_path para evitar shadowing. El auth.uid()
-- dentro de una RPC SECURITY DEFINER usa el JWT del CALLER (no del owner),
-- así que sigue identificando al usuario real.
DROP FUNCTION IF EXISTS public.update_session_whiteboard_scene(UUID, JSONB);
CREATE OR REPLACE FUNCTION public.update_session_whiteboard_scene(
  _session_id UUID,
  _scene JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_course_id UUID;
  v_shared BOOLEAN;
  v_is_teacher BOOLEAN;
  v_is_enrolled BOOLEAN;
BEGIN
  -- Cargar curso + estado de share. NULL = sesión no existe.
  SELECT course_id, COALESCE(whiteboard_shared, false)
  INTO v_course_id, v_shared
  FROM public.attendance_sessions
  WHERE id = _session_id;

  IF v_course_id IS NULL THEN
    RAISE EXCEPTION 'Sesión no encontrada' USING ERRCODE = 'P0001';
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
$$;

GRANT EXECUTE ON FUNCTION public.update_session_whiteboard_scene(UUID, JSONB) TO authenticated;

COMMENT ON FUNCTION public.update_session_whiteboard_scene IS
  'Actualiza el scene_json de una pizarra de sesión. Permitido al docente del curso y, si attendance_sessions.whiteboard_shared=true, también a los alumnos matriculados. El cliente invoca esta RPC en lugar de UPDATE directo para que el server enforce el flag.';

-- 3) RPC para que el docente toggle el shared flag. Separada para mantener
-- la validación de "solo el docente puede cambiar el modo" — sin ella, un
-- alumno podría DELETE/INSERT con UPDATE generic si la policy lo dejara.
DROP FUNCTION IF EXISTS public.set_session_whiteboard_shared(UUID, BOOLEAN);
CREATE OR REPLACE FUNCTION public.set_session_whiteboard_shared(
  _session_id UUID,
  _shared BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_course_id UUID;
  v_authorized BOOLEAN;
BEGIN
  SELECT course_id INTO v_course_id
  FROM public.attendance_sessions
  WHERE id = _session_id;

  IF v_course_id IS NULL THEN
    RAISE EXCEPTION 'Sesión no encontrada' USING ERRCODE = 'P0001';
  END IF;

  v_authorized := EXISTS (
    SELECT 1 FROM public.course_teachers
    WHERE course_id = v_course_id AND user_id = auth.uid()
  ) OR public.has_role(auth.uid(), 'Admin'::public.app_role)
    OR public.is_super_admin();

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.attendance_sessions
  SET whiteboard_shared = _shared
  WHERE id = _session_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_session_whiteboard_shared(UUID, BOOLEAN) TO authenticated;

NOTIFY pgrst, 'reload schema';
