-- ──────────────────────────────────────────────────────────────────────
-- project_files.zip_single — scaffolding del flujo "ZIP único"
--
-- El slot `codigo_zip` nació como entrega de un único .zip; después
-- evolucionó a múltiples archivos sueltos (project_submission_files.
-- code_paths). Esta migración agrega un toggle por slot para volver al
-- modo "ZIP único" — el estudiante sube UN .zip, el edge function lo
-- descomprime y la IA califica todos los archivos en un solo prompt
-- sin minificar contenido (el flag `noMinify` del edge se activa con
-- esta bandera).
--
-- Default false → comportamiento actual (multi-file) sigue para todos
-- los slots existentes. El docente activa el toggle por slot cuando
-- quiere probar el flujo ZIP en su proyecto.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.project_files
  ADD COLUMN IF NOT EXISTS zip_single BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.project_files.zip_single IS
  'true → el slot acepta UN único .zip (descomprimido server-side, calificado sin minificar). false → flujo multi-file (default). Solo aplica a type=codigo_zip.';
