-- ──────────────────────────────────────────────────────────────────────
-- Multi-tenancy: fix de RLS para cerrar la fuga cross-tenant.
--
-- La Fase 2 (20260622) agregó `tenant_id` a `courses` y a otras tablas,
-- pero asumió erróneamente que las policies originales filtraban por
-- membresía (`course_teachers` / `course_enrollments`). Las policies
-- reales son `USING (true)` o `USING (has_role(...))` sin tenant filter,
-- lo que permite que un Admin/Docente de tenant A vea y modifique datos
-- del tenant B.
--
-- Esta migración:
--   1. Crea helper `course_in_my_tenant(uuid)` para joinear con courses
--      y verificar tenant en una llamada.
--   2. Reescribe las policies de `courses` y de ~14 tablas hijas que
--      tenían `USING (true)` o `has_role(...)` sin tenant scope.
--   3. Reescribe las policies de tablas con `tenant_id` propio que
--      estaban abiertas (`ai_*`, `app_settings`, `certificate_settings`,
--      `notifications`, `module_visibility`).
--
-- Política aplicada:
--   - Conservadora: preserva quién PODÍA hacer qué (Admin, Docente,
--     Estudiante) y SOLO agrega filtro de tenant.
--   - SuperAdmin sigue siendo bypass cross-tenant.
--   - El cliente NO necesita cambiar nada — las queries siguen funcionando
--     igual, solo retornan menos filas (las de su tenant).
--
-- Tablas NO incluidas (no son fuga inmediata):
--   - videos: biblioteca global, no tiene course_id ni tenant_id propio.
--     Conviene migrar a tenant-scoped en V2, pero no es PII crítica.
--   - forums, forum_threads, course_actas, course_grading_config,
--     course_schedules, certificates, ai_grading_queue, tutor_chat_sessions,
--     grade_cuts, course_certificate_settings, generated_contents,
--     report_templates: YA filtran por `EXISTS (course_teachers/enrollments)`,
--     por lo que se vuelven tenant-safe automáticamente una vez que
--     course_teachers y course_enrollments cierran (esta migración los
--     cierra).
-- ──────────────────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════════════════════
-- Helper: course_in_my_tenant(uuid)
-- ═══════════════════════════════════════════════════════════════════════
-- SECURITY DEFINER bypasea la RLS de courses al hacer el lookup interno
-- (evita recursión + funciona aunque las nuevas policies de courses
-- estén cerrando). STABLE permite que el planner cachée el resultado
-- dentro del mismo statement.
CREATE OR REPLACE FUNCTION public.course_in_my_tenant(_course_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.courses
    WHERE id = _course_id
      AND tenant_id = public.current_tenant_id()
  ) OR public.is_super_admin();
$$;
GRANT EXECUTE ON FUNCTION public.course_in_my_tenant(UUID) TO authenticated;

COMMENT ON FUNCTION public.course_in_my_tenant(UUID) IS
  'TRUE si _course_id pertenece al tenant del usuario actual, o si el usuario es SuperAdmin. Usado por las policies de tablas hijas que no tienen tenant_id propio.';

-- ═══════════════════════════════════════════════════════════════════════
-- 1) courses — la madre. Cerrar primero para que el helper sea efectivo.
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Courses viewable by authenticated" ON public.courses;
DROP POLICY IF EXISTS "Admins manage courses" ON public.courses;
DROP POLICY IF EXISTS "Docentes manage courses" ON public.courses;

CREATE POLICY "courses_select_in_tenant"
  ON public.courses FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());

