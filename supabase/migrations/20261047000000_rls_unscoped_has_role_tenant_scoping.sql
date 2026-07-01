-- ══════════════════════════════════════════════════════════════════════
-- RLS: scope de tenant en policies con has_role() suelto (workflow validación).
--
-- Barrido sistemático de pg_policies contra prod: policies con una rama de staff
-- (`has_role(auth.uid(),'Admin'/'Docente')`) SIN scope de tenant. Se verificó cada
-- una empíricamente contra prod (SET LOCAL ROLE authenticated + jwt claims) para
-- distinguir dos clases:
--
-- (A) LEAK CROSS-TENANT REAL — la rama has_role es TOP-LEVEL (no está detrás de un
--     subquery sobre una tabla con RLS ya tenant-scopeada), así que un Admin/Docente
--     de otro tenant ve/edita filas ajenas:
--   1. ai_override_activations SELECT — CONFIRMADO CON DATOS: un Admin de FESNA veía
--      las 8 activaciones (todas de otros tenants). Fix: Admin acotado al tenant del
--      user dueño (profiles.tenant_id = current_tenant_id()) + is_super_admin().
--   2. poll_calendar_events SELECT — mismo scoping que su policy WRITE (ya correcta):
--      Admin acotado al tenant del curso del poll + is_super_admin(). (0 filas hoy.)
--   3. forum_replies DELETE — rama Admin de moderación acotada al tenant del curso
--      del hilo (is_admin_of_course_tenant(thread.course_id)). (0 filas hoy.)
--   4. error_event_status (ALL) — Admin acotado al tenant del audit_log referido
--      (mismo criterio que la RLS de audit_logs, mig 20260528010000). (0 filas hoy.)
--
-- (B) DEFENSA EN PROFUNDIDAD — la rama has_role está DENTRO de un subquery sobre una
--     tabla cuya RLS YA es tenant-scopeada, así que hoy NO hay leak (verificado: el
--     subquery hereda esa RLS). Pero la rama suelta es frágil (si cambia la RLS del
--     padre reaparece el leak) y reaparece como falso positivo en cada auditoría, así
--     que la hacemos explícita:
--   5. tutor_chat_messages SELECT — verificado: Admin de FESNA ve sus 12 mensajes, NO
--      los 2 de uniaj (protegido por tutor_chat_sessions RLS). Fix: mismo scoping que
--      la sesión (has_role('Admin') AND course_in_my_tenant(s.course_id)).
--   6. project_submission_files (SELECT/INSERT/UPDATE/DELETE) — verificado: Admin+Docente
--      de FESNA ve 0 de las 52 psf de uniaj (protegido por project_submissions RLS,
--      mig 20260820). Fix: staff acotado al curso del proyecto.
--   7. project_submission_attachments (SELECT/INSERT/DELETE) — idem, un hop más profundo.
--
-- Fix MÍNIMO: se preserva EXACTO el acceso de dueño/estudiante y solo se acota la
-- rama de staff. No se expande a miembros de grupo (comportamiento pre-existente).
-- Idempotente + guards to_regclass.
-- ══════════════════════════════════════════════════════════════════════

-- ─── 1. ai_override_activations SELECT ────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.ai_override_activations') IS NOT NULL THEN
    DROP POLICY IF EXISTS ai_override_activations_select ON public.ai_override_activations;
    CREATE POLICY ai_override_activations_select ON public.ai_override_activations
      FOR SELECT USING (
        user_id = auth.uid()
        OR (
          public.has_role(auth.uid(), 'Admin') AND EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = ai_override_activations.user_id
              AND p.tenant_id = public.current_tenant_id()
          )
        )
        OR public.is_super_admin()
      );
  END IF;
END $$;

-- ─── 2. poll_calendar_events SELECT ───────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.poll_calendar_events') IS NOT NULL THEN
    DROP POLICY IF EXISTS poll_calendar_events_select ON public.poll_calendar_events;
    CREATE POLICY poll_calendar_events_select ON public.poll_calendar_events
      FOR SELECT USING (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.poll_courses pc
          JOIN public.course_teachers ct ON ct.course_id = pc.course_id
          WHERE pc.poll_id = poll_calendar_events.poll_id AND ct.user_id = auth.uid()
        )
        OR (
          public.has_role(auth.uid(), 'Admin') AND EXISTS (
            SELECT 1 FROM public.poll_courses pc
            JOIN public.courses c ON c.id = pc.course_id
            WHERE pc.poll_id = poll_calendar_events.poll_id
              AND c.tenant_id = public.current_tenant_id()
          )
        )
        OR public.is_super_admin()
      );
  END IF;
END $$;

