-- ──────────────────────────────────────────────────────────────────────
-- workshop_submission_answers.ai_review_at / ai_review_by
--
-- En exámenes existe `submissions.answers.__breakdown[i].ai_review_at`
-- para que el docente marque una sospecha de IA por PREGUNTA como
-- "revisada" (ya la inspeccioné, decidí si penaliza o no). Talleres no
-- tenían el equivalente — solo `workshop_submissions.ai_review_at` que
-- es a nivel submission entero, no útil cuando hay varias preguntas.
--
-- Esta migración alinea talleres con exámenes a nivel de granularidad.
-- Reglas:
--   - NULL = pendiente de revisar
--   - timestamp = revisada en ese momento
--   - `ai_review_by` registra al docente que la marcó (no obligatorio
--     para el flujo — útil para auditoría)
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.workshop_submission_answers
  ADD COLUMN IF NOT EXISTS ai_review_at TIMESTAMPTZ;

ALTER TABLE public.workshop_submission_answers
  ADD COLUMN IF NOT EXISTS ai_review_by UUID REFERENCES auth.users(id);

NOTIFY pgrst, 'reload schema';
