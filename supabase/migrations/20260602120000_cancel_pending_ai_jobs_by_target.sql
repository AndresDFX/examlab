-- ──────────────────────────────────────────────────────────────────────
-- RPC: cancel_pending_ai_jobs_for_submission
--
-- Cuando el alumno reabre una entrega ya enviada pero AÚN sin calificar
-- (para corregir antes del feedback), hay un riesgo de race: el worker
-- IA puede estar procesando la versión vieja y, cuando termine, escribir
-- `ai_grade` sobre la fila — bloqueando re-submits y dejando una nota
-- desconectada de las respuestas actuales.
--
-- Esta función deja al alumno (o al staff) cancelar los jobs IA
-- pendientes apuntando a su submission. SECURITY DEFINER porque RLS de
-- `ai_grading_queue` no le da UPDATE al estudiante. La autorización se
-- verifica acá: solo cancela jobs cuya submission pertenezca al caller,
-- o si es Admin/SuperAdmin/Docente del curso.
--
-- Aplica a `submissions` (exámenes). Para workshops/projects el patrón
-- de re-submit ya overwrite el resultado IA (la fila persiste con nuevo
-- answers), así que el race tiene menor impacto. Si lo necesitamos
-- después, generalizamos el helper aceptando (_target_table, _target_id).
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cancel_pending_ai_jobs_for_submission(_submission_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller UUID := auth.uid();
  _owner UUID;
  _course UUID;
  _cancelled INT := 0;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT s.user_id, e.course_id
    INTO _owner, _course
    FROM public.submissions s
    JOIN public.exams e ON e.id = s.exam_id
   WHERE s.id = _submission_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Submission no encontrada';
  END IF;

  -- Autorización: el dueño, Admin, SuperAdmin o un docente del curso.
  IF NOT (
    _owner = _caller
    OR public.has_role(_caller, 'Admin'::public.app_role)
    OR public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = _course AND ct.user_id = _caller
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para cancelar jobs de esta entrega';
  END IF;

  -- Solo pending/processing — done/failed/cancelled/rejected no se tocan.
  WITH affected AS (
    UPDATE public.ai_grading_queue
       SET status = 'cancelled',
           completed_at = now(),
           last_error = 'Cancelado: alumno reabrió la entrega para editar antes de re-entregar'
     WHERE target_table = 'submissions'
       AND target_row_id = _submission_id
       AND status IN ('pending', 'processing')
    RETURNING 1
  )
  SELECT COUNT(*) INTO _cancelled FROM affected;

  RETURN _cancelled;
END
$$;

REVOKE ALL ON FUNCTION public.cancel_pending_ai_jobs_for_submission(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_pending_ai_jobs_for_submission(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
