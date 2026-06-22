-- ============================================================================
-- Tenant scoping round 4 — leaks cross-tenant remanentes.
--
-- Detectados por un barrido de TODAS las pg_policies (322) buscando el
-- anti-patrón `has_role()`/`USING(true)` sin scope de tenant, y CONFIRMADOS
-- empíricamente simulando sesiones reales bajo RLS contra producción:
--   - teacher_google_tokens: un Admin de CUALQUIER tenant leía/editaba los
--     tokens OAuth de Google de docentes de OTRO tenant (exposición de
--     credenciales — verificado: Admin de tenant X veía los 2/2 tokens).
--   - attendance_check_in_state: un Docente de otro tenant leía la SEED de los
--     códigos QR de asistencia → podía forjar códigos (verificado: veía 2/2).
--   - exam_notes: lectura/edición cross-tenant de notas de examen del docente
--     (la rama `has_role('Admin')` global + dos policies bare "Teachers...").
--   - submissions / workshop_submissions / project_submissions: las policies
--     de WRITE (insert/update/delete) "Docentes/Admins ..." quedaron con
--     `has_role` global (la mig 20260820 scopeó SELECT pero no dropeó estas) →
--     un staff de otro tenant podía insertar/editar/BORRAR entregas ajenas.
--   - project_assignments: gestión con `has_role` global.
--
-- Patrón de fix: atar cada rama de rol al tenant del curso vía los helpers
-- existentes (is_admin_of_course_tenant incluye SA; attendance_session_in_my_tenant;
-- project_in_my_tenant; joins a course_teachers). Las policies *_select/_insert/
-- _update scopeadas de 20260820 cubren el acceso legítimo; acá se cierran las
-- ramas que faltaban. Defensivo con to_regclass.
--
-- NO incluidas (decisión / requieren más análisis, anotadas para follow-up):
--   - ai_override_codes: NO tiene tenant_id/course_id — es global (códigos IA);
--     el acceso Admin global es tema de privilegio, no de leak de datos por
--     tenant. Necesita decisión de producto (¿per-tenant?).
--   - grade_cut_items: derivar el tenant exige cut_id→grade_cuts→course; se
--     posterga para no acoplar a un esquema no verificado en esta pasada.
--   - email_settings/system_settings/platform_settings/content_brand_config/
--     cron_job_descriptions: globales por diseño (SELECT abierto a propósito).
-- ============================================================================

-- ── 1) teacher_google_tokens ──
DO $$ BEGIN
  IF to_regclass('public.teacher_google_tokens') IS NULL THEN RAISE NOTICE 'skip teacher_google_tokens'; RETURN; END IF;
  EXECUTE 'DROP POLICY IF EXISTS "tgt_owner_all" ON public.teacher_google_tokens';
  EXECUTE $P$
    CREATE POLICY "tgt_owner_all" ON public.teacher_google_tokens FOR ALL TO authenticated
    USING (
      teacher_id = auth.uid()
      OR public.is_super_admin()
      OR (public.has_role(auth.uid(),'Admin') AND EXISTS (
            SELECT 1 FROM public.profiles p
             WHERE p.id = teacher_google_tokens.teacher_id
               AND p.tenant_id = public.current_tenant_id()))
    )
    WITH CHECK (
      teacher_id = auth.uid()
      OR public.is_super_admin()
      OR (public.has_role(auth.uid(),'Admin') AND EXISTS (
            SELECT 1 FROM public.profiles p
             WHERE p.id = teacher_google_tokens.teacher_id
               AND p.tenant_id = public.current_tenant_id()))
    )
  $P$;
END $$;

-- ── 2) attendance_check_in_state ──
DO $$ BEGIN
  IF to_regclass('public.attendance_check_in_state') IS NULL THEN RAISE NOTICE 'skip attendance_check_in_state'; RETURN; END IF;
  EXECUTE 'DROP POLICY IF EXISTS "check_in_state_teacher_admin" ON public.attendance_check_in_state';
  EXECUTE $P$
    CREATE POLICY "check_in_state_teacher_admin" ON public.attendance_check_in_state FOR ALL TO authenticated
    USING (
      public.attendance_session_in_my_tenant(session_id)
      AND (public.has_role(auth.uid(),'Docente') OR public.has_role(auth.uid(),'Admin'))
    )
    WITH CHECK (
      public.attendance_session_in_my_tenant(session_id)
      AND (public.has_role(auth.uid(),'Docente') OR public.has_role(auth.uid(),'Admin'))
    )
  $P$;
END $$;

