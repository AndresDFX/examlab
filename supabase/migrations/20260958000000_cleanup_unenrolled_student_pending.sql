-- ═══════════════════════════════════════════════════════════════════════
-- Al desasociar/eliminar a un estudiante de un curso, quitar sus PENDIENTES
-- de calificar (en todos los roles y superficies: dashboards, diagnóstico,
-- diálogos de calificación).
--
-- Problema: al quitar a un estudiante de un curso (DELETE en
-- course_enrollments — directo o por cascada al borrar el perfil) sus
-- asignaciones y entregas quedaban. El diagnóstico ya los excluye (itera
-- sobre matriculados), pero los conteos "Por calificar" de los dashboards y
-- los diálogos de calificación seguían contándolos.
--
-- Fix: trigger AFTER DELETE en course_enrollments que limpia, para ese
-- (user, course):
--   - *_assignments de las actividades del curso.
--   - entregas SIN calificar e INDIVIDUALES (group_id IS NULL) de esas
--     actividades.
-- SEGURIDAD (no destruir lo que importa):
--   - NO borra entregas YA calificadas (preserva historial de notas).
--   - NO borra entregas de GRUPO (son compartidas; el grupo sigue).
--   - Talleres/proyectos son M:N con cursos → solo limpia si la actividad NO
--     está en OTRO curso donde el estudiante sigue matriculado.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_cleanup_unenrolled_student()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := OLD.user_id;
  _cid UUID := OLD.course_id;
BEGIN
  IF _uid IS NULL OR _cid IS NULL THEN
    RETURN OLD;
  END IF;

  -- ── EXÁMENES (course_id directo) ──
  DELETE FROM public.exam_assignments ea
   USING public.exams e
   WHERE ea.exam_id = e.id AND e.course_id = _cid AND ea.user_id = _uid;

  DELETE FROM public.submissions s
   USING public.exams e
   WHERE s.exam_id = e.id AND e.course_id = _cid AND s.user_id = _uid
     AND s.ai_grade IS NULL AND s.final_override_grade IS NULL;

  -- ── TALLERES (M:N vía workshop_courses) ──
  -- Solo si el taller NO está en otro curso donde el user sigue matriculado.
  DELETE FROM public.workshop_assignments wa
   USING public.workshop_courses wc
   WHERE wa.workshop_id = wc.workshop_id AND wc.course_id = _cid AND wa.user_id = _uid
     AND NOT EXISTS (
       SELECT 1 FROM public.workshop_courses wc2
        JOIN public.course_enrollments ce2 ON ce2.course_id = wc2.course_id
       WHERE wc2.workshop_id = wa.workshop_id AND ce2.user_id = _uid
     );

  DELETE FROM public.workshop_submissions ws
   USING public.workshop_courses wc
   WHERE ws.workshop_id = wc.workshop_id AND wc.course_id = _cid AND ws.user_id = _uid
     AND ws.group_id IS NULL
     AND ws.final_grade IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.workshop_courses wc2
        JOIN public.course_enrollments ce2 ON ce2.course_id = wc2.course_id
       WHERE wc2.workshop_id = ws.workshop_id AND ce2.user_id = _uid
     );

  -- ── PROYECTOS (M:N vía project_courses) ──
  DELETE FROM public.project_assignments pa
   USING public.project_courses pc
   WHERE pa.project_id = pc.project_id AND pc.course_id = _cid AND pa.user_id = _uid
     AND NOT EXISTS (
       SELECT 1 FROM public.project_courses pc2
        JOIN public.course_enrollments ce2 ON ce2.course_id = pc2.course_id
       WHERE pc2.project_id = pa.project_id AND ce2.user_id = _uid
     );

  DELETE FROM public.project_submissions ps
   USING public.project_courses pc
   WHERE ps.project_id = pc.project_id AND pc.course_id = _cid AND ps.user_id = _uid
     AND ps.group_id IS NULL
     AND ps.final_grade IS NULL
     AND ps.submission_grade IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.project_courses pc2
        JOIN public.course_enrollments ce2 ON ce2.course_id = pc2.course_id
       WHERE pc2.project_id = ps.project_id AND ce2.user_id = _uid
     );

  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS trg_cleanup_unenrolled_student ON public.course_enrollments;
CREATE TRIGGER trg_cleanup_unenrolled_student
  AFTER DELETE ON public.course_enrollments
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_cleanup_unenrolled_student();

-- ── Backfill: limpiar pendientes de estudiantes YA desasociados ──
-- Borra entregas SIN calificar e INDIVIDUALES cuyo dueño NO está matriculado
-- en NINGÚN curso al que pertenece la actividad. Cubre Camacho + histórico.
DO $$
BEGIN
  IF to_regclass('public.submissions') IS NOT NULL THEN
    -- Exámenes: el examen pertenece a UN curso (course_id directo).
    DELETE FROM public.submissions s
     USING public.exams e
     WHERE s.exam_id = e.id
       AND s.ai_grade IS NULL AND s.final_override_grade IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.course_enrollments ce
          WHERE ce.course_id = e.course_id AND ce.user_id = s.user_id
       );
  END IF;

  IF to_regclass('public.workshop_submissions') IS NOT NULL THEN
    DELETE FROM public.workshop_submissions ws
     WHERE ws.group_id IS NULL AND ws.final_grade IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.workshop_courses wc
          JOIN public.course_enrollments ce ON ce.course_id = wc.course_id
         WHERE wc.workshop_id = ws.workshop_id AND ce.user_id = ws.user_id
       );
  END IF;

  IF to_regclass('public.project_submissions') IS NOT NULL THEN
    DELETE FROM public.project_submissions ps
     WHERE ps.group_id IS NULL AND ps.final_grade IS NULL AND ps.submission_grade IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.project_courses pc
          JOIN public.course_enrollments ce ON ce.course_id = pc.course_id
         WHERE pc.project_id = ps.project_id AND ce.user_id = ps.user_id
       );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
