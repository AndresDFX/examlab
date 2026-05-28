-- ──────────────────────────────────────────────────────────────────────
-- Multi-tenancy RLS fix — V2.
--
-- El fix v1 (20260528000000) cerró `courses` + 14 tablas hijas, pero
-- quedaron varias tablas con el patrón `OR has_role(Admin)` (cross-tenant)
-- que no entraron en la auditoría original porque YA tenían membresía
-- en sus policies (EXISTS course_teachers/enrollments). El bypass por
-- has_role(Admin) sin tenant scope seguía siendo una fuga.
--
-- Esta migración cierra:
--   1. audit_logs: el policy actual acepta `tenant_id IS NULL` para
--      cualquier Admin → eventos de "sistema" (correos) sin tenant
--      quedan visibles cross-tenant. Restringimos NULL solo a SuperAdmin.
--   2. certificates, ai_grading_queue, course_actas, course_grading_config,
--      course_schedules, course_certificate_settings, forums, forum_threads,
--      tutor_chat_sessions, generated_contents, grade_cuts: tighten
--      `OR has_role(Admin)` to `OR (has_role(Admin) AND course_in_my_tenant(course_id))`.
--   3. report_templates: separa global (platform-wide, solo SuperAdmin
--      escribe) de course-specific (filtra por tenant del curso) y
--      private (solo el owner — Admin ya no puede ver privados ajenos).
--
-- Tablas todavía deferidas:
--   - videos: biblioteca global por diseño. Requiere agregar tenant_id
--     en otra migración si se quiere scope per-tenant.
-- ──────────────────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════════════════════
-- 1) audit_logs — cerrar el agujero de tenant_id IS NULL
-- ═══════════════════════════════════════════════════════════════════════
-- Eventos de "sistema" (sin actor_id) tenían tenant_id NULL y el policy
-- los exponía a Admin de cualquier tenant. Ahora NULL solo lo ve
-- SuperAdmin; eventos del sistema sin tenant son metadatos de plataforma.
DROP POLICY IF EXISTS "audit_logs_admin_select" ON public.audit_logs;
CREATE POLICY "audit_logs_admin_select" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (
    (public.has_role(auth.uid(), 'Admin') AND tenant_id = public.current_tenant_id())
    OR public.is_super_admin()
  );

-- audit_logs_teacher_select ya tenía tenant filter sano (sin el NULL bypass).
-- Pero por consistencia, también quitamos el NULL allowance ahí.
DROP POLICY IF EXISTS "audit_logs_teacher_select" ON public.audit_logs;
CREATE POLICY "audit_logs_teacher_select" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'Docente')
    AND tenant_id = public.current_tenant_id()
    AND (
      course_id IN (
        SELECT course_id FROM public.course_teachers WHERE user_id = auth.uid()
      )
      OR actor_id = auth.uid()
    )
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 2) certificates
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS certificates_select ON public.certificates;
CREATE POLICY "certificates_select"
  ON public.certificates FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(course_id))
    OR EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = certificates.course_id
        AND ct.user_id = auth.uid()
    )
    OR public.is_super_admin()
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 3) ai_grading_queue
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS ai_grading_queue_select ON public.ai_grading_queue;
CREATE POLICY "ai_grading_queue_select"
  ON public.ai_grading_queue FOR SELECT TO authenticated
  USING (
    (public.has_role(auth.uid(), 'Admin') AND (
       course_id IS NULL  -- jobs huérfanos sin curso: solo Admin del mismo "scope" plataforma
       OR public.course_in_my_tenant(course_id)
    ))
    OR created_by = auth.uid()
    OR (
      course_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = ai_grading_queue.course_id
          AND ct.user_id = auth.uid()
      )
    )
    OR public.is_super_admin()
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 4) course_actas
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS course_actas_read ON public.course_actas;
CREATE POLICY "course_actas_read"
  ON public.course_actas FOR SELECT TO authenticated
  USING (
    (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(course_id))
    OR EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = course_actas.course_id
        AND ct.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.course_enrollments ce
      WHERE ce.course_id = course_actas.course_id
        AND ce.user_id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS course_actas_delete ON public.course_actas;
CREATE POLICY "course_actas_delete"
  ON public.course_actas FOR DELETE TO authenticated
  USING (
    (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(course_id))
    OR generated_by = auth.uid()
    OR public.is_super_admin()
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 5) course_certificate_settings
-- ═══════════════════════════════════════════════════════════════════════
-- `ccs_select` era `USING (true)` — totalmente abierta.
DROP POLICY IF EXISTS ccs_select ON public.course_certificate_settings;
CREATE POLICY "ccs_select"
  ON public.course_certificate_settings FOR SELECT TO authenticated
  USING (public.course_in_my_tenant(course_id));

DROP POLICY IF EXISTS ccs_write ON public.course_certificate_settings;
CREATE POLICY "ccs_write"
  ON public.course_certificate_settings FOR ALL TO authenticated
  USING (
    public.course_in_my_tenant(course_id)
    AND (
      public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = course_certificate_settings.course_id
          AND ct.user_id = auth.uid()
      )
    )
  )
  WITH CHECK (
    public.course_in_my_tenant(course_id)
    AND (
      public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = course_certificate_settings.course_id
          AND ct.user_id = auth.uid()
      )
    )
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 6) course_grading_config
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS cgc_admin_all ON public.course_grading_config;
CREATE POLICY "cgc_admin_all"
  ON public.course_grading_config FOR ALL TO authenticated
  USING (
    (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(course_id))
    OR public.is_super_admin()
  )
  WITH CHECK (
    (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(course_id))
    OR public.is_super_admin()
  );

