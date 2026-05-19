-- ──────────────────────────────────────────────────────────────────────
-- Visibilidad de módulos por rol (Admin / Docente / Estudiante).
--
-- Motivación: durante despliegues escalonados o pruebas internas el
-- admin necesita ocultar módulos a ciertos roles. Antes solo había
-- `question_bank_enabled` global (binario, todos los roles). Esto lo
-- generaliza: cada (módulo, rol) tiene un toggle independiente.
--
-- Diseño:
--   - Tabla `module_visibility` con PK (module_key, role).
--   - Seed con los módulos toggleables conocidos en TRUE para los roles
--     que naturalmente los ven. Los roles que no aplican (ej. estudiante
--     viendo `ai_prompts`) se siembran en FALSE.
--   - Helper SQL `is_module_enabled(_module, _role)` para los guards
--     server-side (RPC, edge functions) que quieran consultar.
--   - El frontend hace SELECT * y arma un mapa { module: { role: bool } }.
--
-- Lista de módulos incluidos en el seed:
--   workshops, projects, exams, courses, certificates, forum, calendar,
--   tutor, attendance, gradebook, question_bank, ai_prompts, audit_logs,
--   users, settings, messages, dashboard
--
-- Si un módulo NO aparece en la tabla, el frontend lo trata como ENABLED
-- por default (compatibilidad — módulos nuevos no requieren migración
-- antes de ser navegables).
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.module_visibility (
  module_key text NOT NULL,
  role text NOT NULL CHECK (role IN ('Admin', 'Docente', 'Estudiante')),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id),
  PRIMARY KEY (module_key, role)
);

COMMENT ON TABLE public.module_visibility IS
  'Matriz de visibilidad módulo × rol. Si falta una entrada, el frontend asume enabled=true.';

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION public._touch_module_visibility_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_module_visibility_updated_at ON public.module_visibility;
CREATE TRIGGER trg_module_visibility_updated_at
  BEFORE UPDATE ON public.module_visibility
  FOR EACH ROW EXECUTE FUNCTION public._touch_module_visibility_updated_at();

-- RLS: cualquier autenticado puede LEER (la UI necesita saber qué
-- módulos están visibles). Solo Admin puede ESCRIBIR.
ALTER TABLE public.module_visibility ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "module_visibility_read_all" ON public.module_visibility;
CREATE POLICY "module_visibility_read_all"
  ON public.module_visibility FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "module_visibility_admin_write" ON public.module_visibility;
CREATE POLICY "module_visibility_admin_write"
  ON public.module_visibility FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Admin'));

-- Helper para consultas SQL (RPC / triggers / otros edge functions).
-- Default true cuando no hay fila — coherente con el frontend.
CREATE OR REPLACE FUNCTION public.is_module_enabled(_module text, _role text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (SELECT enabled FROM public.module_visibility
      WHERE module_key = _module AND role = _role),
    true
  );
$$;

-- ── Seed ──
-- Todos los módulos visibles para los roles que naturalmente los ven.
-- El admin puede después apagar lo que quiera desde el panel.
INSERT INTO public.module_visibility (module_key, role, enabled) VALUES
  -- Módulos académicos núcleo — visibles a Docente + Estudiante (Admin
  -- los gestiona desde su sección).
  ('workshops',    'Docente',    true),
  ('workshops',    'Estudiante', true),
  ('projects',     'Docente',    true),
  ('projects',     'Estudiante', true),
  ('exams',        'Docente',    true),
  ('exams',        'Estudiante', true),
  ('courses',      'Docente',    true),
  ('courses',      'Estudiante', true),
  ('gradebook',    'Docente',    true),
  ('grades',       'Estudiante', true),
  ('attendance',   'Docente',    true),
  ('attendance',   'Estudiante', true),
  -- Módulos "extensión" — más típicamente toggle-ables.
  ('forum',        'Docente',    true),
  ('forum',        'Estudiante', true),
  ('calendar',     'Docente',    true),
  ('calendar',     'Estudiante', true),
  ('certificates', 'Docente',    true),
  ('certificates', 'Estudiante', true),
  ('tutor',        'Estudiante', true),
  ('question_bank','Docente',    true),
  ('ai_prompts',   'Docente',    true),
  -- Comunes a todos los roles.
  ('messages',     'Admin',      true),
  ('messages',     'Docente',    true),
  ('messages',     'Estudiante', true),
  ('dashboard',    'Admin',      true),
  ('dashboard',    'Docente',    true),
  ('dashboard',    'Estudiante', true)
ON CONFLICT (module_key, role) DO NOTHING;

NOTIFY pgrst, 'reload schema';
