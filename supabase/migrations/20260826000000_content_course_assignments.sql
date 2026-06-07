-- ──────────────────────────────────────────────────────────────────────
-- Junction N-N: contenidos ↔ cursos.
--
-- Hasta hoy, `generated_contents.course_id` era FK 1-1: un contenido vive
-- en UN curso (el "ancla"). El flujo nuevo de "subir contenido externo
-- y asociarlo a N cursos" necesita una junction:
--
--   content_course_assignments(content_id, course_id, ...)
--
-- Reglas:
--   • `generated_contents.course_id` queda intacto como "curso ancla"
--     (compat con AI-generated: la fila apunta al curso donde se creó).
--   • La junction permite N asignaciones extra para que el mismo material
--     aparezca en los tableros de varios cursos sin duplicar el contenido.
--   • Cuando un contenido se borra (CASCADE) o un curso se borra
--     (CASCADE), su fila de junction desaparece.
--   • UNIQUE (content_id, course_id) — no tiene sentido tener la misma
--     asignación duplicada.
--
-- RLS:
--   • SELECT: cualquier docente del curso O Admin/SuperAdmin del tenant.
--   • INSERT/UPDATE/DELETE: el docente del curso O Admin/SuperAdmin.
--   • Estudiante: SELECT solo si está enrollado al curso (necesario para
--     que el "tablero" del estudiante muestre los contenidos asignados).
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.content_course_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id  UUID NOT NULL REFERENCES public.generated_contents(id) ON DELETE CASCADE,
  course_id   UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  created_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- position: orden de aparición en el tablero del curso. Default 0;
  -- el docente puede reordenar más tarde con drag-and-drop si queremos.
  position    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (content_id, course_id)
);

CREATE INDEX IF NOT EXISTS idx_cca_content
  ON public.content_course_assignments(content_id);
CREATE INDEX IF NOT EXISTS idx_cca_course
  ON public.content_course_assignments(course_id);

ALTER TABLE public.content_course_assignments ENABLE ROW LEVEL SECURITY;

-- SELECT: docente del curso O Admin/SuperAdmin O estudiante enrollado.
DROP POLICY IF EXISTS "cca_select" ON public.content_course_assignments;
CREATE POLICY "cca_select" ON public.content_course_assignments
  FOR SELECT
  USING (
    -- Admin/SuperAdmin del tenant: RLS de courses ya recorta a su tenant.
    public.has_role(auth.uid(), 'Admin')
    OR public.has_role(auth.uid(), 'SuperAdmin')
    -- Docente del curso (vía course_teachers).
    OR EXISTS (
      SELECT 1 FROM public.course_teachers ct
       WHERE ct.course_id = content_course_assignments.course_id
         AND ct.user_id = auth.uid()
    )
    -- Estudiante enrollado al curso — necesario para que vea el material
    -- en su tablero.
    OR EXISTS (
      SELECT 1 FROM public.course_enrollments ce
       WHERE ce.course_id = content_course_assignments.course_id
         AND ce.user_id = auth.uid()
    )
  );

-- INSERT: docente del curso O Admin/SuperAdmin. created_by debe ser
-- el caller (defensiva contra forjar autoría).
DROP POLICY IF EXISTS "cca_insert" ON public.content_course_assignments;
CREATE POLICY "cca_insert" ON public.content_course_assignments
  FOR INSERT
  WITH CHECK (
    (created_by IS NULL OR created_by = auth.uid())
    AND (
      public.has_role(auth.uid(), 'Admin')
      OR public.has_role(auth.uid(), 'SuperAdmin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
         WHERE ct.course_id = content_course_assignments.course_id
           AND ct.user_id = auth.uid()
      )
    )
  );

-- UPDATE: docente del curso O Admin/SuperAdmin. Mismo gate que insert.
DROP POLICY IF EXISTS "cca_update" ON public.content_course_assignments;
CREATE POLICY "cca_update" ON public.content_course_assignments
  FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR public.has_role(auth.uid(), 'SuperAdmin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers ct
       WHERE ct.course_id = content_course_assignments.course_id
         AND ct.user_id = auth.uid()
    )
  );

-- DELETE: igual.
DROP POLICY IF EXISTS "cca_delete" ON public.content_course_assignments;
CREATE POLICY "cca_delete" ON public.content_course_assignments
  FOR DELETE
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR public.has_role(auth.uid(), 'SuperAdmin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers ct
       WHERE ct.course_id = content_course_assignments.course_id
           AND ct.user_id = auth.uid()
    )
  );

COMMENT ON TABLE public.content_course_assignments IS
  'Junction N-N que permite asociar un mismo `generated_contents` a varios cursos. El campo `generated_contents.course_id` sigue siendo el curso ancla (el docente original / curso de creación), pero el material aparece en el tablero de TODOS los cursos listados acá.';

NOTIFY pgrst, 'reload schema';
