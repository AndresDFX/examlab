-- ──────────────────────────────────────────────────────────────────────
-- Max intentos parametrizable para Talleres y Proyectos.
--
-- Hasta ahora solo Exámenes tenían `max_attempts` configurable por
-- docente (más el default en `app_settings.default_exam_max_attempts`
-- y `courses.max_exam_attempts`). Talleres y proyectos no expusieron la
-- noción, así que un alumno solo podía entregar una vez.
--
-- Esta migración generaliza:
--   - `app_settings.default_workshop_max_attempts` (DEFAULT 1)
--   - `app_settings.default_project_max_attempts` (DEFAULT 1)
--   - `workshops.max_attempts INT` (override por taller, null → usa default)
--   - `projects.max_attempts INT`  (override por proyecto, null → usa default)
--
-- La lógica de enforcement vive en el frontend (form de entrega) +
-- triggers SQL existentes para `workshop_submissions` /
-- `project_submissions`. Esta migración solo agrega los campos; el
-- gating se hará en una pasada posterior cuando se necesite estrictamente.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS default_workshop_max_attempts INT NOT NULL DEFAULT 1
    CHECK (default_workshop_max_attempts BETWEEN 1 AND 10);

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS default_project_max_attempts INT NOT NULL DEFAULT 1
    CHECK (default_project_max_attempts BETWEEN 1 AND 10);

COMMENT ON COLUMN public.app_settings.default_workshop_max_attempts IS
  'Default global de intentos máximos por taller. El docente puede override por taller en workshops.max_attempts.';

COMMENT ON COLUMN public.app_settings.default_project_max_attempts IS
  'Default global de intentos máximos por proyecto. El docente puede override por proyecto en projects.max_attempts.';

ALTER TABLE public.workshops
  ADD COLUMN IF NOT EXISTS max_attempts INT
    CHECK (max_attempts IS NULL OR max_attempts BETWEEN 1 AND 10);

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS max_attempts INT
    CHECK (max_attempts IS NULL OR max_attempts BETWEEN 1 AND 10);

COMMENT ON COLUMN public.workshops.max_attempts IS
  'Intentos máximos para este taller. NULL → usa app_settings.default_workshop_max_attempts.';

COMMENT ON COLUMN public.projects.max_attempts IS
  'Intentos máximos para este proyecto. NULL → usa app_settings.default_project_max_attempts.';

NOTIFY pgrst, 'reload schema';
