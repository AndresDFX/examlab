-- Per-question AI signals for workshops, matching the granularity that
-- the exam monitor already exposes through `submissions.answers.__breakdown`.
--
-- Without this column, the per-question "integrity suggestion" card in
-- the workshop grading dialog would have to fall back to the
-- submission-level `workshop_submissions.ai_detected_score`, which is
-- identical for every question of the same submission. With it, the
-- AI grading edge function (which already returns `ai_likelihood` per
-- answer) can persist the value directly and the UI can suggest a
-- penalized grade PER question.
--
-- ai_reasons fits the same shape we use for exams (free-text or short
-- JSON-as-text) so the existing card components can render it without
-- shape adaptation.

ALTER TABLE public.workshop_submission_answers
  ADD COLUMN IF NOT EXISTS ai_likelihood numeric(4, 3),
  ADD COLUMN IF NOT EXISTS ai_reasons text;

COMMENT ON COLUMN public.workshop_submission_answers.ai_likelihood IS
  'Probabilidad estimada (0..1) de que la respuesta haya sido generada por IA. Lo persiste el edge function ai-grade-submission cuando recalifica una pregunta. Umbral de alerta: 0.6 (alineado con el flag submission-level).';
COMMENT ON COLUMN public.workshop_submission_answers.ai_reasons IS
  'Razones cortas que dio la IA al estimar `ai_likelihood`. Texto libre.';

NOTIFY pgrst, 'reload schema';
