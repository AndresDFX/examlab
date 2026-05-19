-- ──────────────────────────────────────────────────────────────────────
-- Seed: módulo `dashboard` en `module_visibility`.
--
-- Antes el Dashboard no aparecía en el panel admin "Visibilidad y orden
-- de módulos" porque no tenía fila base. Ahora lo agregamos a la lista
-- para que el admin pueda reordenarlo como cualquier otro módulo (por
-- ejemplo, moverlo al final si la institución prefiere arrancar en
-- "Cursos" en lugar del panel de KPIs).
--
-- Defaults:
--   - enabled = true para los 3 roles (Dashboard es la home universal).
--   - display_order = 10 (primero en el sidebar — comportamiento previo).
--
-- Idempotente vía ON CONFLICT.
-- ──────────────────────────────────────────────────────────────────────

INSERT INTO public.module_visibility (module_key, role, enabled, display_order)
VALUES
  ('dashboard', 'Admin',      true, 10),
  ('dashboard', 'Docente',    true, 10),
  ('dashboard', 'Estudiante', true, 10)
ON CONFLICT (module_key, role) DO NOTHING;

NOTIFY pgrst, 'reload schema';