CREATE POLICY "courses_admin_manage"
  ON public.courses FOR ALL TO authenticated
  USING (
    (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin'))
    OR public.is_super_admin()
  )
  WITH CHECK (
    (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin'))
    OR public.is_super_admin()
  );

CREATE POLICY "courses_docente_manage"
  ON public.courses FOR ALL TO authenticated
  USING (
    (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Docente'))
    OR public.is_super_admin()
  )
  WITH CHECK (
    (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Docente'))
    OR public.is_super_admin()
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 2) exams
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Authenticated view exams" ON public.exams;
DROP POLICY IF EXISTS "Docentes/Admins manage exams" ON public.exams;

CREATE POLICY "exams_select_in_tenant"
  ON public.exams FOR SELECT TO authenticated
  USING (public.course_in_my_tenant(course_id));

CREATE POLICY "exams_staff_manage"
  ON public.exams FOR ALL TO authenticated
  USING (
    public.course_in_my_tenant(course_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  )
  WITH CHECK (
    public.course_in_my_tenant(course_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 3) workshops
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Authenticated view workshops" ON public.workshops;
DROP POLICY IF EXISTS "Docentes/Admins manage workshops" ON public.workshops;

CREATE POLICY "workshops_select_in_tenant"
  ON public.workshops FOR SELECT TO authenticated
  USING (public.course_in_my_tenant(course_id));

CREATE POLICY "workshops_staff_manage"
  ON public.workshops FOR ALL TO authenticated
  USING (
    public.course_in_my_tenant(course_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  )
  WITH CHECK (
    public.course_in_my_tenant(course_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 4) projects
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Authenticated view projects" ON public.projects;
DROP POLICY IF EXISTS "Docentes/Admins manage projects" ON public.projects;

CREATE POLICY "projects_select_in_tenant"
  ON public.projects FOR SELECT TO authenticated
  USING (public.course_in_my_tenant(course_id));

CREATE POLICY "projects_staff_manage"
  ON public.projects FOR ALL TO authenticated
  USING (
    public.course_in_my_tenant(course_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  )
  WITH CHECK (
    public.course_in_my_tenant(course_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 5) attendance_sessions
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Authenticated view attendance sessions" ON public.attendance_sessions;
DROP POLICY IF EXISTS "Docentes/Admins manage attendance sessions" ON public.attendance_sessions;

CREATE POLICY "attendance_sessions_select_in_tenant"
  ON public.attendance_sessions FOR SELECT TO authenticated
  USING (public.course_in_my_tenant(course_id));

CREATE POLICY "attendance_sessions_staff_manage"
  ON public.attendance_sessions FOR ALL TO authenticated
  USING (
    public.course_in_my_tenant(course_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  )
  WITH CHECK (
    public.course_in_my_tenant(course_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 6) course_enrollments — crítico, muchas tablas hacen EXISTS aquí.
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Enrollments viewable by authenticated" ON public.course_enrollments;
DROP POLICY IF EXISTS "Admins manage enrollments" ON public.course_enrollments;
DROP POLICY IF EXISTS "Docentes manage enrollments" ON public.course_enrollments;

CREATE POLICY "enrollments_select_in_tenant"
  ON public.course_enrollments FOR SELECT TO authenticated
  USING (public.course_in_my_tenant(course_id));

CREATE POLICY "enrollments_admin_manage"
  ON public.course_enrollments FOR ALL TO authenticated
  USING (
    public.course_in_my_tenant(course_id)
    AND public.has_role(auth.uid(), 'Admin')
  )
  WITH CHECK (
    public.course_in_my_tenant(course_id)
    AND public.has_role(auth.uid(), 'Admin')
  );

CREATE POLICY "enrollments_docente_manage"
  ON public.course_enrollments FOR ALL TO authenticated
  USING (
    public.course_in_my_tenant(course_id)
    AND public.has_role(auth.uid(), 'Docente')
  )
  WITH CHECK (
    public.course_in_my_tenant(course_id)
    AND public.has_role(auth.uid(), 'Docente')
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 7) course_teachers — crítico, idem.
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Authenticated view course_teachers" ON public.course_teachers;
DROP POLICY IF EXISTS "Admins manage course_teachers" ON public.course_teachers;
DROP POLICY IF EXISTS "Docentes manage other course_teachers" ON public.course_teachers;

CREATE POLICY "course_teachers_select_in_tenant"
  ON public.course_teachers FOR SELECT TO authenticated
  USING (public.course_in_my_tenant(course_id));

CREATE POLICY "course_teachers_admin_manage"
  ON public.course_teachers FOR ALL TO authenticated
  USING (
    public.course_in_my_tenant(course_id)
    AND public.has_role(auth.uid(), 'Admin')
  )
  WITH CHECK (
    public.course_in_my_tenant(course_id)
    AND public.has_role(auth.uid(), 'Admin')
  );

-- Docente puede gestionar OTROS docentes (no a sí mismo) en cursos de
-- SU tenant. Igual semántica que la policy original.
CREATE POLICY "course_teachers_docente_manage_others"
  ON public.course_teachers FOR ALL TO authenticated
  USING (
    public.course_in_my_tenant(course_id)
    AND public.has_role(auth.uid(), 'Docente')
    AND user_id <> auth.uid()
  )
  WITH CHECK (
    public.course_in_my_tenant(course_id)
    AND public.has_role(auth.uid(), 'Docente')
    AND user_id <> auth.uid()
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 8) project_courses (join table)
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS project_courses_view_all_authenticated ON public.project_courses;
DROP POLICY IF EXISTS project_courses_manage_teachers_admins ON public.project_courses;

CREATE POLICY "project_courses_select_in_tenant"
  ON public.project_courses FOR SELECT TO authenticated
  USING (public.course_in_my_tenant(course_id));

CREATE POLICY "project_courses_staff_manage"
  ON public.project_courses FOR ALL TO authenticated
  USING (
    public.course_in_my_tenant(course_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  )
  WITH CHECK (
    public.course_in_my_tenant(course_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 9) workshop_courses (join table)
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS workshop_courses_view_all_authenticated ON public.workshop_courses;
DROP POLICY IF EXISTS workshop_courses_manage_teachers_admins ON public.workshop_courses;

CREATE POLICY "workshop_courses_select_in_tenant"
  ON public.workshop_courses FOR SELECT TO authenticated
  USING (public.course_in_my_tenant(course_id));

CREATE POLICY "workshop_courses_staff_manage"
  ON public.workshop_courses FOR ALL TO authenticated
  USING (
    public.course_in_my_tenant(course_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin') OR public.is_super_admin())
  )
  WITH CHECK (
    public.course_in_my_tenant(course_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin') OR public.is_super_admin())
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 10) ai_model_settings (tenant_id propio)
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS ai_model_settings_read ON public.ai_model_settings;

CREATE POLICY "ai_model_settings_read"
  ON public.ai_model_settings FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());

-- ═══════════════════════════════════════════════════════════════════════
-- 11) ai_prompts (tenant_id propio)
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS ai_prompts_admin_global ON public.ai_prompts;
DROP POLICY IF EXISTS ai_prompts_teacher_course ON public.ai_prompts;

-- Read abierto a authenticated de su tenant — el cliente lo consulta
-- libremente para resolver prompts efectivos.
CREATE POLICY "ai_prompts_read_tenant"
  ON public.ai_prompts FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());

-- Admin gestiona prompts globales (course_id IS NULL) DE SU tenant.
CREATE POLICY "ai_prompts_admin_global"
  ON public.ai_prompts FOR ALL TO authenticated
  USING (
    course_id IS NULL
    AND tenant_id = public.current_tenant_id()
    AND public.has_role(auth.uid(), 'Admin')
  )
  WITH CHECK (
    course_id IS NULL
    AND tenant_id = public.current_tenant_id()
    AND public.has_role(auth.uid(), 'Admin')
  );

-- Admin del tenant o Docente del curso gestiona overrides per-course.
CREATE POLICY "ai_prompts_teacher_course"
  ON public.ai_prompts FOR ALL TO authenticated
  USING (
    course_id IS NOT NULL
    AND tenant_id = public.current_tenant_id()
    AND (
      public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = ai_prompts.course_id
          AND ct.user_id = auth.uid()
      )
    )
  )
  WITH CHECK (
    course_id IS NOT NULL
    AND tenant_id = public.current_tenant_id()
    AND (
      public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = ai_prompts.course_id
          AND ct.user_id = auth.uid()
      )
    )
  );

-- Bypass SuperAdmin (cross-tenant)
CREATE POLICY "ai_prompts_super_admin_all"
  ON public.ai_prompts FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- ═══════════════════════════════════════════════════════════════════════
-- 12) app_settings (tenant_id propio, singleton-per-tenant)
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS app_settings_write ON public.app_settings;

CREATE POLICY "app_settings_select_in_tenant"
  ON public.app_settings FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());

CREATE POLICY "app_settings_admin_manage"
  ON public.app_settings FOR ALL TO authenticated
  USING (
    (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin'))
    OR public.is_super_admin()
  )
  WITH CHECK (
    (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin'))
    OR public.is_super_admin()
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 13) certificate_settings (tenant_id propio, singleton-per-tenant)
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS certificate_settings_write ON public.certificate_settings;

CREATE POLICY "certificate_settings_select_in_tenant"
  ON public.certificate_settings FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());

CREATE POLICY "certificate_settings_admin_manage"
  ON public.certificate_settings FOR ALL TO authenticated
  USING (
    (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin'))
    OR public.is_super_admin()
  )
  WITH CHECK (
    (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin'))
    OR public.is_super_admin()
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 14) notifications — Admin podía leer notifs de cualquier tenant.
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS notifications_select_recipient_or_admin ON public.notifications;

CREATE POLICY "notifications_select_recipient_or_admin"
  ON public.notifications FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR (
      public.has_role(auth.uid(), 'Admin')
      AND tenant_id = public.current_tenant_id()
    )
    OR public.is_super_admin()
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 15) module_visibility — `USING true` deja ver overrides de otros tenants.
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS module_visibility_read_all ON public.module_visibility;

CREATE POLICY "module_visibility_read"
  ON public.module_visibility FOR SELECT TO authenticated
  USING (
    -- Filas globales (tenant_id IS NULL) son la default-config de la
    -- plataforma → visibles a todos.
    tenant_id IS NULL
    -- Filas de override per-tenant → solo a usuarios de ese tenant.
    OR tenant_id = public.current_tenant_id()
    -- SuperAdmin ve todo.
    OR public.is_super_admin()
  );

NOTIFY pgrst, 'reload schema';
