-- ──────────────────────────────────────────────────────────────────────
-- Fix cross-tenant leak: submissions / workshop_submissions /
-- project_submissions tenían policies con `OR has_role('Admin')` que
-- permitían que un Admin de CUALQUIER tenant viera TODAS las entregas
-- de la plataforma — sin restricción a su propio tenant.
--
-- Síntoma reportado: un tenant recién creado mostraba "Por calificar:
-- 51" en el dashboard del Admin, cuando ese tenant no tenía cursos ni
-- estudiantes. El leak venía de las RLS de estas 3 tablas: las queries
-- `select count(*)` desde el cliente del Admin retornaban filas de
-- otros tenants porque `has_role('Admin')` matcheaba sin importar el
-- tenant del actor.
--
-- Fix: la rama Admin de cada policy ahora EXIGE que el course del
-- submission pertenezca al tenant del Admin (o que el caller sea
-- SuperAdmin, que sigue siendo cross-tenant). Docente y dueño siguen
-- intactos.
--
-- Relaciones:
--   submissions          → exams.course_id        → courses.tenant_id
--   workshop_submissions → workshops.course_id    → courses.tenant_id
--   project_submissions  → projects.course_id     → courses.tenant_id
--
-- Helper local `is_admin_of_course_tenant(_course_id)`:
--   - Admin del tenant del curso, O
--   - SuperAdmin (cross-tenant).
-- ──────────────────────────────────────────────────────────────────────

