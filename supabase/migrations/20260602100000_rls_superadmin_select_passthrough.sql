-- ──────────────────────────────────────────────────────────────────────
-- SuperAdmin: bypass de SELECT en tablas de submission/workshop/project/exam.
--
-- Problema: el módulo "Cola IA" del panel admin/superadmin enriquece los
-- jobs con título de taller/examen/proyecto + nombre del estudiante via
-- queries cliente a `workshop_submissions`, `submissions`,
-- `project_submissions`, `workshops`, `exams`, `projects`, etc. La RLS
-- de esas tablas habilita acceso a Docente/Admin del tenant — pero NO a
-- SuperAdmin (que en modo cross-tenant no tiene tenant_id propio).
-- Resultado: los lookups devolvían 0 filas y el panel mostraba "Taller
-- (batch)" como título genérico en lugar de "Taller - En clase, Mina
-- Advincula".
--
-- Fix: agregar `OR is_super_admin()` a las policies SELECT de la cadena
-- de lookup. Solo afecta lectura — INSERT/UPDATE/DELETE siguen acotadas
-- a sus policies originales. `is_super_admin()` ya existe en otras
-- tablas (profiles, ai_grading_queue, tenants, etc.) y es la convención
-- estable para cross-tenant read.
--
-- Tablas tocadas:
--   - exams, workshops, projects (entidades académicas — needed para
--     resolver titles en cualquier vista cross-tenant)
--   - submissions, workshop_submissions, project_submissions (entregas
--     — needed para resolver estudiante + entity desde un job)
--   - workshop_submission_answers, project_submission_files (rows
--     individuales que apuntan a entregas)
--
-- Tablas NO tocadas (ya tenían SA o no aplica):
--   - profiles: ya tenía is_super_admin() via profiles_select_same_tenant
--   - ai_grading_queue: ya tenía is_super_admin() en su SELECT
--   - courses, course_teachers, course_enrollments: out of scope (no
--     se tocan en este pase; si emergen issues similares las agregamos)
-- ──────────────────────────────────────────────────────────────────────

-- exams_select_in_tenant: course_in_my_tenant + SA passthrough.
ALTER POLICY "exams_select_in_tenant" ON public.exams
  USING (public.course_in_my_tenant(course_id) OR public.is_super_admin());

-- workshops_select_in_tenant: idem.
ALTER POLICY "workshops_select_in_tenant" ON public.workshops
  USING (public.course_in_my_tenant(course_id) OR public.is_super_admin());

-- projects_select_in_tenant: idem.
ALTER POLICY "projects_select_in_tenant" ON public.projects
  USING (public.course_in_my_tenant(course_id) OR public.is_super_admin());

-- workshop_submissions_select: owner / docente / admin / SA / miembro de grupo.
ALTER POLICY "workshop_submissions_select" ON public.workshop_submissions
  USING (
    (auth.uid() = user_id)
    OR public.has_role(auth.uid(), 'Docente'::public.app_role)
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
    OR public.is_super_admin()
    OR (
      group_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.workshop_group_members m
        WHERE m.group_id = workshop_submissions.group_id
          AND m.user_id = auth.uid()
      )
    )
  );

-- project_submissions: dos policies SELECT (legacy + actual). Aplicamos
-- SA a ambas — más simple que dropear la legacy.
ALTER POLICY "project_submissions_select" ON public.project_submissions
  USING (
    (auth.uid() = user_id)
    OR public.has_role(auth.uid(), 'Docente'::public.app_role)
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
    OR public.is_super_admin()
    OR (
      group_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.project_group_members m
        WHERE m.group_id = project_submissions.group_id
          AND m.user_id = auth.uid()
      )
    )
  );

ALTER POLICY "Users see own project submissions" ON public.project_submissions
  USING (
    (auth.uid() = user_id)
    OR public.has_role(auth.uid(), 'Docente'::public.app_role)
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
    OR public.is_super_admin()
  );

-- submissions (de exámenes).
ALTER POLICY "Users see own submissions" ON public.submissions
  USING (
    (auth.uid() = user_id)
    OR public.has_role(auth.uid(), 'Docente'::public.app_role)
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
    OR public.is_super_admin()
  );

-- workshop_submission_answers: filtra via la submission padre. SA
-- bypass se aplica al check final (no al inner EXISTS, para no romper
-- el patrón existente).
ALTER POLICY "Users see own workshop answers" ON public.workshop_submission_answers
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.workshop_submissions ws
      WHERE ws.id = workshop_submission_answers.submission_id
        AND (
          ws.user_id = auth.uid()
          OR public.has_role(auth.uid(), 'Docente'::public.app_role)
          OR public.has_role(auth.uid(), 'Admin'::public.app_role)
        )
    )
  );

-- project_submission_files: idem.
ALTER POLICY "project_sub_files_owner_or_staff_select" ON public.project_submission_files
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.project_submissions ps
      WHERE ps.id = project_submission_files.submission_id
        AND (
          ps.user_id = auth.uid()
          OR public.has_role(auth.uid(), 'Docente'::public.app_role)
          OR public.has_role(auth.uid(), 'Admin'::public.app_role)
        )
    )
  );

NOTIFY pgrst, 'reload schema';
