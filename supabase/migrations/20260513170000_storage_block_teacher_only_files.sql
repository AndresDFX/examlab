-- ──────────────────────────────────────────────────────────────────────
-- Storage RLS — bloquear acceso de estudiantes a archivos de uso
-- exclusivo del docente. Hoy `gc_student_read_via_session` (creada en
-- 20260509220000) permite a cualquier matriculado leer TODOS los
-- archivos del folder del contenido. Eso es un leak: el estudiante
-- puede adivinar/forzar la URL del `GUIA_DOCENTE_*.md` o
-- `EJERCICIO_SOLUCION_*.md` y descargarlo aunque la UI lo oculte.
--
-- Defensa en profundidad: además del filtro client-side (en
-- `filesForSession`), reforzamos la policy para excluir esos patrones
-- del SELECT del estudiante. El docente sigue con acceso completo via
-- otra policy (`gc_teacher_full_access` o similar).
--
-- Patrones bloqueados (case-insensitive, match en el nombre completo
-- del objeto):
--   - GUIA_DOCENTE / GUIA DOCENTE / TEACHER_GUIDE
--   - SOLUCION / SOLUTION
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
    -- Bloquea archivos de uso exclusivo docente (defensa en profundidad
    -- frente al filtro client-side de `filesForSession`).
    AND name !~* '(guia[_\s-]*docente|teacher[_\s-]*guide|solucion|solution)'
  );