-- Helper que devuelve true si el caller es Admin del tenant del curso
-- O SuperAdmin. SECURITY DEFINER porque consulta courses.tenant_id y
-- profiles.tenant_id que pueden tener RLS propia.
CREATE OR REPLACE FUNCTION public.is_admin_of_course_tenant(_course_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.is_super_admin()
    OR (
      public.has_role(auth.uid(), 'Admin')
      AND EXISTS (
        SELECT 1
        FROM public.courses c
        JOIN public.profiles p ON p.id = auth.uid()
        WHERE c.id = _course_id
          AND c.tenant_id = p.tenant_id
      )
    );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin_of_course_tenant(UUID) TO authenticated;

COMMENT ON FUNCTION public.is_admin_of_course_tenant(UUID) IS
  'True si el caller es Admin del tenant del course (cross-tenant scoping) o SuperAdmin (cross-tenant total). Reemplaza el patrón laxo has_role("Admin") en RLS de submissions.';

-- ── submissions (exámenes) ─────────────────────────────────────────────
-- Solo aplicamos si las tablas existen — defensivo por entornos donde
-- la migración previa no haya corrido.
DO $$
BEGIN
  IF to_regclass('public.submissions') IS NULL THEN
    RAISE NOTICE 'submissions no existe — se omite el scoping';
  ELSE
    -- Drop ALL las variantes históricas para limpio re-CREATE.
    EXECUTE 'DROP POLICY IF EXISTS "Users see own submissions" ON public.submissions';
    EXECUTE 'DROP POLICY IF EXISTS "submissions_select" ON public.submissions';
    EXECUTE 'DROP POLICY IF EXISTS "Users insert own submissions" ON public.submissions';
    EXECUTE 'DROP POLICY IF EXISTS "submissions_insert" ON public.submissions';
    EXECUTE 'DROP POLICY IF EXISTS "Users update own submissions" ON public.submissions';
    EXECUTE 'DROP POLICY IF EXISTS "submissions_update" ON public.submissions';

    -- SELECT: dueño, docente del curso, Admin DEL TENANT del curso, o SuperAdmin.
    EXECUTE $POLICY$
      CREATE POLICY "submissions_select"
        ON public.submissions FOR SELECT TO authenticated
        USING (
          auth.uid() = user_id
          OR EXISTS (
            SELECT 1 FROM public.exams e
             JOIN public.course_teachers ct ON ct.course_id = e.course_id
             WHERE e.id = submissions.exam_id AND ct.user_id = auth.uid()
          )
          OR EXISTS (
            SELECT 1 FROM public.exams e
             WHERE e.id = submissions.exam_id
               AND public.is_admin_of_course_tenant(e.course_id)
          )
        )
    $POLICY$;

    -- INSERT/UPDATE: dueño puede crear/editar su entrega; docente y
    -- Admin-del-tenant también (para corrección).
    EXECUTE $POLICY$
      CREATE POLICY "submissions_insert"
        ON public.submissions FOR INSERT TO authenticated
        WITH CHECK (
          auth.uid() = user_id
          OR EXISTS (
            SELECT 1 FROM public.exams e
             JOIN public.course_teachers ct ON ct.course_id = e.course_id
             WHERE e.id = submissions.exam_id AND ct.user_id = auth.uid()
          )
          OR EXISTS (
            SELECT 1 FROM public.exams e
             WHERE e.id = submissions.exam_id
               AND public.is_admin_of_course_tenant(e.course_id)
          )
        )
    $POLICY$;

    EXECUTE $POLICY$
      CREATE POLICY "submissions_update"
        ON public.submissions FOR UPDATE TO authenticated
        USING (
          auth.uid() = user_id
          OR EXISTS (
            SELECT 1 FROM public.exams e
             JOIN public.course_teachers ct ON ct.course_id = e.course_id
             WHERE e.id = submissions.exam_id AND ct.user_id = auth.uid()
          )
          OR EXISTS (
            SELECT 1 FROM public.exams e
             WHERE e.id = submissions.exam_id
               AND public.is_admin_of_course_tenant(e.course_id)
          )
        )
    $POLICY$;
  END IF;
END $$;

-- ── workshop_submissions ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.workshop_submissions') IS NULL THEN
    RAISE NOTICE 'workshop_submissions no existe — se omite';
  ELSE
    EXECUTE 'DROP POLICY IF EXISTS "Users see own workshop submissions" ON public.workshop_submissions';
    EXECUTE 'DROP POLICY IF EXISTS "workshop_submissions_select" ON public.workshop_submissions';
    EXECUTE 'DROP POLICY IF EXISTS "Users insert own workshop submissions" ON public.workshop_submissions';
    EXECUTE 'DROP POLICY IF EXISTS "workshop_submissions_insert" ON public.workshop_submissions';
    EXECUTE 'DROP POLICY IF EXISTS "Users update own workshop submissions" ON public.workshop_submissions';
    EXECUTE 'DROP POLICY IF EXISTS "workshop_submissions_update" ON public.workshop_submissions';

    EXECUTE $POLICY$
      CREATE POLICY "workshop_submissions_select"
        ON public.workshop_submissions FOR SELECT TO authenticated
        USING (
          auth.uid() = user_id
          OR (group_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.workshop_group_members m
             WHERE m.group_id = workshop_submissions.group_id AND m.user_id = auth.uid()
          ))
          OR EXISTS (
            SELECT 1 FROM public.workshops w
             JOIN public.course_teachers ct ON ct.course_id = w.course_id
             WHERE w.id = workshop_submissions.workshop_id AND ct.user_id = auth.uid()
          )
          OR EXISTS (
            SELECT 1 FROM public.workshops w
             WHERE w.id = workshop_submissions.workshop_id
               AND public.is_admin_of_course_tenant(w.course_id)
          )
        )
    $POLICY$;

    EXECUTE $POLICY$
      CREATE POLICY "workshop_submissions_insert"
        ON public.workshop_submissions FOR INSERT TO authenticated
        WITH CHECK (
          auth.uid() = user_id
          OR (group_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.workshop_group_members m
             WHERE m.group_id = workshop_submissions.group_id AND m.user_id = auth.uid()
          ))
          OR EXISTS (
            SELECT 1 FROM public.workshops w
             JOIN public.course_teachers ct ON ct.course_id = w.course_id
             WHERE w.id = workshop_submissions.workshop_id AND ct.user_id = auth.uid()
          )
          OR EXISTS (
            SELECT 1 FROM public.workshops w
             WHERE w.id = workshop_submissions.workshop_id
               AND public.is_admin_of_course_tenant(w.course_id)
          )
        )
    $POLICY$;

    EXECUTE $POLICY$
      CREATE POLICY "workshop_submissions_update"
        ON public.workshop_submissions FOR UPDATE TO authenticated
        USING (
          auth.uid() = user_id
          OR (group_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.workshop_group_members m
             WHERE m.group_id = workshop_submissions.group_id AND m.user_id = auth.uid()
          ))
          OR EXISTS (
            SELECT 1 FROM public.workshops w
             JOIN public.course_teachers ct ON ct.course_id = w.course_id
             WHERE w.id = workshop_submissions.workshop_id AND ct.user_id = auth.uid()
          )
          OR EXISTS (
            SELECT 1 FROM public.workshops w
             WHERE w.id = workshop_submissions.workshop_id
               AND public.is_admin_of_course_tenant(w.course_id)
          )
        )
    $POLICY$;
  END IF;
