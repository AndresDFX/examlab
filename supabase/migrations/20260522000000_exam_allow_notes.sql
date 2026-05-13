-- ──────────────────────────────────────────────────────────────────────
-- exams.allow_exam_notes — toggle por examen
--
-- Hasta ahora cualquier examen aceptaba "notas de apoyo" (chuletas) que
-- el estudiante sube y el docente aprueba/rechaza. El docente quiere
-- decidir por examen si esa funcionalidad está activa.
--
-- Default TRUE porque:
--   1. El comportamiento histórico es "todos permiten notas".
--   2. Backfill implícito vía DEFAULT al agregar la columna — los
--      exámenes existentes quedan con `true` sin tener que hacer
--      UPDATE explícito.
--
-- Cuando es FALSE:
--   - El componente `<StudentExamNotes>` se oculta en la vista del
--     estudiante (lógica del cliente).
--   - El tab "Notas de apoyo" del editor docente muestra un aviso
--     "Desactivado para este examen" en lugar de la lista.
--   - Las notas YA EXISTENTES en `exam_notes` no se borran — quedan
--     visibles como histórico si el docente vuelve a activar.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.exams
  ADD COLUMN IF NOT EXISTS allow_exam_notes BOOLEAN NOT NULL DEFAULT TRUE;

NOTIFY pgrst, 'reload schema';
