-- ══════════════════════════════════════════════════════════════════════
-- Auditoría papelera (pase 8, cierre) — config de notas legible al alumno de un
-- CURSO en papelera.
--
-- Las 3 policies de lectura ESTUDIANTIL de la estructura de notas
-- (course_grading_config, grade_cuts, grade_cut_items) gatean por matrícula pero
-- NO por `courses.deleted_at`. Con un curso en papelera (sin cascade), un alumno
-- matriculado lee por REST la config de evaluación + cortes + pesos del curso
-- borrado. Bajo-medio valor (los pesos no son secretos), pero la regla universal
-- exige que el contenido de un curso en papelera no sea legible por no-staff.
--
-- Fix: añadir `AND NOT public._course_in_papelera(<course_id>)` a la rama
-- estudiantil. El staff lee/gestiona la config por sus PROPIAS policies (no se
-- tocan), así que conserva acceso para la Papelera/restore.
-- ══════════════════════════════════════════════════════════════════════

ALTER POLICY cgc_student_read ON public.course_grading_config
  USING (
    EXISTS (
      SELECT 1 FROM public.course_enrollments ce
      WHERE ce.course_id = course_grading_config.course_id AND ce.user_id = auth.uid()
    )
    AND NOT public._course_in_papelera(course_grading_config.course_id)
  );

ALTER POLICY cuts_student_read ON public.grade_cuts
  USING (
    EXISTS (
      SELECT 1 FROM public.course_enrollments ce
      WHERE ce.course_id = grade_cuts.course_id AND ce.user_id = auth.uid()
    )
    AND NOT public._course_in_papelera(grade_cuts.course_id)
  );

ALTER POLICY cut_items_student_read ON public.grade_cut_items
  USING (
    EXISTS (
      SELECT 1 FROM public.grade_cuts gc
      JOIN public.course_enrollments ce ON ce.course_id = gc.course_id
      WHERE gc.id = grade_cut_items.cut_id
        AND ce.user_id = auth.uid()
        AND NOT public._course_in_papelera(gc.course_id)
    )
  );

NOTIFY pgrst, 'reload schema';
