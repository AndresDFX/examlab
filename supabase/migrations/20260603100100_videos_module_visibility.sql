-- Seed visibilidad del módulo Videos.
-- Visible para Docente + Admin por default. Estudiante NO ve la
-- biblioteca (solo consume videos a través de proyectos / módulos que
-- los referencian — no necesita la lista cruda).
INSERT INTO public.module_visibility (module_key, role, enabled, display_order) VALUES
  ('videos', 'Admin',    true, 125),
  ('videos', 'Docente',  true, 125)
ON CONFLICT (module_key, role) DO NOTHING;

NOTIFY pgrst, 'reload schema';
