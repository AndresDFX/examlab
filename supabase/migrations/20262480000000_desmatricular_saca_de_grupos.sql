-- ═══════════════════════════════════════════════════════════════════════
-- Desmatricular también saca al estudiante de los GRUPOS del curso.
--
-- La mig 20260958000000 ya limpiaba, al quitar a alguien de un curso, sus
-- asignaciones y sus entregas sin calificar. Le faltaba un vínculo, y no es
-- cosmético: la PERTENENCIA AL GRUPO. La entrega de un taller en grupo es UNA
-- sola y su nota es del GRUPO, así que alguien que ya no cursa la materia
-- seguía apareciendo en el editor de grupos, dentro de la entrega compartida y
-- en la lista por la que se reparte esa nota — pesando sobre la calificación
-- de sus excompañeros.
--
-- Se conservan las tres salvaguardas del original, que son las que hacen que
-- esto sea seguro:
--   · NO se borran entregas ya calificadas: son historial de notas.
--   · NO se borran entregas de GRUPO: son compartidas y el grupo continúa.
--   · Talleres y proyectos son M:N con los cursos, así que solo se limpia si la
--     actividad no vive también en otro curso donde el estudiante sigue
--     matriculado. Sin esa condición, salir de un curso lo expulsaría de un
--     taller que comparte con otro que sí está cursando.
--
-- El vocero NO necesita limpieza: vive en columnas de la propia fila de
-- `course_enrollments`, así que se va con el DELETE.
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

  -- ── GRUPOS de taller y de proyecto ──
  -- Lo que faltaba. No es cosmético: la entrega de un taller en grupo es UNA
  -- sola y su nota es del GRUPO, así que alguien que ya no cursa la materia
  -- seguía apareciendo en el editor de grupos, dentro de la entrega compartida
  -- y en la lista por la que se reparte esa nota. Mismo cuidado M:N que
  -- arriba: si la actividad vive también en otro curso donde sigue
  -- matriculado, no se toca.
  DELETE FROM public.workshop_group_members wgm
   USING public.workshop_groups wg, public.workshop_courses wc
   WHERE wgm.group_id = wg.id
     AND wg.workshop_id = wc.workshop_id
     AND wc.course_id = _cid
     AND wgm.user_id = _uid
     AND NOT EXISTS (
       SELECT 1 FROM public.workshop_courses wc2
        JOIN public.course_enrollments ce2 ON ce2.course_id = wc2.course_id
       WHERE wc2.workshop_id = wg.workshop_id AND ce2.user_id = _uid
     );

  DELETE FROM public.project_group_members pgm
   USING public.project_groups pg, public.project_courses pc
   WHERE pgm.group_id = pg.id
     AND pg.project_id = pc.project_id
     AND pc.course_id = _cid
     AND pgm.user_id = _uid
     AND NOT EXISTS (
       SELECT 1 FROM public.project_courses pc2
        JOIN public.course_enrollments ce2 ON ce2.course_id = pc2.course_id
       WHERE pc2.project_id = pg.project_id AND ce2.user_id = _uid
     );

  RETURN OLD;
END
$$;


DROP TRIGGER IF EXISTS trg_cleanup_unenrolled_student ON public.course_enrollments;
CREATE TRIGGER trg_cleanup_unenrolled_student
  AFTER DELETE ON public.course_enrollments
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_cleanup_unenrolled_student();
