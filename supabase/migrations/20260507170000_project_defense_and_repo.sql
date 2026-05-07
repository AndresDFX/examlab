-- ============================================================
-- Sustentación + link obligatorio en entregas de proyectos.
--
-- Modelo nuevo:
--   - submission_grade: nota de la entrega (IA + ajustes manuales del
--     docente sobre los archivos). Antes vivía implícitamente en
--     final_grade.
--   - defense_factor:   0..1. Lo captura el docente después de la
--     sustentación. NULL = aún no se ha sustentado.
--   - final_grade:      AHORA es el resultado ponderado:
--                       submission_grade × defense_factor.
--                       NULL mientras defense_factor sea NULL.
--   - defense_notes / defense_at: notas y timestamp de la sustentación.
--   - repository_url:   link a GitHub o Drive con el código fuente,
--                       OBLIGATORIO al entregar. Permite al docente
--                       verificar fechas de modificación contra la
--                       fecha de entrega.
--
-- Backfill: para entregas ya calificadas (final_grade != null) ANTES
-- de esta migración, copiamos final_grade → submission_grade y
-- ponemos defense_factor=1 para preservar el comportamiento (asume
-- que ya se "sustentaron al 100%" implícitamente). Para entregas en
-- progreso, todo queda en NULL.
--
-- repository_url se deja NULLABLE en DB (constraint solo en cliente
-- para no romper entregas históricas).
-- ============================================================

ALTER TABLE public.project_submissions
  ADD COLUMN IF NOT EXISTS submission_grade NUMERIC,
  ADD COLUMN IF NOT EXISTS defense_factor NUMERIC
    CHECK (defense_factor IS NULL OR (defense_factor >= 0 AND defense_factor <= 1)),
  ADD COLUMN IF NOT EXISTS defense_notes TEXT,
  ADD COLUMN IF NOT EXISTS defense_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS repository_url TEXT;

-- Backfill conservador: entregas ya calificadas → submission_grade
-- = final_grade y defense_factor = 1 para que la nota final no cambie.
UPDATE public.project_submissions
SET submission_grade = final_grade,
    defense_factor = 1
WHERE final_grade IS NOT NULL AND submission_grade IS NULL;