-- ─── 3. tutor_chat_messages SELECT ────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.tutor_chat_messages') IS NOT NULL THEN
    DROP POLICY IF EXISTS tutor_messages_select ON public.tutor_chat_messages;
    CREATE POLICY tutor_messages_select ON public.tutor_chat_messages
      FOR SELECT USING (
        EXISTS (
          SELECT 1 FROM public.tutor_chat_sessions s
          WHERE s.id = tutor_chat_messages.session_id
            AND (
              s.user_id = auth.uid()
              OR (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(s.course_id))
              OR EXISTS (
                SELECT 1 FROM public.course_teachers
                WHERE course_teachers.course_id = s.course_id AND course_teachers.user_id = auth.uid()
              )
              OR public.is_super_admin()
            )
        )
      );
  END IF;
END $$;

-- ─── 4. forum_replies DELETE ──────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.forum_replies') IS NOT NULL THEN
    DROP POLICY IF EXISTS forum_replies_delete ON public.forum_replies;
    CREATE POLICY forum_replies_delete ON public.forum_replies
      FOR DELETE USING (
        author_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.forum_threads t
          JOIN public.course_teachers ct ON ct.course_id = t.course_id
          WHERE t.id = forum_replies.thread_id AND ct.user_id = auth.uid()
        )
        OR EXISTS (
          SELECT 1 FROM public.forum_threads t
          WHERE t.id = forum_replies.thread_id
            AND public.is_admin_of_course_tenant(t.course_id)
        )
      );
  END IF;
END $$;

-- ─── 5. project_submission_files (SELECT / INSERT / UPDATE / DELETE) ───
DO $$
BEGIN
  IF to_regclass('public.project_submission_files') IS NOT NULL THEN
    -- SELECT: dueño de la entrega o staff DEL CURSO del proyecto.
    DROP POLICY IF EXISTS project_sub_files_owner_or_staff_select ON public.project_submission_files;
    CREATE POLICY project_sub_files_owner_or_staff_select ON public.project_submission_files
      FOR SELECT USING (
        public.is_super_admin()
        OR EXISTS (
          SELECT 1 FROM public.project_submissions ps
          WHERE ps.id = project_submission_files.submission_id
            AND (
              ps.user_id = auth.uid()
              OR EXISTS (
                SELECT 1 FROM public.projects p
                JOIN public.course_teachers ct ON ct.course_id = p.course_id
                WHERE p.id = ps.project_id AND ct.user_id = auth.uid()
              )
              OR EXISTS (
                SELECT 1 FROM public.projects p
                WHERE p.id = ps.project_id AND public.is_admin_of_course_tenant(p.course_id)
              )
            )
        )
      );

    -- INSERT: dueño o staff del curso.
    DROP POLICY IF EXISTS project_sub_files_owner_or_staff_insert ON public.project_submission_files;
    CREATE POLICY project_sub_files_owner_or_staff_insert ON public.project_submission_files
      FOR INSERT WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.project_submissions ps
          WHERE ps.id = project_submission_files.submission_id
            AND (
              ps.user_id = auth.uid()
              OR EXISTS (
                SELECT 1 FROM public.projects p
                JOIN public.course_teachers ct ON ct.course_id = p.course_id
                WHERE p.id = ps.project_id AND ct.user_id = auth.uid()
              )
              OR EXISTS (
                SELECT 1 FROM public.projects p
                WHERE p.id = ps.project_id AND public.is_admin_of_course_tenant(p.course_id)
              )
            )
        )
      );

    -- UPDATE: dueño o staff del curso.
    DROP POLICY IF EXISTS project_sub_files_owner_or_staff_update ON public.project_submission_files;
    CREATE POLICY project_sub_files_owner_or_staff_update ON public.project_submission_files
      FOR UPDATE USING (
        EXISTS (
          SELECT 1 FROM public.project_submissions ps
          WHERE ps.id = project_submission_files.submission_id
            AND (
              ps.user_id = auth.uid()
              OR EXISTS (
                SELECT 1 FROM public.projects p
                JOIN public.course_teachers ct ON ct.course_id = p.course_id
                WHERE p.id = ps.project_id AND ct.user_id = auth.uid()
              )
              OR EXISTS (
                SELECT 1 FROM public.projects p
                WHERE p.id = ps.project_id AND public.is_admin_of_course_tenant(p.course_id)
              )
            )
        )
      );

    -- DELETE: solo staff DEL CURSO (preserva: el estudiante no borra archivos ya entregados).
    DROP POLICY IF EXISTS project_sub_files_staff_delete ON public.project_submission_files;
    CREATE POLICY project_sub_files_staff_delete ON public.project_submission_files
      FOR DELETE USING (
        EXISTS (
          SELECT 1 FROM public.project_submissions ps
          WHERE ps.id = project_submission_files.submission_id
            AND (
              EXISTS (
                SELECT 1 FROM public.projects p
                JOIN public.course_teachers ct ON ct.course_id = p.course_id
                WHERE p.id = ps.project_id AND ct.user_id = auth.uid()
              )
              OR EXISTS (
                SELECT 1 FROM public.projects p
                WHERE p.id = ps.project_id AND public.is_admin_of_course_tenant(p.course_id)
              )
            )
        )
      );
  END IF;
