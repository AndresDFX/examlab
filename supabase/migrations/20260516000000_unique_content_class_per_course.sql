-- Una clase específica de un contenido (content_id + content_class_index)
-- solo puede estar asignada a UNA sesion del curso. Razon: si el docente
-- asigna por error "Clase 3 del contenido X" a dos sesiones distintas, los
-- archivos / fechas se confunden en la vista del estudiante.
--
-- Aplica solo cuando ambos campos estan poblados:
--   - content_id NULL          → sesion sin contenido (permitido)
--   - content_class_index NULL → modo material_individual (todo el
--                                contenido junto, sin clases internas).
--                                Permitimos que el mismo content_id
--                                aparezca en varias sesiones porque el
--                                docente puede querer trabajar el mismo
--                                material en varias clases consecutivas.
--
-- Antes de crear el indice unique, limpiamos duplicados existentes:
-- para cada combinacion (course_id, content_id, content_class_index)
-- mantenemos la sesion con session_date mas reciente y a las anteriores
-- les quitamos la asignacion de contenido (no borramos la sesion).

-- 1) Detectar duplicados y quitarles la asignacion a las "perdedoras".
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY course_id, content_id, content_class_index
      ORDER BY session_date DESC, id ASC
    ) AS rn
  FROM public.attendance_sessions
  WHERE content_id IS NOT NULL
    AND content_class_index IS NOT NULL
)
UPDATE public.attendance_sessions
SET content_id = NULL,
    content_class_index = NULL
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 2) Indice unico parcial. Garantiza que esto no vuelva a pasar.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_sessions_unique_content_class
  ON public.attendance_sessions (course_id, content_id, content_class_index)
  WHERE content_id IS NOT NULL AND content_class_index IS NOT NULL;

NOTIFY pgrst, 'reload schema';
