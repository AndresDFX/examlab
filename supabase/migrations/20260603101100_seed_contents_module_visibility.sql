-- ──────────────────────────────────────────────────────────────────────
-- Seed: módulo `contents` en `module_visibility`.
--
-- El panel admin "Módulos" no estaba mostrando "Contenidos" porque la
-- fila base nunca se sembró. Ahora que está en el código (MODULES list +
-- NAV_PATH_TO_MODULE + ModuleKey union), seed la fila para los tres
-- roles con default razonable:
--   - Admin / Docente: enabled = true (lo usa el docente para generar
--     material académico; admin lo configura desde Prompts).
--   - Estudiante: enabled = false (el estudiante NO genera contenidos).
--
-- `display_order` 125 para que aparezca entre Tutor IA (120) y Banco de
-- preguntas (130), pegado al flujo "preparar material" del docente.
-- Idempotente vía ON CONFLICT.
-- ──────────────────────────────────────────────────────────────────────

INSERT INTO public.module_visibility (module_key, role, enabled, display_order)
VALUES
  ('contents', 'Admin',      true,  125),
  ('contents', 'Docente',    true,  125),
  ('contents', 'Estudiante', false, 125)
ON CONFLICT (module_key, role) DO NOTHING;

NOTIFY pgrst, 'reload schema';
