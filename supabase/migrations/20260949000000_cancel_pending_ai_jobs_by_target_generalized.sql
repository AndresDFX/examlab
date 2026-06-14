-- ═══════════════════════════════════════════════════════════════════════
-- RPC genérica: cancel_pending_ai_jobs_by_target(_target_table, _target_row_id)
--
-- Objetivo: cuando un docente CALIFICA/gestiona MANUALMENTE una entrega, los
-- jobs de IA pendientes/processing para ESA MISMA entrega deben quitarse de la
-- cola — ya no tiene sentido que la IA la procese (gastaría cupo y podría
-- pisar el estado mostrado). Antes solo existía
-- `cancel_pending_ai_jobs_for_submission` (solo exámenes) y NO se llamaba
-- desde los flujos de calificación manual de taller/proyecto → quedaban jobs
-- huérfanos en la cola.
--
-- Esta versión generaliza a las 3 entregas y EXPANDE a sus hijos:
--   - submissions            (examen)        → + nada (las preguntas viven en JSONB)
--   - workshop_submissions   (taller)        → + workshop_submission_answers de esa entrega
--   - project_submissions    (proyecto)      → + project_submission_files de esa entrega
-- Así, calificar el taller/proyecto completo cancela también los jobs
-- per-pregunta / per-archivo encolados de esa entrega.
--
-- SECURITY DEFINER (la RLS de ai_grading_queue no da UPDATE al alumno). La
-- autorización se valida acá: dueño de la entrega, docente del curso,
-- SuperAdmin, o Admin DEL MISMO TENANT (scope para no permitir cancelar
-- cross-tenant — has_role('Admin') es global).
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.cancel_pending_ai_jobs_by_target(
  _target_table  TEXT,
  _target_row_id UUID,
  _reason        TEXT DEFAULT NULL
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller    UUID := auth.uid();
  _owner     UUID;
  _course    UUID;
  _tenant    UUID;
  _cancelled INT := 0;
  _msg       TEXT := COALESCE(_reason, 'Cancelado: la entrega se calificó/gestionó manualmente.');
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF _target_table NOT IN ('submissions', 'workshop_submissions', 'project_submissions') THEN
    RAISE EXCEPTION 'Tabla destino no soportada para cancelación: %', _target_table;
  END IF;

  -- Resolver dueño + curso según el tipo de entrega.
  IF _target_table = 'submissions' THEN
    SELECT s.user_id, e.course_id INTO _owner, _course
      FROM public.submissions s
      JOIN public.exams e ON e.id = s.exam_id
     WHERE s.id = _target_row_id;
  ELSIF _target_table = 'workshop_submissions' THEN
    SELECT ws.user_id, w.course_id INTO _owner, _course
      FROM public.workshop_submissions ws
      JOIN public.workshops w ON w.id = ws.workshop_id
     WHERE ws.id = _target_row_id;
  ELSE -- project_submissions
    SELECT ps.user_id, p.course_id INTO _owner, _course
      FROM public.project_submissions ps
      JOIN public.projects p ON p.id = ps.project_id
     WHERE ps.id = _target_row_id;
  END IF;

  IF _course IS NULL THEN
    -- Entrega inexistente: no es error fatal (puede haberse borrado). 0 cancelados.
    RETURN 0;
  END IF;

  SELECT tenant_id INTO _tenant FROM public.courses WHERE id = _course;

  -- Autorización: dueño, docente del curso, SuperAdmin, o Admin del tenant.
  IF NOT (
    _owner = _caller
    OR public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.course_teachers ct
       WHERE ct.course_id = _course AND ct.user_id = _caller
    )
    OR (public.has_role(_caller, 'Admin'::public.app_role) AND _tenant = public.current_tenant_id())
  ) THEN
    RAISE EXCEPTION 'No autorizado para cancelar jobs de esta entrega';
  END IF;

  -- Cancelar solo pending/processing (done/failed/cancelled/rejected no se tocan),
  -- del target directo + sus hijos (answers/files de esa entrega).
  WITH affected AS (
    UPDATE public.ai_grading_queue q
       SET status = 'cancelled',
           completed_at = now(),
           last_error = _msg
     WHERE q.status IN ('pending', 'processing')
       AND (
         (q.target_table = _target_table AND q.target_row_id = _target_row_id)
         OR (
           _target_table = 'workshop_submissions'
           AND q.target_table = 'workshop_submission_answers'
           AND q.target_row_id IN (
             SELECT a.id FROM public.workshop_submission_answers a
              WHERE a.submission_id = _target_row_id
           )
         )
         OR (
           _target_table = 'project_submissions'
           AND q.target_table = 'project_submission_files'
           AND q.target_row_id IN (
             SELECT f.id FROM public.project_submission_files f
              WHERE f.submission_id = _target_row_id
           )
         )
       )
    RETURNING 1
  )
  SELECT COUNT(*) INTO _cancelled FROM affected;

  RETURN _cancelled;
END
$$;

REVOKE ALL ON FUNCTION public.cancel_pending_ai_jobs_by_target(TEXT, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_pending_ai_jobs_by_target(TEXT, UUID, TEXT) TO authenticated;

-- Back-compat: el flujo de "alumno reabre su entrega de examen" ya llamaba
-- `cancel_pending_ai_jobs_for_submission`. Lo reescribimos como wrapper de la
-- genérica para tener UNA sola implementación (misma autorización: el dueño
-- pasa por la rama `_owner = _caller`).
CREATE OR REPLACE FUNCTION public.cancel_pending_ai_jobs_for_submission(_submission_id UUID)
RETURNS INT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.cancel_pending_ai_jobs_by_target(
    'submissions',
    _submission_id,
    'Cancelado: alumno reabrió la entrega para editar antes de re-entregar'
  );
$$;

REVOKE ALL ON FUNCTION public.cancel_pending_ai_jobs_for_submission(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_pending_ai_jobs_for_submission(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
