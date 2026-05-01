-- Allow multiple submission attempts per (exam, user)
ALTER TABLE public.submissions DROP CONSTRAINT IF EXISTS submissions_exam_id_user_id_key;

-- Ensure only one in-progress attempt at a time per (exam, user) so the
-- existing "find in-progress submission" lookups stay deterministic.
CREATE UNIQUE INDEX IF NOT EXISTS submissions_one_in_progress_per_user
  ON public.submissions (exam_id, user_id)
  WHERE status = 'en_progreso';