-- cgc_student_read y cgc_teacher_of_course ya filtraban por membresía
-- (EXISTS course_enrollments / course_teachers). Esas membresías ya
-- están tenant-scopeadas vía v1. No requieren cambio.

-- ═══════════════════════════════════════════════════════════════════════
-- 7) course_schedules
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS course_schedules_read ON public.course_schedules;
CREATE POLICY "course_schedules_read"
  ON public.course_schedules FOR SELECT TO authenticated
  USING (
    (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(course_id))
    OR EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = course_schedules.course_id
        AND ct.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.course_enrollments ce
      WHERE ce.course_id = course_schedules.course_id
        AND ce.user_id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS course_schedules_write ON public.course_schedules;
CREATE POLICY "course_schedules_write"
  ON public.course_schedules FOR ALL TO authenticated
  USING (
    public.course_in_my_tenant(course_id)
    AND (
      public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = course_schedules.course_id
          AND ct.user_id = auth.uid()
      )
    )
  )
  WITH CHECK (
    public.course_in_my_tenant(course_id)
    AND (
      public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = course_schedules.course_id
          AND ct.user_id = auth.uid()
      )
    )
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 8) forums
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS forums_select ON public.forums;
CREATE POLICY "forums_select"
  ON public.forums FOR SELECT TO authenticated
  USING (
    (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(course_id))
    OR EXISTS (
      SELECT 1 FROM public.course_teachers
      WHERE course_teachers.course_id = forums.course_id
        AND course_teachers.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.course_enrollments
      WHERE course_enrollments.course_id = forums.course_id
        AND course_enrollments.user_id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS forums_update_teacher ON public.forums;
CREATE POLICY "forums_update_teacher"
  ON public.forums FOR UPDATE TO authenticated
  USING (
    public.course_in_my_tenant(course_id)
    AND (
      public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers
        WHERE course_teachers.course_id = forums.course_id
          AND course_teachers.user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS forums_delete_teacher ON public.forums;
CREATE POLICY "forums_delete_teacher"
  ON public.forums FOR DELETE TO authenticated
  USING (
    public.course_in_my_tenant(course_id)
    AND (
      public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers
        WHERE course_teachers.course_id = forums.course_id
          AND course_teachers.user_id = auth.uid()
      )
    )
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 9) forum_threads
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS forum_threads_select ON public.forum_threads;
CREATE POLICY "forum_threads_select"
  ON public.forum_threads FOR SELECT TO authenticated
  USING (
    (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(course_id))
    OR EXISTS (
      SELECT 1 FROM public.course_teachers
      WHERE course_teachers.course_id = forum_threads.course_id
        AND course_teachers.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.course_enrollments
      WHERE course_enrollments.course_id = forum_threads.course_id
        AND course_enrollments.user_id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS forum_threads_update ON public.forum_threads;
CREATE POLICY "forum_threads_update"
  ON public.forum_threads FOR UPDATE TO authenticated
  USING (
    public.course_in_my_tenant(course_id)
    AND (
      author_id = auth.uid()
      OR public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers
        WHERE course_teachers.course_id = forum_threads.course_id
          AND course_teachers.user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS forum_threads_delete ON public.forum_threads;
CREATE POLICY "forum_threads_delete"
  ON public.forum_threads FOR DELETE TO authenticated
  USING (
    public.course_in_my_tenant(course_id)
    AND (
      author_id = auth.uid()
      OR public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers
        WHERE course_teachers.course_id = forum_threads.course_id
          AND course_teachers.user_id = auth.uid()
      )
    )
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 10) tutor_chat_sessions
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS tutor_sessions_select ON public.tutor_chat_sessions;
CREATE POLICY "tutor_sessions_select"
  ON public.tutor_chat_sessions FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(course_id))
    OR EXISTS (
      SELECT 1 FROM public.course_teachers
      WHERE course_teachers.course_id = tutor_chat_sessions.course_id
        AND course_teachers.user_id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS tutor_sessions_update ON public.tutor_chat_sessions;
CREATE POLICY "tutor_sessions_update"
  ON public.tutor_chat_sessions FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid()
    OR (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(course_id))
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS tutor_sessions_delete ON public.tutor_chat_sessions;
CREATE POLICY "tutor_sessions_delete"
  ON public.tutor_chat_sessions FOR DELETE TO authenticated
  USING (
    user_id = auth.uid()
    OR (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(course_id))
    OR public.is_super_admin()
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 11) generated_contents
-- ═══════════════════════════════════════════════════════════════════════
-- course_id es NULLABLE en esta tabla. Si NULL, dueño es teacher_id.
DROP POLICY IF EXISTS generated_contents_owner ON public.generated_contents;
CREATE POLICY "generated_contents_owner"
  ON public.generated_contents FOR ALL TO authenticated
  USING (
    teacher_id = auth.uid()
    OR (
      public.has_role(auth.uid(), 'Admin')
      AND (course_id IS NULL OR public.course_in_my_tenant(course_id))
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    teacher_id = auth.uid()
    OR (
      public.has_role(auth.uid(), 'Admin')
      AND (course_id IS NULL OR public.course_in_my_tenant(course_id))
    )
    OR public.is_super_admin()
  );

-- generated_contents_student_via_session ya filtra por membresía
-- (attendance_sessions JOIN course_enrollments). Tenant-safe.

-- ═══════════════════════════════════════════════════════════════════════
-- 12) grade_cuts
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS cuts_admin_all ON public.grade_cuts;
CREATE POLICY "cuts_admin_all"
  ON public.grade_cuts FOR ALL TO authenticated
  USING (
    (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(course_id))
    OR public.is_super_admin()
  )
  WITH CHECK (
    (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(course_id))
    OR public.is_super_admin()
  );

-- cuts_student_read y cuts_teacher_of_course ya estaban filtradas por
-- membership. Tenant-safe.

-- ═══════════════════════════════════════════════════════════════════════
-- 13) report_templates
-- ═══════════════════════════════════════════════════════════════════════
-- Tres tipos:
--   A. Globales de plataforma (owner_id NULL + course_id NULL): solo
--      SuperAdmin escribe. Cualquier authenticated puede LEER (defaults).
--   B. Privadas (owner_id NOT NULL): solo el owner. Admin de tenant
--      ya no las ve (eran un leak hacia privacidad de docentes ajenos).
--   C. Override per-course (course_id NOT NULL): tenant-scopeada via
--      course_in_my_tenant + Admin del tenant o Docente del curso.
DROP POLICY IF EXISTS report_templates_read ON public.report_templates;
DROP POLICY IF EXISTS report_templates_admin_global ON public.report_templates;
DROP POLICY IF EXISTS report_templates_owner_private ON public.report_templates;
DROP POLICY IF EXISTS report_templates_teacher_override ON public.report_templates;

-- Read:
CREATE POLICY "report_templates_read"
  ON public.report_templates FOR SELECT TO authenticated
  USING (
    -- A. Globales platform-wide: todos pueden leer (defaults)
    (owner_id IS NULL AND course_id IS NULL)
    -- B. Privadas: solo el owner
    OR owner_id = auth.uid()
    -- C. Course-specific: leíbles por Admin del tenant o docentes del curso
    OR (
      course_id IS NOT NULL
      AND public.course_in_my_tenant(course_id)
      AND (
        public.has_role(auth.uid(), 'Admin')
        OR EXISTS (
          SELECT 1 FROM public.course_teachers ct
          WHERE ct.course_id = report_templates.course_id
            AND ct.user_id = auth.uid()
        )
      )
    )
    OR public.is_super_admin()
  );

-- Write A: Globales platform-wide → solo SuperAdmin (antes era cualquier Admin)
CREATE POLICY "report_templates_admin_global"
  ON public.report_templates FOR ALL TO authenticated
  USING (
    owner_id IS NULL AND course_id IS NULL AND public.is_super_admin()
  )
  WITH CHECK (
    owner_id IS NULL AND course_id IS NULL AND public.is_super_admin()
  );

-- Write B: Privadas → solo el owner (sin OR Admin)
CREATE POLICY "report_templates_owner_private"
  ON public.report_templates FOR ALL TO authenticated
  USING (
    owner_id IS NOT NULL AND owner_id = auth.uid()
  )
  WITH CHECK (
    owner_id IS NOT NULL AND owner_id = auth.uid()
  );

-- Write C: Course-specific overrides → Admin del tenant o docente del curso
CREATE POLICY "report_templates_teacher_override"
  ON public.report_templates FOR ALL TO authenticated
  USING (
    owner_id IS NULL
    AND course_id IS NOT NULL
    AND parent_id IS NOT NULL
    AND public.course_in_my_tenant(course_id)
    AND (
      public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = report_templates.course_id
          AND ct.user_id = auth.uid()
      )
    )
  )
  WITH CHECK (
    owner_id IS NULL
    AND course_id IS NOT NULL
    AND parent_id IS NOT NULL
    AND public.course_in_my_tenant(course_id)
    AND (
      public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = report_templates.course_id
          AND ct.user_id = auth.uid()
      )
    )
  );

-- SuperAdmin bypass for write
CREATE POLICY "report_templates_super_admin_all"
  ON public.report_templates FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

NOTIFY pgrst, 'reload schema';