-- ── 3) exam_notes — drop policies bare + reescribe select/update sin has_role global ──
DO $$ BEGIN
  IF to_regclass('public.exam_notes') IS NULL THEN RAISE NOTICE 'skip exam_notes'; RETURN; END IF;
  EXECUTE 'DROP POLICY IF EXISTS "Teachers see all exam notes" ON public.exam_notes';
  EXECUTE 'DROP POLICY IF EXISTS "Teachers update exam notes" ON public.exam_notes';
  EXECUTE 'DROP POLICY IF EXISTS "exam_notes_select" ON public.exam_notes';
  EXECUTE 'DROP POLICY IF EXISTS "exam_notes_update" ON public.exam_notes';
  EXECUTE $P$
    CREATE POLICY "exam_notes_select" ON public.exam_notes FOR SELECT TO authenticated
    USING (
      auth.uid() = user_id
      OR EXISTS (SELECT 1 FROM public.exams e JOIN public.course_teachers ct ON ct.course_id=e.course_id
                  WHERE e.id = exam_notes.exam_id AND ct.user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.exams e
                  WHERE e.id = exam_notes.exam_id AND public.is_admin_of_course_tenant(e.course_id))
    )
  $P$;
  EXECUTE $P$
    CREATE POLICY "exam_notes_update" ON public.exam_notes FOR UPDATE TO authenticated
    USING (
      auth.uid() = user_id
      OR EXISTS (SELECT 1 FROM public.exams e JOIN public.course_teachers ct ON ct.course_id=e.course_id
                  WHERE e.id = exam_notes.exam_id AND ct.user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.exams e
                  WHERE e.id = exam_notes.exam_id AND public.is_admin_of_course_tenant(e.course_id))
    )
    WITH CHECK (
      auth.uid() = user_id
      OR EXISTS (SELECT 1 FROM public.exams e JOIN public.course_teachers ct ON ct.course_id=e.course_id
                  WHERE e.id = exam_notes.exam_id AND ct.user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.exams e
                  WHERE e.id = exam_notes.exam_id AND public.is_admin_of_course_tenant(e.course_id))
    )
  $P$;
END $$;

-- ── 4a) submissions — drop write bare + scoped delete ──
DO $$ BEGIN
  IF to_regclass('public.submissions') IS NULL THEN RAISE NOTICE 'skip submissions'; RETURN; END IF;
  EXECUTE 'DROP POLICY IF EXISTS "Docentes/Admins insert submissions" ON public.submissions';
  EXECUTE 'DROP POLICY IF EXISTS "Docentes/Admins update submissions" ON public.submissions';
  EXECUTE 'DROP POLICY IF EXISTS "Docentes/Admins delete submissions" ON public.submissions';
  EXECUTE $P$
    CREATE POLICY "submissions_delete_staff" ON public.submissions FOR DELETE TO authenticated
    USING (
      EXISTS (SELECT 1 FROM public.exams e JOIN public.course_teachers ct ON ct.course_id=e.course_id
               WHERE e.id = submissions.exam_id AND ct.user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.exams e
                  WHERE e.id = submissions.exam_id AND public.is_admin_of_course_tenant(e.course_id))
    )
  $P$;
END $$;

-- ── 4b) workshop_submissions — drop write bare + scoped delete ──
DO $$ BEGIN
  IF to_regclass('public.workshop_submissions') IS NULL THEN RAISE NOTICE 'skip workshop_submissions'; RETURN; END IF;
  EXECUTE 'DROP POLICY IF EXISTS "Docentes/Admins insert workshop submissions" ON public.workshop_submissions';
  EXECUTE 'DROP POLICY IF EXISTS "Docentes/Admins update workshop submissions" ON public.workshop_submissions';
  EXECUTE 'DROP POLICY IF EXISTS "Docentes/Admins delete workshop submissions" ON public.workshop_submissions';
  EXECUTE $P$
    CREATE POLICY "workshop_submissions_delete_staff" ON public.workshop_submissions FOR DELETE TO authenticated
    USING (
      EXISTS (SELECT 1 FROM public.workshops w JOIN public.course_teachers ct ON ct.course_id=w.course_id
               WHERE w.id = workshop_submissions.workshop_id AND ct.user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.workshops w
                  WHERE w.id = workshop_submissions.workshop_id AND public.is_admin_of_course_tenant(w.course_id))
    )
  $P$;
END $$;

-- ── 4c) project_submissions — drop write bare + scoped delete ──
DO $$ BEGIN
  IF to_regclass('public.project_submissions') IS NULL THEN RAISE NOTICE 'skip project_submissions'; RETURN; END IF;
  EXECUTE 'DROP POLICY IF EXISTS "Docentes/Admins insert project submissions" ON public.project_submissions';
  EXECUTE 'DROP POLICY IF EXISTS "Docentes/Admins update project submissions" ON public.project_submissions';
  EXECUTE 'DROP POLICY IF EXISTS "Docentes/Admins delete project submissions" ON public.project_submissions';
  EXECUTE $P$
    CREATE POLICY "project_submissions_delete_staff" ON public.project_submissions FOR DELETE TO authenticated
    USING (
      EXISTS (SELECT 1 FROM public.projects p JOIN public.course_teachers ct ON ct.course_id=p.course_id
               WHERE p.id = project_submissions.project_id AND ct.user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.projects p
                  WHERE p.id = project_submissions.project_id AND public.is_admin_of_course_tenant(p.course_id))
    )
  $P$;
END $$;

-- ── 5) project_assignments — gestión scopeada al tenant del proyecto ──
DO $$ BEGIN
  IF to_regclass('public.project_assignments') IS NULL THEN RAISE NOTICE 'skip project_assignments'; RETURN; END IF;
  EXECUTE 'DROP POLICY IF EXISTS "project_assignments_manage_staff" ON public.project_assignments';
  EXECUTE $P$
    CREATE POLICY "project_assignments_manage_staff" ON public.project_assignments FOR ALL TO authenticated
    USING (
      public.project_in_my_tenant(project_id)
      AND (public.has_role(auth.uid(),'Docente') OR public.has_role(auth.uid(),'Admin'))
    )
    WITH CHECK (
      public.project_in_my_tenant(project_id)
      AND (public.has_role(auth.uid(),'Docente') OR public.has_role(auth.uid(),'Admin'))
    )
  $P$;
END $$;
