-- ──────────────────────────────────────────────────────────────────────
-- Reemplazo del flujo "subir un ZIP" por "seleccionar varios archivos".
--
-- Motivación: la validación de contenido del ZIP era frágil — pasaban
-- archivos no permitidos en subcarpetas porque el navegador no los
-- inspecciona antes de subir, y el edge function gastaba tiempo y
-- bandwidth descomprimiendo entregas inválidas. Con multi-file:
--
--   1) El navegador valida extensión por archivo ANTES de subir → 0 gasto
--      cuando el estudiante elige archivos equivocados.
--   2) Cada archivo va a Storage como objeto individual (sin descompresión
--      del lado servidor).
--   3) El edge function recibe el array de paths, descarga cada uno,
--      minifica y concatena en un solo prompt para calificar el proyecto
--      como conjunto (idéntico al comportamiento previo).
--
-- Esquema:
--   - Nueva columna `code_paths text[]` con los paths de cada archivo
--     subido. Cuando esté poblada, el frontend y el edge function la
--     prefieren sobre `zip_path`.
--   - `zip_path` se conserva para no romper entregas legacy ya calificadas
--     con el flujo viejo (el detalle del estudiante todavía sabe pintar
--     el botón "Descargar ZIP" cuando solo existe esa columna).
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.project_submission_files
  ADD COLUMN IF NOT EXISTS code_paths text[];

COMMENT ON COLUMN public.project_submission_files.code_paths IS
  'Paths de los archivos de código subidos para una pregunta tipo `codigo_zip` (nombre legacy — ya no son ZIP). Cuando está poblado, sustituye a zip_path. Formato: <user_id|group_id>/<submission_id>/<question_id>/<filename>.';

NOTIFY pgrst, 'reload schema';
