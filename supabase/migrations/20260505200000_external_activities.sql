-- ============================================================
-- Actividades externas (presenciales): exámenes/talleres que ya
-- ocurrieron fuera de la plataforma y solo se registran para que
-- la calificación final del estudiante incluya esa nota.
-- ============================================================
-- Estrategia: añadir un flag `is_external` a las tablas existentes
-- en lugar de crear tablas paralelas. Razón: los cortes (grade_cuts)
-- ya promedian las calificaciones de submissions / workshop_submissions
-- por tipo (exam_weight, workshop_weight). Si un examen externo es solo
-- un row más en `exams` con su `cut_id` y filas en `submissions`
-- con `final_override_grade`, el cálculo entra automático sin tocar
-- la lógica de promedios.
--
-- Lo único que el código frontend tiene que hacer:
--  1. Esconder los campos sin sentido (duración, navegación, preguntas)
--     cuando is_external=true.
--  2. Para entregas: insertar/actualizar la fila de submissions del
--     estudiante con final_override_grade (sin start/end real).
--  3. Esconder el examen/taller del listado del estudiante.

ALTER TABLE public.exams
  ADD COLUMN IF NOT EXISTS is_external BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.workshops
  ADD COLUMN IF NOT EXISTS is_external BOOLEAN NOT NULL DEFAULT false;

-- Índices para filtrar rápidamente cuando el listado del estudiante
-- excluye externos. course_id ya está indexado, esto solo añade el
-- filtro is_external para queries del tipo
-- "exams del curso X que NO son externos".
CREATE INDEX IF NOT EXISTS idx_exams_course_is_external
  ON public.exams(course_id, is_external);
CREATE INDEX IF NOT EXISTS idx_workshops_course_is_external
  ON public.workshops(course_id, is_external);
