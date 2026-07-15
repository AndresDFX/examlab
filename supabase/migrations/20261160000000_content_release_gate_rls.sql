-- Gate server-side de `release_after_session_date` (antes solo en el cliente).
--
-- Un contenido con release_after_session_date=true NO debe ser legible por el
-- estudiante hasta que llegue la fecha de la sesión que lo referencia. El board
-- lo ocultaba SOLO en JS (filesForSession), así que un alumno podía leer la fila
-- de generated_contents (con files[] + body inline) por REST directo antes de la
-- fecha. Lo movemos a la RLS: ambas policies de SELECT del estudiante suman el
-- gate de liberación.
--
-- "Liberado" = NO tiene el flag, O existe una sesión (en un curso donde el
-- alumno está matriculado) que referencia el contenido con session_date <= hoy
-- (America/Bogota, 00:00 → cuenta todo el día de clase, igual que el JS).
-- Impacto verificado en prod: 0 contenidos usan el flag hoy → hardening a futuro.

CREATE OR REPLACE FUNCTION public.content_released_for_student(_content_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT
    NOT COALESCE(
      (SELECT gc.release_after_session_date FROM public.generated_contents gc WHERE gc.id = _content_id),
      false
    )
    OR EXISTS (
      SELECT 1
      FROM public.attendance_sessions s
      JOIN public.course_enrollments ce ON ce.course_id = s.course_id
      WHERE s.content_id = _content_id
        AND ce.user_id = auth.uid()
        AND s.deleted_at IS NULL
        AND s.session_date IS NOT NULL
        AND s.session_date <= (now() AT TIME ZONE 'America/Bogota')::date
    );
$$;

DO $$
BEGIN
  IF to_regclass('public.generated_contents') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'generated_contents'
      AND policyname = 'generated_contents_student_via_course'
  ) THEN
    ALTER POLICY generated_contents_student_via_course ON public.generated_contents
      USING (
        (status = 'done'::content_status) AND (is_published = true) AND (deleted_at IS NULL)
        AND (EXISTS (
          SELECT 1
          FROM (content_course_assignments cca
            JOIN course_enrollments ce ON ((ce.course_id = cca.course_id)))
          WHERE ((cca.content_id = generated_contents.id) AND (ce.user_id = auth.uid()))
        ))
        AND public.content_released_for_student(generated_contents.id)
      );
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'generated_contents'
      AND policyname = 'generated_contents_student_via_session'
  ) THEN
    ALTER POLICY generated_contents_student_via_session ON public.generated_contents
      USING (
        (deleted_at IS NULL)
        AND (EXISTS (
          SELECT 1
          FROM (attendance_sessions s
            JOIN course_enrollments ce ON ((ce.course_id = s.course_id)))
          WHERE ((s.content_id = generated_contents.id) AND (ce.user_id = auth.uid()) AND (s.deleted_at IS NULL))
        ))
        AND public.content_released_for_student(generated_contents.id)
      );
  END IF;
END $$;