END $$;

-- ── project_submissions ───────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.project_submissions') IS NULL THEN
    RAISE NOTICE 'project_submissions no existe — se omite';
  ELSE
    EXECUTE 'DROP POLICY IF EXISTS "Users see own project submissions" ON public.project_submissions';
    EXECUTE 'DROP POLICY IF EXISTS "project_submissions_select" ON public.project_submissions';
    EXECUTE 'DROP POLICY IF EXISTS "Users insert own project submissions" ON public.project_submissions';
    EXECUTE 'DROP POLICY IF EXISTS "project_submissions_insert" ON public.project_submissions';
    EXECUTE 'DROP POLICY IF EXISTS "Users update own project submissions" ON public.project_submissions';
    EXECUTE 'DROP POLICY IF EXISTS "project_submissions_update" ON public.project_submissions';

    EXECUTE $POLICY$
      CREATE POLICY "project_submissions_select"
        ON public.project_submissions FOR SELECT TO authenticated
        USING (
          auth.uid() = user_id
          OR (group_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.project_group_members m
             WHERE m.group_id = project_submissions.group_id AND m.user_id = auth.uid()
          ))
          OR EXISTS (
            SELECT 1 FROM public.projects p
             JOIN public.course_teachers ct ON ct.course_id = p.course_id
             WHERE p.id = project_submissions.project_id AND ct.user_id = auth.uid()
          )
          OR EXISTS (
            SELECT 1 FROM public.projects p
             WHERE p.id = project_submissions.project_id
               AND public.is_admin_of_course_tenant(p.course_id)
          )
        )
    $POLICY$;

    EXECUTE $POLICY$
      CREATE POLICY "project_submissions_insert"
        ON public.project_submissions FOR INSERT TO authenticated
        WITH CHECK (
          auth.uid() = user_id
          OR (group_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.project_group_members m
             WHERE m.group_id = project_submissions.group_id AND m.user_id = auth.uid()
          ))
          OR EXISTS (
            SELECT 1 FROM public.projects p
             JOIN public.course_teachers ct ON ct.course_id = p.course_id
             WHERE p.id = project_submissions.project_id AND ct.user_id = auth.uid()
          )
          OR EXISTS (
            SELECT 1 FROM public.projects p
             WHERE p.id = project_submissions.project_id
               AND public.is_admin_of_course_tenant(p.course_id)
          )
        )
    $POLICY$;

    EXECUTE $POLICY$
      CREATE POLICY "project_submissions_update"
        ON public.project_submissions FOR UPDATE TO authenticated
        USING (
          auth.uid() = user_id
          OR (group_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.project_group_members m
             WHERE m.group_id = project_submissions.group_id AND m.user_id = auth.uid()
          ))
          OR EXISTS (
            SELECT 1 FROM public.projects p
             JOIN public.course_teachers ct ON ct.course_id = p.course_id
             WHERE p.id = project_submissions.project_id AND ct.user_id = auth.uid()
          )
          OR EXISTS (
            SELECT 1 FROM public.projects p
             WHERE p.id = project_submissions.project_id
               AND public.is_admin_of_course_tenant(p.course_id)
          )
        )
    $POLICY$;
  END IF;
END $$;
