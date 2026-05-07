-- ============================================================
-- Grupos para entregas de proyectos (espejo de workshop_groups).
--
-- Soporta modo MIXTO: en el mismo proyecto pueden coexistir
-- estudiantes con grupo (entregan en grupo, comparten una sola
-- entrega y reciben la misma nota) y sin grupo (entregan individual).
--
-- Estructura paralela a la de talleres:
--   projects.group_mode  ('individual' | 'teacher_assigned' | 'self_signup')
--   project_groups       (id, project_id, name, signup_code)
--   project_group_members(group_id, user_id) con trigger único
--   project_submissions.group_id  (la submission pertenece al grupo)
-- ============================================================

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS group_mode TEXT NOT NULL DEFAULT 'individual'
    CHECK (group_mode IN ('individual', 'teacher_assigned', 'self_signup')),
  ADD COLUMN IF NOT EXISTS group_size_min INT NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS group_size_max INT NOT NULL DEFAULT 5;

CREATE TABLE IF NOT EXISTS public.project_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  signup_code text NOT NULL DEFAULT substr(md5(random()::text), 1, 6),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_project_groups_project
  ON public.project_groups(project_id);

CREATE TABLE IF NOT EXISTS public.project_group_members (
  group_id uuid NOT NULL REFERENCES public.project_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_group_members_user
  ON public.project_group_members(user_id);

-- Un user solo puede estar en UN grupo por proyecto. Trigger valida
-- (la PK (group_id, user_id) no lo previene por sí sola).
CREATE OR REPLACE FUNCTION public.assert_one_project_group_per_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_project_id uuid;
BEGIN
  SELECT project_id INTO v_project_id FROM public.project_groups WHERE id = NEW.group_id;
  IF EXISTS (
    SELECT 1
    FROM public.project_group_members m
    JOIN public.project_groups g ON g.id = m.group_id
    WHERE g.project_id = v_project_id
      AND m.user_id = NEW.user_id
      AND m.group_id <> NEW.group_id
  ) THEN
    RAISE EXCEPTION 'El estudiante ya está en otro grupo de este proyecto';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_one_project_group_per_user ON public.project_group_members;
CREATE TRIGGER trg_one_project_group_per_user
  BEFORE INSERT OR UPDATE ON public.project_group_members
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_one_project_group_per_user();

-- group_id en submissions
ALTER TABLE public.project_submissions
  ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.project_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_project_submissions_group
  ON public.project_submissions(group_id);

-- ───────── RLS ─────────
ALTER TABLE public.project_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "project_groups_read" ON public.project_groups;
CREATE POLICY "project_groups_read"
  ON public.project_groups FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "project_groups_teacher_admin_write" ON public.project_groups;
CREATE POLICY "project_groups_teacher_admin_write"
  ON public.project_groups FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));

DROP POLICY IF EXISTS "project_group_members_read" ON public.project_group_members;
CREATE POLICY "project_group_members_read"
  ON public.project_group_members FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "project_group_members_teacher_admin_write" ON public.project_group_members;
CREATE POLICY "project_group_members_teacher_admin_write"
  ON public.project_group_members FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));

-- ───────── RLS de project_submissions: incluir miembros del grupo ─────────
DROP POLICY IF EXISTS "project_submissions_select" ON public.project_submissions;
CREATE POLICY "project_submissions_select"
  ON public.project_submissions FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'Docente')
    OR public.has_role(auth.uid(), 'Admin')
    OR (group_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.project_group_members m
      WHERE m.group_id = project_submissions.group_id AND m.user_id = auth.uid()
    ))
  );

DROP POLICY IF EXISTS "project_submissions_insert" ON public.project_submissions;
CREATE POLICY "project_submissions_insert"
  ON public.project_submissions FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'Docente')
    OR public.has_role(auth.uid(), 'Admin')
    OR (group_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.project_group_members m
      WHERE m.group_id = project_submissions.group_id AND m.user_id = auth.uid()
    ))
  );

DROP POLICY IF EXISTS "project_submissions_update" ON public.project_submissions;
CREATE POLICY "project_submissions_update"
  ON public.project_submissions FOR UPDATE TO authenticated
  USING (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'Docente')
    OR public.has_role(auth.uid(), 'Admin')
    OR (group_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.project_group_members m
      WHERE m.group_id = project_submissions.group_id AND m.user_id = auth.uid()
    ))
  );
