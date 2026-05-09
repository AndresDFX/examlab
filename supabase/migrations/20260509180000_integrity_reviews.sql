-- =============================================================
-- Integridad académica: marcado de "Revisada" por par/submission.
--
-- Hasta ahora el docente solo veía alertas (IA o copia) en
-- FraudPanel/Monitor sin forma de "cerrarlas". Cada vez que se
-- volvía a ejecutar `detect-plagiarism` o se re-calificaba con IA,
-- las mismas alertas reaparecían sin importar que el docente ya las
-- hubiera revisado.
--
-- Modelo:
--   - similarity_pairs: agrega `reviewed_at` y `reviewed_by`. El edge
--     `detect-plagiarism` solo borra los NO revisados antes de
--     re-insertar; los revisados sobreviven indefinidamente.
--   - submissions / workshop_submissions / project_submissions:
--     agregan `ai_review_at` y `ai_review_by`. Cuando esos campos
--     están poblados, la sospecha IA queda "marcada como revisada"
--     y la UI deja de mostrar al estudiante como sospechoso por IA.
--
-- Estado derivado del estudiante (calculado en cliente):
--   - "sospechoso" si tiene similarity_pairs con reviewed_at IS NULL
--     y score >= 0.6, o ai_detected_score >= 0.6 con ai_review_at IS NULL.
--   - "Chequeado" si todas las alertas están revisadas (no quedan
--     pares pendientes ni IA pendiente).
-- =============================================================

-- 1) ----------------------------------------- similarity_pairs
ALTER TABLE public.similarity_pairs
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_notes text;

CREATE INDEX IF NOT EXISTS idx_similarity_pairs_reviewed
  ON public.similarity_pairs(reviewed_at)
  WHERE reviewed_at IS NULL;

-- RLS: la tabla ya tiene SELECT abierto a docentes/admin (de
-- migraciones previas). Agregamos UPDATE solo de las columnas de
-- revisión para docentes/admin del curso del par.
DROP POLICY IF EXISTS "similarity_pairs_review_update" ON public.similarity_pairs;
CREATE POLICY "similarity_pairs_review_update" ON public.similarity_pairs
  FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR public.has_role(auth.uid(), 'Docente')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'Admin')
    OR public.has_role(auth.uid(), 'Docente')
  );

-- 2) ---------------------------------------------- submissions (exam)
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS ai_review_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_review_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- 3) ----------------------------------- workshop_submissions
ALTER TABLE public.workshop_submissions
  ADD COLUMN IF NOT EXISTS ai_review_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_review_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- 4) ------------------------------------ project_submissions
ALTER TABLE public.project_submissions
  ADD COLUMN IF NOT EXISTS ai_review_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_review_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- 5) -------------------------------- RPC: marcar par como revisado
-- El docente desde la UI llama esta RPC en lugar de un UPDATE directo,
-- para que reviewed_by quede con auth.uid() forzado y no se pueda
-- falsear desde el cliente.
CREATE OR REPLACE FUNCTION public.mark_similarity_pair_reviewed(
  p_pair_id uuid,
  p_unmark  boolean DEFAULT false,
  p_notes   text    DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'Admin') OR public.has_role(auth.uid(), 'Docente')) THEN
    RAISE EXCEPTION 'Solo docentes/admins pueden marcar pares como revisados';
  END IF;

  IF p_unmark THEN
    UPDATE public.similarity_pairs
       SET reviewed_at = NULL,
           reviewed_by = NULL,
           review_notes = NULL
     WHERE id = p_pair_id;
  ELSE
    UPDATE public.similarity_pairs
       SET reviewed_at = COALESCE(reviewed_at, now()),
           reviewed_by = COALESCE(reviewed_by, auth.uid()),
           review_notes = COALESCE(p_notes, review_notes)
     WHERE id = p_pair_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_similarity_pair_reviewed(uuid, boolean, text)
  TO authenticated;

-- 6) --------------------- RPC: marcar sospecha IA como revisada
-- Recibe el `kind` para escribir en la tabla correcta. Mismo patrón:
-- reviewed_by se fuerza a auth.uid() y solo aplica a docentes/admin.
CREATE OR REPLACE FUNCTION public.mark_ai_suspicion_reviewed(
  p_kind          text,    -- 'exam' | 'workshop' | 'project'
  p_submission_id uuid,
  p_unmark        boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'Admin') OR public.has_role(auth.uid(), 'Docente')) THEN
    RAISE EXCEPTION 'Solo docentes/admins pueden marcar sospechas como revisadas';
  END IF;

  IF p_kind = 'exam' THEN
    IF p_unmark THEN
      UPDATE public.submissions
         SET ai_review_at = NULL, ai_review_by = NULL
       WHERE id = p_submission_id;
    ELSE
      UPDATE public.submissions
         SET ai_review_at = COALESCE(ai_review_at, now()),
             ai_review_by = COALESCE(ai_review_by, auth.uid())
       WHERE id = p_submission_id;
    END IF;
  ELSIF p_kind = 'workshop' THEN
    IF p_unmark THEN
      UPDATE public.workshop_submissions
         SET ai_review_at = NULL, ai_review_by = NULL
       WHERE id = p_submission_id;
    ELSE
      UPDATE public.workshop_submissions
         SET ai_review_at = COALESCE(ai_review_at, now()),
             ai_review_by = COALESCE(ai_review_by, auth.uid())
       WHERE id = p_submission_id;
    END IF;
  ELSIF p_kind = 'project' THEN
    IF p_unmark THEN
      UPDATE public.project_submissions
         SET ai_review_at = NULL, ai_review_by = NULL
       WHERE id = p_submission_id;
    ELSE
      UPDATE public.project_submissions
         SET ai_review_at = COALESCE(ai_review_at, now()),
             ai_review_by = COALESCE(ai_review_by, auth.uid())
       WHERE id = p_submission_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'kind invalido: %', p_kind;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_ai_suspicion_reviewed(text, uuid, boolean)
  TO authenticated;
