-- ============================================================
-- Agregar campos opcionales al modelo de Curso:
--   - code: código corto / abreviatura (ej. "ProgII", "CALC-101").
--           El nombre 'code' lo usa report-context.ts como
--           `{{curso.codigo}}`; mantiene compatibilidad con la
--           variable ya documentada en el catálogo de informes.
--   - semestre: número de semestre dentro del programa (1..12).
--           SMALLINT para ahorrar espacio. NULL permitido.
--   - grupo: identificador del grupo/sección dentro del curso
--           (ej. "341-C", "B1"). Texto libre, NULL permitido.
--
-- Todos opcionales — no rompen cursos existentes ni el flujo de
-- creación si el admin no los completa. Se exponen como variables
-- en las plantillas de informe para que los reportes institucionales
-- (Diagnóstico, Acuerdo Pedagógico, etc.) pre-rellenen los headers.
-- ============================================================

ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS semestre SMALLINT;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS grupo TEXT;

-- Soft checks: semestre debe ser razonable (1..12). NULL queda permitido.
ALTER TABLE public.courses
  DROP CONSTRAINT IF EXISTS chk_courses_semestre_range;
ALTER TABLE public.courses
  ADD CONSTRAINT chk_courses_semestre_range
  CHECK (semestre IS NULL OR (semestre >= 1 AND semestre <= 12));

NOTIFY pgrst, 'reload schema';
