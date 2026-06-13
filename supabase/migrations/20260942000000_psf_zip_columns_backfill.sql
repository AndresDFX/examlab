-- ──────────────────────────────────────────────────────────────────────
-- Backfill: columnas zip_truncated / zip_chars_used en project_submission_files
-- (y su gemela en workshop_submission_files).
--
-- Bug en prod: el diálogo "Entregas y calificación" del proyecto NO mostraba
-- lo que entregó el estudiante. Causa: el cliente hace
--   SELECT ..., zip_truncated, zip_chars_used FROM project_submission_files
-- pero esas columnas NO existían en prod → el query fallaba entero (42703
-- "column ... does not exist") y la lista de respuestas quedaba vacía,
-- silenciosamente. Las entregas SÍ están en la DB (verificado).
--
-- Por qué faltaban: la migración original 20260517100000 las agregaba, pero
-- ANTES corría `ALTER TABLE project_files ADD CONSTRAINT ...` SIN
-- `IF NOT EXISTS`; si la constraint ya existía, esa migración abortaba antes
-- de los ADD COLUMN (y Lovable la pudo marcar como aplicada igual). Resultado:
-- columnas nunca creadas. Esta migración las agrega de forma idempotente y
-- aislada, con guard `to_regclass` (CLAUDE.md).
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.project_submission_files') IS NOT NULL THEN
    ALTER TABLE public.project_submission_files
      ADD COLUMN IF NOT EXISTS zip_truncated BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE public.project_submission_files
      ADD COLUMN IF NOT EXISTS zip_chars_used INTEGER;
  END IF;

  -- Misma pareja en workshop_submission_files (la añadía 20260607010000;
  -- mismo riesgo de no haber corrido). Defensivo: solo si la tabla existe.
  IF to_regclass('public.workshop_submission_files') IS NOT NULL THEN
    ALTER TABLE public.workshop_submission_files
      ADD COLUMN IF NOT EXISTS zip_truncated BOOLEAN;
    ALTER TABLE public.workshop_submission_files
      ADD COLUMN IF NOT EXISTS zip_chars_used INTEGER;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
