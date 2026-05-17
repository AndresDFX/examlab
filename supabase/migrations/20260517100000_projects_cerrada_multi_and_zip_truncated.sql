-- ──────────────────────────────────────────────────────────────────────
-- 1) Permitir tipo 'cerrada_multi' en project_files.type
--    Refleja el cambio que ya se aplica a exam_questions y workshop_questions
--    (UI permite seleccionar opción múltiple). Storage en options:
--      { choices: string[], correct_indices: number[],
--        min_selections?, max_selections? }
--
-- 2) Marcar cuando un ZIP fue truncado al calificarse con IA
--    Si el código completo del estudiante excede MAX_CHARS (~200K), la
--    edge function concatena solo lo que cabe y trunca el resto. Sin un
--    flag, el docente no se entera y puede confiar en una calificación
--    incompleta. Agregamos zip_truncated (bool) en project_submission_files.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.project_files
  DROP CONSTRAINT IF EXISTS project_files_type_check;

ALTER TABLE public.project_files
  ADD CONSTRAINT project_files_type_check
  CHECK (type IN ('abierta','cerrada','cerrada_multi','codigo','diagrama','java_gui','codigo_zip'));

ALTER TABLE public.project_submission_files
  ADD COLUMN IF NOT EXISTS zip_truncated BOOLEAN NOT NULL DEFAULT FALSE;

-- Conservamos también el tamaño original analizado para diagnóstico
ALTER TABLE public.project_submission_files
  ADD COLUMN IF NOT EXISTS zip_chars_used INTEGER;

COMMENT ON COLUMN public.project_submission_files.zip_truncated IS
  'TRUE cuando el ZIP excedió MAX_CHARS y la IA solo analizó parte del código fuente.';

COMMENT ON COLUMN public.project_submission_files.zip_chars_used IS
  'Cantidad de caracteres del código que sí entraron al prompt de la IA. NULL si no aplica.';

NOTIFY pgrst, 'reload schema';