END $$;

-- ─── 6. project_submission_attachments (SELECT / INSERT / DELETE) ──────
DO $$
BEGIN
  IF to_regclass('public.project_submission_attachments') IS NOT NULL THEN
    -- SELECT: dueño de la entrega o staff del curso del proyecto.
    DROP POLICY IF EXISTS psa_select_owner_or_staff ON public.project_submission_attachments;
    CREATE POLICY psa_select_owner_or_staff ON public.project_submission_attachments
      FOR SELECT USING (
        EXISTS (
          SELECT 1 FROM public.project_submission_files psf
          JOIN public.project_submissions ps ON ps.id = psf.submission_id
          WHERE psf.id = project_submission_attachments.project_submission_file_id
            AND (
              ps.user_id = auth.uid()
              OR EXISTS (
                SELECT 1 FROM public.projects p
                JOIN public.course_teachers ct ON ct.course_id = p.course_id
                WHERE p.id = ps.project_id AND ct.user_id = auth.uid()
              )
              OR EXISTS (
                SELECT 1 FROM public.projects p
                WHERE p.id = ps.project_id AND public.is_admin_of_course_tenant(p.course_id)
              )
            )
        )
      );

    -- INSERT: dueño o staff del curso.
    DROP POLICY IF EXISTS psa_insert_owner_or_staff ON public.project_submission_attachments;
    CREATE POLICY psa_insert_owner_or_staff ON public.project_submission_attachments
      FOR INSERT WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.project_submission_files psf
          JOIN public.project_submissions ps ON ps.id = psf.submission_id
          WHERE psf.id = project_submission_attachments.project_submission_file_id
            AND (
              ps.user_id = auth.uid()
              OR EXISTS (
                SELECT 1 FROM public.projects p
                JOIN public.course_teachers ct ON ct.course_id = p.course_id
                WHERE p.id = ps.project_id AND ct.user_id = auth.uid()
              )
              OR EXISTS (
                SELECT 1 FROM public.projects p
                WHERE p.id = ps.project_id AND public.is_admin_of_course_tenant(p.course_id)
              )
            )
        )
      );

    -- DELETE: dueño o staff del curso.
    DROP POLICY IF EXISTS psa_delete_owner_or_staff ON public.project_submission_attachments;
    CREATE POLICY psa_delete_owner_or_staff ON public.project_submission_attachments
      FOR DELETE USING (
        EXISTS (
          SELECT 1 FROM public.project_submission_files psf
          JOIN public.project_submissions ps ON ps.id = psf.submission_id
          WHERE psf.id = project_submission_attachments.project_submission_file_id
            AND (
              ps.user_id = auth.uid()
              OR EXISTS (
                SELECT 1 FROM public.projects p
                JOIN public.course_teachers ct ON ct.course_id = p.course_id
                WHERE p.id = ps.project_id AND ct.user_id = auth.uid()
              )
              OR EXISTS (
                SELECT 1 FROM public.projects p
                WHERE p.id = ps.project_id AND public.is_admin_of_course_tenant(p.course_id)
              )
            )
        )
      );
  END IF;
END $$;

-- ─── 7. error_event_status (ALL) — Admin acotado al tenant del audit_log ──────
-- El estado de revisión de un error cuelga de audit_logs (audit_log_id), cuya RLS
-- ya acota al Admin a su tenant (mig 20260528010000). La policy suelta dejaba a un
-- Admin gestionar el estado de errores de audit_logs de OTRO tenant. Se acota igual
-- que audit_logs; los errores sin tenant (logueados por service_role) quedan SA-only.
DO $$
BEGIN
  IF to_regclass('public.error_event_status') IS NOT NULL THEN
    DROP POLICY IF EXISTS error_event_status_manage ON public.error_event_status;
    CREATE POLICY error_event_status_manage ON public.error_event_status
      FOR ALL
      USING (
        public.is_super_admin()
        OR (
          public.has_role(auth.uid(), 'Admin') AND EXISTS (
            SELECT 1 FROM public.audit_logs a
            WHERE a.id = error_event_status.audit_log_id
              AND a.tenant_id = public.current_tenant_id()
          )
        )
      )
      WITH CHECK (
        public.is_super_admin()
        OR (
          public.has_role(auth.uid(), 'Admin') AND EXISTS (
            SELECT 1 FROM public.audit_logs a
            WHERE a.id = error_event_status.audit_log_id
              AND a.tenant_id = public.current_tenant_id()
          )
        )
      );
  END IF;
END $$;
