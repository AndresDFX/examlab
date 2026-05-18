-- ──────────────────────────────────────────────────────────────────────
-- RPCs para contar gradings fallidos con IA por entidad padre.
-- Alimentan la columna "Errores IA" en los grids principales:
--   - Exámenes  → submissions.answers->__breakdown[].ai_error
--   - Talleres  → workshop_submission_answers.ai_feedback ~* 'error\s*ia'
--   - Proyectos → project_submission_files.ai_feedback ~* 'error\s*ia'
--
-- También usados por el dashboard del docente/admin para mostrar el
-- card "Errores llamada IA (última hora)".
-- ──────────────────────────────────────────────────────────────────────

-- ── Counts por examen ──
CREATE OR REPLACE FUNCTION public.count_ai_errors_per_exam()
RETURNS TABLE (exam_id UUID, error_count BIGINT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.exam_id,
    COUNT(*)::bigint AS error_count
  FROM public.submissions s
  WHERE s.submitted_at IS NOT NULL
    AND jsonb_path_exists(s.answers, '$."__breakdown"[*]."ai_error"')
  GROUP BY s.exam_id;
$$;

REVOKE ALL ON FUNCTION public.count_ai_errors_per_exam() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_ai_errors_per_exam() TO authenticated;

-- ── Counts por taller ──
-- Un taller cuenta una vez por cada entrega con AL MENOS un answer
-- cuyo ai_feedback indique error de IA.
CREATE OR REPLACE FUNCTION public.count_ai_errors_per_workshop()
RETURNS TABLE (workshop_id UUID, error_count BIGINT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ws.workshop_id,
    COUNT(DISTINCT ws.id)::bigint AS error_count
  FROM public.workshop_submissions ws
  JOIN public.workshop_submission_answers wsa ON wsa.submission_id = ws.id
  WHERE wsa.ai_feedback ~* 'error\s*ia|internal error: code execution|el modelo no'
  GROUP BY ws.workshop_id;
$$;

REVOKE ALL ON FUNCTION public.count_ai_errors_per_workshop() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_ai_errors_per_workshop() TO authenticated;

-- ── Counts por proyecto ──
CREATE OR REPLACE FUNCTION public.count_ai_errors_per_project()
RETURNS TABLE (project_id UUID, error_count BIGINT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ps.project_id,
    COUNT(DISTINCT ps.id)::bigint AS error_count
  FROM public.project_submissions ps
  JOIN public.project_submission_files psf ON psf.submission_id = ps.id
  WHERE psf.ai_feedback ~* 'error\s*ia|internal error: code execution|el modelo no'
  GROUP BY ps.project_id;
$$;

REVOKE ALL ON FUNCTION public.count_ai_errors_per_project() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_ai_errors_per_project() TO authenticated;

-- ── Contador global de errores de IA en la última hora ──
-- Lee audit_logs filtrando por action = 'ai.grading_failed'. Usado por
-- el dashboard del docente (card "Errores llamada IA — última hora")
-- y el admin (panel de uso de IA).
--
-- Param `_actor_id`: si NULL, cuenta TODOS los errores (caso admin);
-- si pasa un user_id, cuenta solo los que ese usuario disparó (docente
-- ve solo los suyos).
CREATE OR REPLACE FUNCTION public.count_ai_errors_last_hour(_actor_id UUID DEFAULT NULL)
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::bigint
  FROM public.audit_logs
  WHERE action = 'ai.grading_failed'
    AND created_at >= now() - interval '1 hour'
    AND (_actor_id IS NULL OR actor_id = _actor_id);
$$;

REVOKE ALL ON FUNCTION public.count_ai_errors_last_hour(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_ai_errors_last_hour(UUID) TO authenticated;

-- ── Ejecuciones recientes de IA en última hora (para el dashboard admin) ──
-- Lista las llamadas a IA con su action, severidad y actor. Limit
-- configurable (default 20). Para el card "Ejecuciones IA recientes".
CREATE OR REPLACE FUNCTION public.list_recent_ai_executions(_limit INTEGER DEFAULT 20)
RETURNS TABLE (
  id UUID,
  action TEXT,
  severity TEXT,
  actor_email TEXT,
  actor_id UUID,
  entity_type TEXT,
  entity_id UUID,
  created_at TIMESTAMPTZ,
  metadata JSONB
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    al.id,
    al.action,
    al.severity,
    al.actor_email,
    al.actor_id,
    al.entity_type,
    al.entity_id,
    al.created_at,
    al.metadata
  FROM public.audit_logs al
  WHERE al.action IN (
    'ai.grading_started',
    'ai.grading_failed',
    'ai_grading.completed',
    'ai_questions.generated',
    'ai_plagiarism.detected',
    'ai.grading_retry_run',
    'ai.questions_generation_failed'
  )
    AND al.created_at >= now() - interval '1 hour'
  ORDER BY al.created_at DESC
  LIMIT GREATEST(1, LEAST(_limit, 200));
$$;

REVOKE ALL ON FUNCTION public.list_recent_ai_executions(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_recent_ai_executions(INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
