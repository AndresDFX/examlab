-- ══════════════════════════════════════════════════════════════════════
-- Auditoría papelera (pase de confirmación) — RLS leak en generated_contents.
--
-- La policy SELECT `generated_contents_student_via_session` deja a un alumno
-- MATRICULADO leer una fila de generated_contents si una attendance_session
-- apunta a ese content_id — SIN filtrar `deleted_at` ni en el contenido ni en
-- la sesión. Por REST directo (id stale), un alumno podía leer título + files[]
-- (incl. body inline de código/notebooks/md) de un contenido EN PAPELERA o cuya
-- sesión está en papelera. La UI (app.student.courses) sí filtra, la RLS no.
--
-- La policy hermana `generated_contents_student_via_course` SÍ incluye
-- `deleted_at IS NULL` — esto era una inconsistencia, no diseño. Se recrea la
-- policy igualando ese patrón: contenido NO en papelera Y sesión NO en papelera.
--
-- (Nota: la policy de Storage gemela `gc_student_read_via_session` YA NO existe
-- en prod — fue reemplazada por `gc_student_read_via_course`, que ya filtra
-- deleted_at; los binarios de un contenido en papelera NO son descargables por
-- el alumno. Verificado en pg_policies. No requiere fix.)
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.generated_contents') IS NOT NULL THEN
    DROP POLICY IF EXISTS generated_contents_student_via_session ON public.generated_contents;
    CREATE POLICY generated_contents_student_via_session
      ON public.generated_contents
      FOR SELECT
      TO authenticated
      USING (
        deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM public.attendance_sessions s
          JOIN public.course_enrollments ce ON ce.course_id = s.course_id
          WHERE s.content_id = generated_contents.id
            AND ce.user_id = auth.uid()
            AND s.deleted_at IS NULL
        )
      );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
