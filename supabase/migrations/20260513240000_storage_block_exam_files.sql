-- ──────────────────────────────────────────────────────────────────────
-- Storage RLS — extender el bloqueo de "archivos solo docente" para
-- incluir el nuevo tag `examen`. Hoy ya bloqueamos GUIA_DOCENTE_* y
-- SOLUCION_* (ver migración 20260513170000); ahora también EXAMEN_*.
--
-- Defensa en profundidad: el filtro client-side de `filesForSession`
-- (src/lib/contents-extract.ts → `isTeacherOnlyFile`) oculta el chip
-- en la UI, pero sin esta policy un estudiante curioso podría adivinar
-- la URL directa `<teacher>/<content>/EXAMEN_CLASE_3.md` y bajarlo.
-- ──────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS gc_student_read_via_session ON storage.objects;
CREATE POLICY gc_student_read_via_session ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'generated-contents'
    AND EXISTS (
      SELECT 1
      FROM public.attendance_sessions s
      JOIN public.course_enrollments ce ON ce.course_id = s.course_id
      WHERE ce.user_id = auth.uid()
        AND s.content_id::text = (storage.foldername(name))[2]
    )
    -- Bloqueamos los 3 tipos de archivo "solo docente":
    --   1. guia[_ -]docente / teacher[_ -]guide
    --   2. solucion / solution
    --   3. examen / exam (tag nuevo `examen`)
    AND name !~* '(guia[_\s-]*docente|teacher[_\s-]*guide|solucion|solution|examen|\\bexam\\b)'
  );
