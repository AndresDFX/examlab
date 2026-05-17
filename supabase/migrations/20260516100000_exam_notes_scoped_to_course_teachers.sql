-- ============================================================
-- Tighten exam_notes RLS: restringir aprobación a docentes del CURSO del examen.
--
-- Antes: cualquier docente del sistema podía aprobar/rechazar notas de apoyo
-- (defense-in-depth débil). La UI ya filtraba por curso, pero un atacante
-- con rol Docente podía bypasear vía API directa.
--
-- Ahora: SELECT/UPDATE solo si auth.uid() está en course_teachers del curso
-- del examen relacionado, o es Admin, o es el dueño de la nota.
-- ============================================================

DROP POLICY IF EXISTS exam_notes_select ON public.exam_notes;
DROP POLICY IF EXISTS exam_notes_update ON public.exam_notes;

CREATE POLICY exam_notes_select
  ON public.exam_notes
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
    OR EXISTS (
      SELECT 1
      FROM public.exams e
      JOIN public.course_teachers ct ON ct.course_id = e.course_id
      WHERE e.id = exam_notes.exam_id
        AND ct.user_id = auth.uid()
    )
  );

CREATE POLICY exam_notes_update
  ON public.exam_notes
  FOR UPDATE
  TO authenticated
  USING (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
    OR EXISTS (
      SELECT 1
      FROM public.exams e
      JOIN public.course_teachers ct ON ct.course_id = e.course_id
      WHERE e.id = exam_notes.exam_id
        AND ct.user_id = auth.uid()
    )
  )
  WITH CHECK (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
    OR EXISTS (
      SELECT 1
      FROM public.exams e
      JOIN public.course_teachers ct ON ct.course_id = e.course_id
      WHERE e.id = exam_notes.exam_id
        AND ct.user_id = auth.uid()
    )
  );
