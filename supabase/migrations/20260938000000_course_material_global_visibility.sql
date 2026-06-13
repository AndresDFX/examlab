-- ──────────────────────────────────────────────────────────────────────
-- Material GENERAL del curso visible para estudiantes matriculados.
--
-- Antes: el estudiante solo podía leer `generated_contents` (y descargar
-- sus archivos del bucket `generated-contents`) si una SESIÓN apuntaba al
-- contenido (`attendance_sessions.content_id`) — policies
-- `generated_contents_student_via_session` y `gc_student_read_via_session`.
-- El material subido desde el Tablero del docente como "general del curso"
-- (fila en `content_course_assignments`, sin sesión) quedaba INVISIBLE por
-- RLS aunque existiera — bug reportado: "lo subido queda global y no se ve
-- desde la zona de cursos de los estudiantes".
--
-- Ahora: contenido PUBLICADO (`status='done' AND is_published=true AND
-- deleted_at IS NULL`) con fila en `content_course_assignments` hacia un
-- curso es legible (fila + Storage) por los matriculados de ese curso.
--
-- El ancla es content_course_assignments (intención EXPLÍCITA de compartir
-- con el curso), NO `generated_contents.course_id` a secas — un contenido
-- anclado por course_id sin asignación sigue siendo privado del docente
-- hasta que lo asigne (a una sesión o al curso). El upload del Tablero
-- escribe la fila cca siempre (board-content-upload.ts).
-- ──────────────────────────────────────────────────────────────────────

DO $migration$
BEGIN
  IF to_regclass('public.generated_contents') IS NULL
     OR to_regclass('public.content_course_assignments') IS NULL THEN
    RAISE NOTICE 'Skipping: generated_contents o content_course_assignments no existen todavía.';
    RETURN;
  END IF;

  -- Lectura de la FILA del contenido para matriculados (material general).
  EXECUTE 'DROP POLICY IF EXISTS generated_contents_student_via_course ON public.generated_contents';
  EXECUTE $sql$
    CREATE POLICY generated_contents_student_via_course ON public.generated_contents
      FOR SELECT TO authenticated
      USING (
        status = 'done'
        AND is_published = true
        AND deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM public.content_course_assignments cca
          JOIN public.course_enrollments ce ON ce.course_id = cca.course_id
          WHERE cca.content_id = generated_contents.id
            AND ce.user_id = auth.uid()
        )
      )
  $sql$;

  -- Descarga de los ARCHIVOS del contenido. El path del bucket es
  -- `<teacher_id>/<content_id>/<archivo>` → folder[2] = content_id (mismo
  -- patrón que gc_student_read_via_session).
  EXECUTE 'DROP POLICY IF EXISTS gc_student_read_via_course ON storage.objects';
  EXECUTE $sql$
    CREATE POLICY gc_student_read_via_course ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'generated-contents'
        AND EXISTS (
          SELECT 1
          FROM public.generated_contents gc
          JOIN public.content_course_assignments cca ON cca.content_id = gc.id
          JOIN public.course_enrollments ce ON ce.course_id = cca.course_id
          WHERE gc.id::text = (storage.foldername(name))[2]
            AND gc.status = 'done'
            AND gc.is_published = true
            AND gc.deleted_at IS NULL
            AND ce.user_id = auth.uid()
        )
      )
  $sql$;
END
$migration$;
