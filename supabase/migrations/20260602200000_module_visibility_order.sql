-- ──────────────────────────────────────────────────────────────────────
-- Orden de módulos en el sidebar por rol.
--
-- Agrega `display_order` a `module_visibility`. El sidebar lee la tabla
-- y ordena items por (display_order ASC, module_key ASC) para el rol
-- activo. Default 100 → orden alfabético natural mientras el admin no
-- lo configura.
--
-- El admin puede reordenar desde el panel "Módulos" arrastrando filas
-- o ingresando un número manualmente. Cambios son por (módulo × rol).
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.module_visibility
  ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 100;

COMMENT ON COLUMN public.module_visibility.display_order IS
  'Orden de aparición del módulo en el sidebar para el rol indicado. Menor = aparece antes.';

-- Seed razonable: numera por bloques de 10 para dejar espacio entre
-- módulos al insertar nuevos. Si el módulo ya tiene un valor != 100
-- (porque el admin lo cambió), respetamos su decisión.
UPDATE public.module_visibility SET display_order = 10  WHERE display_order = 100 AND module_key = 'dashboard';
UPDATE public.module_visibility SET display_order = 20  WHERE display_order = 100 AND module_key = 'courses';
UPDATE public.module_visibility SET display_order = 30  WHERE display_order = 100 AND module_key = 'exams';
UPDATE public.module_visibility SET display_order = 40  WHERE display_order = 100 AND module_key = 'workshops';
UPDATE public.module_visibility SET display_order = 50  WHERE display_order = 100 AND module_key = 'projects';
UPDATE public.module_visibility SET display_order = 60  WHERE display_order = 100 AND module_key = 'gradebook';
UPDATE public.module_visibility SET display_order = 60  WHERE display_order = 100 AND module_key = 'grades';
UPDATE public.module_visibility SET display_order = 65  WHERE display_order = 100 AND module_key = 'certificates';
UPDATE public.module_visibility SET display_order = 70  WHERE display_order = 100 AND module_key = 'attendance';
UPDATE public.module_visibility SET display_order = 80  WHERE display_order = 100 AND module_key = 'calendar';
UPDATE public.module_visibility SET display_order = 90  WHERE display_order = 100 AND module_key = 'forum';
UPDATE public.module_visibility SET display_order = 100 WHERE display_order = 100 AND module_key = 'messages';
UPDATE public.module_visibility SET display_order = 110 WHERE display_order = 100 AND module_key = 'tutor';
UPDATE public.module_visibility SET display_order = 120 WHERE display_order = 100 AND module_key = 'question_bank';
UPDATE public.module_visibility SET display_order = 130 WHERE display_order = 100 AND module_key = 'ai_prompts';

NOTIFY pgrst, 'reload schema';
