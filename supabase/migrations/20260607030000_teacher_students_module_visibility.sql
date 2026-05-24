-- Seed visibilidad del módulo "Mis estudiantes" (Docente).
-- Visible solo para Docente — Admin no lo necesita (usa /admin/users),
-- Estudiante no aplica. Default habilitado para Docente.
INSERT INTO public.module_visibility (module_key, role, enabled, display_order) VALUES
  ('teacher_students', 'Docente', true, 210)
ON CONFLICT (module_key, role) DO NOTHING;

NOTIFY pgrst, 'reload schema';
