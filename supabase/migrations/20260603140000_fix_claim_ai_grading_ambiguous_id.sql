-- ──────────────────────────────────────────────────────────────────────
-- FIX: "column reference id is ambiguous" en claim_one/claim_pending_ai_grading
--
-- Ambas funciones declaran `RETURNS TABLE (id UUID, ...)`. En Postgres
-- eso crea parámetros OUT — y los OUT params quedan como VARIABLES
-- plpgsql en scope dentro del cuerpo. La subconsulta:
--
--     WHERE q.id IN (SELECT id FROM picked)
--                           ^^^ sin calificar
--
-- deja a Postgres con dos candidatos para `id`: la variable OUT `id`
-- y la columna `picked.id`. Con `plpgsql.variable_conflict = error`
-- (default) eso lanza "column reference \"id\" is ambiguous" al PLANEAR
-- la query — es decir, en runtime, la primera vez que se ejecuta.
--
-- Impacto: el worker `ai-grading-worker` llama a estas funciones para
-- reclamar jobs. Con el bug, NUNCA podía reclamar ninguno → la cola
-- async quedó inerte (los jobs se quedaban `pending` para siempre) y
-- el botón "Procesar este job ahora" fallaba con ese error.
--
-- Fix: calificar la referencia → `SELECT picked.id FROM picked`.
-- La firma (RETURNS TABLE) NO cambia, así que `CREATE OR REPLACE`
-- basta — no hace falta DROP.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.claim_one_ai_grading(_job_id UUID)
RETURNS TABLE (
  id UUID,
  kind TEXT,
  invoke_target TEXT,
  body JSONB,
  target_table TEXT,
  target_row_id UUID,
  field_grade TEXT,
  field_feedback TEXT,
  field_likelihood TEXT,
  field_reasons TEXT,
  attempts INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT q.id
    FROM public.ai_grading_queue q
    WHERE q.id = _job_id AND q.status = 'pending'
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.ai_grading_queue q
     SET status = 'processing',
         started_at = now(),
         attempts = q.attempts + 1
   WHERE q.id IN (SELECT picked.id FROM picked)
   RETURNING q.id, q.kind, q.invoke_target, q.body, q.target_table, q.target_row_id,
             q.field_grade, q.field_feedback, q.field_likelihood, q.field_reasons,
             q.attempts;
END
$$;

CREATE OR REPLACE FUNCTION public.claim_pending_ai_grading(_limit INT DEFAULT 10)
RETURNS TABLE (
  id UUID,
  kind TEXT,
  invoke_target TEXT,
  body JSONB,
  target_table TEXT,
  target_row_id UUID,
  field_grade TEXT,
  field_feedback TEXT,
  field_likelihood TEXT,
  field_reasons TEXT,
  attempts INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT q.id
    FROM public.ai_grading_queue q
    WHERE q.status = 'pending'
    ORDER BY q.created_at ASC
    LIMIT _limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.ai_grading_queue q
     SET status = 'processing',
         started_at = now(),
         attempts = q.attempts + 1
   WHERE q.id IN (SELECT picked.id FROM picked)
   RETURNING q.id, q.kind, q.invoke_target, q.body, q.target_table, q.target_row_id,
             q.field_grade, q.field_feedback, q.field_likelihood, q.field_reasons,
             q.attempts;
END
$$;

REVOKE ALL ON FUNCTION public.claim_one_ai_grading(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_pending_ai_grading(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_one_ai_grading(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_pending_ai_grading(INT) TO service_role;

NOTIFY pgrst, 'reload schema';
