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
-- Una sesión apunta a UN contenido a la vez (1:1 desde el lado de la
-- sesión, 1:N desde el lado del contenido — un curso_completo de 8
-- clases puede ocupar 8 sesiones distintas). El docente puede limpiar
-- la asignación poniendo content_id=NULL.

ALTER TABLE public.attendance_sessions
  ADD COLUMN IF NOT EXISTS content_id UUID REFERENCES public.generated_contents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS content_class_index INT;

-- content_class_index sólo tiene sentido si content_id está poblado,
-- y debe ser >= 1 cuando existe. NULL/NULL = sesión sin contenido.
ALTER TABLE public.attendance_sessions
  DROP CONSTRAINT IF EXISTS attendance_sessions_content_index_check;
ALTER TABLE public.attendance_sessions
  ADD CONSTRAINT attendance_sessions_content_index_check CHECK (
    content_id IS NOT NULL OR content_class_index IS NULL
  );
ALTER TABLE public.attendance_sessions
  DROP CONSTRAINT IF EXISTS attendance_sessions_content_index_positive;
ALTER TABLE public.attendance_sessions
  ADD CONSTRAINT attendance_sessions_content_index_positive CHECK (
    content_class_index IS NULL OR content_class_index >= 1
  );

-- Índice para "todas las sesiones que tienen este contenido asignado"
-- — lo usaremos en el tablero del estudiante y al limpiar reasignar.
CREATE INDEX IF NOT EXISTS attendance_sessions_content_idx
  ON public.attendance_sessions(content_id)
  WHERE content_id IS NOT NULL;

-- RLS: las sesiones ya son legibles por estudiantes matriculados al
-- curso (políticas existentes). Como `generated_contents` tiene RLS
-- estricta (teacher_id = auth.uid()), el estudiante NO puede leer la
-- fila completa del contenido — pero SÍ necesita leer los archivos
-- almacenados. Para ello, abrimos una política de Storage adicional:
-- si el archivo está en `<teacher_id>/<content_id>/<filename>` Y el
-- estudiante está matriculado al curso de una sesión que apunta a ese
-- content_id, puede leerlo.

DROP POLICY IF EXISTS gc_student_read_via_session ON storage.objects;
CREATE POLICY gc_student_read_via_session ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'generated-contents'
    AND EXISTS (
      SELECT 1
      FROM public.attendance_sessions s
      JOIN public.course_enrollments ce ON ce.course_id = s.course_id
      -- El path es '<teacher_id>/<content_id>/<filename>'.
      -- Tomamos el segmento [2] (content_id) y lo cruzamos con la
      -- sesión que tenga ese content_id asignado y donde el alumno
      -- esté matriculado.
      WHERE ce.user_id = auth.uid()
        AND s.content_id::text = (storage.foldername(name))[2]
    )
  );

-- También necesitamos que el estudiante pueda LEER la fila del
-- contenido (para conocer files[].name/path/kind/body) cuando esa
-- fila está enlazada a una sesión de un curso al que pertenece.
-- Política aditiva: SELECT en generated_contents para alumnos cuya
-- matrícula incluye un curso con sesión apuntando a ese content_id.

DROP POLICY IF EXISTS generated_contents_student_via_session ON public.generated_contents;
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
  );
