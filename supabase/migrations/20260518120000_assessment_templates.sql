-- ──────────────────────────────────────────────────────────────────────
-- Templates abstractos: perfil de configuración reutilizable para
-- examen/taller/proyecto. NO incluye preguntas (eso lo hace el banco).
--
-- Caso de uso: el docente arma un examen con muchos toggles (proctoring,
-- navegación secuencial, max_warnings, retry_mode, peso default) y
-- quiere replicar esa CONFIG en otros exámenes nuevos. El template
-- guarda solo los campos que afectan comportamiento, NO datos
-- (fechas, course_id, title).
--
-- RLS: cada docente ve sus propios templates + los públicos del sistema
-- (creados por admin). Esto deja espacio para "templates oficiales" del
-- programa académico.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.assessment_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- A qué tipo de assessment aplica
  target TEXT NOT NULL CHECK (target IN ('exam', 'workshop', 'project')),
  -- Nombre humano del template (único por usuario+target)
  name TEXT NOT NULL,
  description TEXT,
  -- Visibilidad: 'private' = solo el creador; 'public' = todos los docentes
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  -- Config como JSONB. Las keys dependen del target:
  --   exam:     time_limit_minutes, navigation_type, shuffle_enabled,
  --             max_warnings, max_attempts, retry_mode, weight
  --   workshop: weight, max_score, group_mode, group_size_min/max
  --   project:  weight, max_score, group_mode, group_size_min/max
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(created_by, target, name)
);

CREATE INDEX IF NOT EXISTS idx_templates_target ON public.assessment_templates(target);
CREATE INDEX IF NOT EXISTS idx_templates_created_by ON public.assessment_templates(created_by);

DROP TRIGGER IF EXISTS trg_assessment_templates_updated_at ON public.assessment_templates;
CREATE TRIGGER trg_assessment_templates_updated_at
  BEFORE UPDATE ON public.assessment_templates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.assessment_templates ENABLE ROW LEVEL SECURITY;

-- SELECT: propios + públicos + admin ve todo
DROP POLICY IF EXISTS "assessment_templates_select" ON public.assessment_templates;
CREATE POLICY "assessment_templates_select"
  ON public.assessment_templates FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR visibility = 'public'
    OR created_by = auth.uid()
  );

-- INSERT: el docente como dueño; admin puede crear public en nombre del sistema
DROP POLICY IF EXISTS "assessment_templates_insert" ON public.assessment_templates;
CREATE POLICY "assessment_templates_insert"
  ON public.assessment_templates FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'Admin')
    OR (created_by = auth.uid() AND visibility = 'private')
  );

-- UPDATE/DELETE: dueño o admin
DROP POLICY IF EXISTS "assessment_templates_update" ON public.assessment_templates;
CREATE POLICY "assessment_templates_update"
  ON public.assessment_templates FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'Admin') OR created_by = auth.uid())
  WITH CHECK (public.has_role(auth.uid(), 'Admin') OR created_by = auth.uid());

DROP POLICY IF EXISTS "assessment_templates_delete" ON public.assessment_templates;
CREATE POLICY "assessment_templates_delete"
  ON public.assessment_templates FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'Admin') OR created_by = auth.uid());

NOTIFY pgrst, 'reload schema';
