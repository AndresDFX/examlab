-- ──────────────────────────────────────────────────────────────────────
-- Snippets de código de sesión COMPARTIDOS con los alumnos (opt-in).
--
-- Antes: cualquier alumno matriculado veía TODOS los snippets de código de
-- la sesión apenas el docente los guardaba (la RLS de session_code_snippets
-- permitía SELECT a matriculados sin gate).
--
-- Ahora: igual que la pizarra (whiteboard_shared, mig 20260815000000), el
-- alumno solo ve el código cuando el docente activa el flag
-- `attendance_sessions.code_shared`. El docente lo togglea desde el Tablero.
--
-- Permisos:
--   - Docente del curso / Admin / SuperAdmin: siempre ven y editan.
--   - Alumno matriculado: SELECT solo si code_shared = true.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.attendance_sessions') IS NULL THEN
    RAISE NOTICE 'public.attendance_sessions no existe — abortando migración code_shared';
    RETURN;
  END IF;

  -- 1) Flag (default false → compatible con datos existentes; los snippets
  --    ya guardados quedan ocultos a los alumnos hasta que el docente comparta).
  ALTER TABLE public.attendance_sessions
    ADD COLUMN IF NOT EXISTS code_shared BOOLEAN NOT NULL DEFAULT false;

  COMMENT ON COLUMN public.attendance_sessions.code_shared IS
    'Cuando true, los alumnos matriculados pueden VER los snippets de código de la sesión (session_code_snippets). Default false — el docente lo activa desde el Tablero, igual que whiteboard_shared para la pizarra.';
END $$;

-- 2) RLS de session_code_snippets: el branch de ALUMNO ahora exige
--    code_shared=true. Docente/Admin/SA sin cambios (siempre ven).
DO $$
BEGIN
  IF to_regclass('public.session_code_snippets') IS NULL THEN
    RAISE NOTICE 'session_code_snippets no existe — se omite el gate de RLS';
    RETURN;
  END IF;

  DROP POLICY IF EXISTS session_code_snippets_select ON public.session_code_snippets;
  CREATE POLICY session_code_snippets_select
    ON public.session_code_snippets FOR SELECT TO authenticated
    USING (
      EXISTS (
        SELECT 1 FROM public.attendance_sessions s
        WHERE s.id = session_code_snippets.session_id
          AND (
            public.has_role(auth.uid(), 'Admin'::public.app_role)
            OR public.is_super_admin()
            OR EXISTS (
              SELECT 1 FROM public.course_teachers ct
              WHERE ct.course_id = s.course_id AND ct.user_id = auth.uid()
            )
            OR (
              COALESCE(s.code_shared, false) = true
              AND EXISTS (
                SELECT 1 FROM public.course_enrollments ce
                WHERE ce.course_id = s.course_id AND ce.user_id = auth.uid()
              )
            )
          )
      )
    );
END $$;

-- 3) RPC para que el docente togglee el flag (solo docente/Admin/SA).
--    Espejo de set_session_whiteboard_shared.
DROP FUNCTION IF EXISTS public.set_session_code_shared(UUID, BOOLEAN);
CREATE OR REPLACE FUNCTION public.set_session_code_shared(
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
  SET code_shared = _shared
  WHERE id = _session_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_session_code_shared(UUID, BOOLEAN) TO authenticated;

NOTIFY pgrst, 'reload schema';
