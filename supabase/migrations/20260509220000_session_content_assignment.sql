-- Asocia un GeneratedContent (módulo Contenidos) a cada sesión de
-- asistencia (módulo Asistencia). Permite armar el "tablero del curso"
-- estilo Moodle para el estudiante: cada sesión con fecha + título +
-- descarga del material que el docente generó.
--
-- Diseño de la relación:
--   attendance_sessions.content_id           → FK a generated_contents
--   attendance_sessions.content_class_index  → 1-indexed; cuando el
--     content es 'curso_completo' (varios CLASE_N), indica QUÉ clase
--     del contenido aplica a esta sesión. Para 'material_individual'
--     queda NULL (todo el contenido aplica).
--
-- ── Guard de orden ──
-- Toda la migración vive dentro de un DO block que primero verifica
-- la existencia de `public.generated_contents` (creada en 20260509190000_
-- contents_module.sql). Si todavía no existe — porque Lovable aplicó
-- las migraciones fuera de orden o esta corre standalone — emitimos
-- NOTICE y salimos sin error. Esto evita el bloqueo:
--   ERROR: relation "public.generated_contents" does not exist
-- y deja al usuario re-publicar tras aplicar 190000.

DO $migration$
DECLARE
  has_gc boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'generated_contents'
  ) INTO has_gc;

  IF NOT has_gc THEN
    RAISE NOTICE
      'Skipping 20260509220000: public.generated_contents no existe. ' ||
      'Aplica primero 20260509190000_contents_module.sql y vuelve a publicar.';
    RETURN;
  END IF;

  -- ── Columnas en attendance_sessions ──
  EXECUTE $sql$
    ALTER TABLE public.attendance_sessions
      ADD COLUMN IF NOT EXISTS content_id UUID
        REFERENCES public.generated_contents(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS content_class_index INT
  $sql$;

  -- content_class_index sólo tiene sentido si content_id está poblado,
  -- y debe ser >= 1 cuando existe. NULL/NULL = sesión sin contenido.
  EXECUTE 'ALTER TABLE public.attendance_sessions
           DROP CONSTRAINT IF EXISTS attendance_sessions_content_index_check';
  EXECUTE 'ALTER TABLE public.attendance_sessions
           ADD CONSTRAINT attendance_sessions_content_index_check CHECK (
             content_id IS NOT NULL OR content_class_index IS NULL
           )';
  EXECUTE 'ALTER TABLE public.attendance_sessions
           DROP CONSTRAINT IF EXISTS attendance_sessions_content_index_positive';
  EXECUTE 'ALTER TABLE public.attendance_sessions
           ADD CONSTRAINT attendance_sessions_content_index_positive CHECK (
             content_class_index IS NULL OR content_class_index >= 1
           )';

  -- Índice para "todas las sesiones que tienen este contenido asignado".
  EXECUTE 'CREATE INDEX IF NOT EXISTS attendance_sessions_content_idx
           ON public.attendance_sessions(content_id)
           WHERE content_id IS NOT NULL';

  -- ── RLS: Storage para descarga de archivos por estudiantes ──
  -- Si el archivo está en `<teacher_id>/<content_id>/<filename>` Y el
  -- estudiante está matriculado al curso de una sesión que apunta a
  -- ese content_id, puede leerlo.
  EXECUTE 'DROP POLICY IF EXISTS gc_student_read_via_session ON storage.objects';
  EXECUTE $sql$
    CREATE POLICY gc_student_read_via_session ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'generated-contents'
        AND EXISTS (
          SELECT 1
          FROM public.attendance_sessions s
          JOIN public.course_enrollments ce ON ce.course_id = s.course_id
          WHERE ce.user_id = auth.uid()
            AND s.content_id::text = (storage.foldername(name))[2]
        )
      )
  $sql$;

  -- ── RLS: SELECT en generated_contents para alumnos vía sesión ──
  -- Necesario para que el cliente del estudiante lea files[].name/path/kind.
  EXECUTE 'DROP POLICY IF EXISTS generated_contents_student_via_session ON public.generated_contents';
  EXECUTE $sql$
    CREATE POLICY generated_contents_student_via_session ON public.generated_contents
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.attendance_sessions s
          JOIN public.course_enrollments ce ON ce.course_id = s.course_id
          WHERE s.content_id = generated_contents.id
            AND ce.user_id = auth.uid()
        )
      )
  $sql$;
END
$migration$;
