-- ──────────────────────────────────────────────────────────────────────
-- Asignación de contenido a sesión: SUBCONJUNTO de archivos opcional.
--
-- Hasta ahora una sesión se ligaba a (content_id, content_class_index):
--   - curso_completo → content_class_index selecciona la CLASE (un grupo de
--     archivos por sufijo _CLASE_<N>).
--   - material_individual → content_class_index NULL → se mostraban TODOS
--     los archivos del contenido, sin posibilidad de elegir.
--
-- Esta columna permite afinar QUÉ archivos del contenido/clase se muestran
-- en la sesión. NULL = todos (comportamiento actual, backward-compat). Un
-- array de paths = solo esos archivos (subconjunto elegido por el docente).
-- La vista del estudiante (filesForSession) filtra por estos paths cuando
-- el array no es NULL.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.attendance_sessions') IS NOT NULL THEN
    ALTER TABLE public.attendance_sessions
      ADD COLUMN IF NOT EXISTS content_file_paths TEXT[];

    COMMENT ON COLUMN public.attendance_sessions.content_file_paths IS
      'Subconjunto opcional de paths de archivos del contenido asignado a mostrar en la sesión. NULL = todos los archivos del contenido/clase.';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
