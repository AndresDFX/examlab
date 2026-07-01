-- ══════════════════════════════════════════════════════════════════════
-- Barrido sistemático del anti-patrón `has_role('Admin')` GLOBAL sin scope de
-- tenant (CLAUDE.md; cerrado antes en 20260929/45, foros 20261037, notifs
-- 20261038). Un sweep de pg_policy encontró estas 5 tablas con la rama Admin
-- SIN scope, confirmadas contra prod:
--
--   • ai_generation_queue (SELECT/UPDATE/DELETE): un Admin de CUALQUIER tenant
--     veía TODOS los jobs (verificado: 8/8, incl. 1 de otro tenant) → expone el
--     `body` (prompt/rúbrica) + permite cancelar/borrar cross-tenant (DoS).
--   • ai_override_codes (ALL): 12 códigos de 2 tenants; has_role('Admin')
--     standalone → un Admin ajeno leía/creaba/borraba los códigos SECRETOS de
--     IA-inmediata de otra institución.
--   • project_intro_videos / workshop_intro_videos (ALL write): has_role('Admin')
--     standalone en USING+CHECK → un Admin ajeno podía INSERTAR/editar videos
--     intro en proyectos/talleres de otra institución. (El SELECT ya estaba
--     scoped con project_in_my_tenant/workshop_in_my_tenant.)
--   • poll_calendar_events (ALL write): has_role('Admin') standalone → inyectar/
--     borrar eventos de calendario de encuestas de otra institución.
--
-- Fix: scopear la rama Admin (por course/workshop/project_in_my_tenant, o por el
-- tenant del created_by cuando la tabla no cuelga de un curso) + is_super_admin.
-- Las ramas de docente (course_teachers) y dueño (created_by/user_id) intactas.
-- NO se tocan assessment_templates (0 filas; semántica de librería pública/privada
-- cross-tenant sin definir) ni tablas globales de plataforma (code_execution_settings,
-- email_settings, system_settings, audit_retention_settings, cron_job_descriptions:
-- singletons globales, es tema de PRIVILEGIO no de leak de datos cross-tenant).
-- ══════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  -- ── ai_generation_queue: Admin scopeado al tenant del creador del job ──
  IF to_regclass('public.ai_generation_queue') IS NOT NULL THEN
    ALTER POLICY ai_gen_queue_select ON public.ai_generation_queue
    USING (
      (created_by = auth.uid())
      OR (has_role(auth.uid(), 'Admin'::app_role) AND EXISTS (
        SELECT 1 FROM public.profiles p WHERE p.id = ai_generation_queue.created_by AND p.tenant_id = public.current_tenant_id()))
      OR public.is_super_admin()
      OR ((course_id IS NOT NULL) AND EXISTS (
        SELECT 1 FROM public.course_teachers ct WHERE ct.course_id = ai_generation_queue.course_id AND ct.user_id = auth.uid()))
    );

    ALTER POLICY ai_gen_queue_update ON public.ai_generation_queue
    USING (
      (created_by = auth.uid())
      OR (has_role(auth.uid(), 'Admin'::app_role) AND EXISTS (
        SELECT 1 FROM public.profiles p WHERE p.id = ai_generation_queue.created_by AND p.tenant_id = public.current_tenant_id()))
      OR public.is_super_admin()
    );

    ALTER POLICY ai_gen_queue_delete ON public.ai_generation_queue
    USING (
      (created_by = auth.uid())
      OR (has_role(auth.uid(), 'Admin'::app_role) AND EXISTS (
        SELECT 1 FROM public.profiles p WHERE p.id = ai_generation_queue.created_by AND p.tenant_id = public.current_tenant_id()))
      OR public.is_super_admin()
    );
  END IF;

  -- ── ai_override_codes: Admin scopeado al tenant del creador del código ──
  IF to_regclass('public.ai_override_codes') IS NOT NULL THEN
    ALTER POLICY ai_override_codes_admin_only ON public.ai_override_codes
    USING (
      (has_role(auth.uid(), 'Admin'::app_role) AND EXISTS (
        SELECT 1 FROM public.profiles p WHERE p.id = ai_override_codes.created_by AND p.tenant_id = public.current_tenant_id()))
      OR public.is_super_admin()
    )
    WITH CHECK (
      (has_role(auth.uid(), 'Admin'::app_role) AND EXISTS (
        SELECT 1 FROM public.profiles p WHERE p.id = ai_override_codes.created_by AND p.tenant_id = public.current_tenant_id()))
      OR public.is_super_admin()
    );
  END IF;

  -- ── project_intro_videos: write scopeado a project_in_my_tenant ──
  IF to_regclass('public.project_intro_videos') IS NOT NULL THEN
    ALTER POLICY project_intro_videos_write_teacher ON public.project_intro_videos
    USING (
      (has_role(auth.uid(), 'Admin'::app_role) AND public.project_in_my_tenant(project_id))
      OR EXISTS (SELECT 1 FROM public.projects p JOIN public.course_teachers ct ON ct.course_id = p.course_id
                 WHERE p.id = project_intro_videos.project_id AND ct.user_id = auth.uid())
      OR public.is_super_admin()
    )
    WITH CHECK (
      (has_role(auth.uid(), 'Admin'::app_role) AND public.project_in_my_tenant(project_id))
      OR EXISTS (SELECT 1 FROM public.projects p JOIN public.course_teachers ct ON ct.course_id = p.course_id
                 WHERE p.id = project_intro_videos.project_id AND ct.user_id = auth.uid())
      OR public.is_super_admin()
    );
  END IF;

  -- ── workshop_intro_videos: write scopeado a workshop_in_my_tenant ──
  IF to_regclass('public.workshop_intro_videos') IS NOT NULL THEN
    ALTER POLICY workshop_intro_videos_write_teacher ON public.workshop_intro_videos
    USING (
      (has_role(auth.uid(), 'Admin'::app_role) AND public.workshop_in_my_tenant(workshop_id))
      OR EXISTS (SELECT 1 FROM public.workshops w JOIN public.course_teachers ct ON ct.course_id = w.course_id
                 WHERE w.id = workshop_intro_videos.workshop_id AND ct.user_id = auth.uid())
      OR public.is_super_admin()
    )
    WITH CHECK (
      (has_role(auth.uid(), 'Admin'::app_role) AND public.workshop_in_my_tenant(workshop_id))
      OR EXISTS (SELECT 1 FROM public.workshops w JOIN public.course_teachers ct ON ct.course_id = w.course_id
                 WHERE w.id = workshop_intro_videos.workshop_id AND ct.user_id = auth.uid())
      OR public.is_super_admin()
    );
  END IF;

  -- ── poll_calendar_events: write scopeado al tenant del curso de la encuesta ──
  IF to_regclass('public.poll_calendar_events') IS NOT NULL THEN
    ALTER POLICY poll_calendar_events_write ON public.poll_calendar_events
    USING (
      EXISTS (SELECT 1 FROM public.poll_courses pc JOIN public.course_teachers ct ON ct.course_id = pc.course_id
              WHERE pc.poll_id = poll_calendar_events.poll_id AND ct.user_id = auth.uid())
      OR (has_role(auth.uid(), 'Admin'::app_role) AND EXISTS (
            SELECT 1 FROM public.poll_courses pc JOIN public.courses c ON c.id = pc.course_id
            WHERE pc.poll_id = poll_calendar_events.poll_id AND c.tenant_id = public.current_tenant_id()))
      OR public.is_super_admin()
    )
    WITH CHECK (
      EXISTS (SELECT 1 FROM public.poll_courses pc JOIN public.course_teachers ct ON ct.course_id = pc.course_id
              WHERE pc.poll_id = poll_calendar_events.poll_id AND ct.user_id = auth.uid())
      OR (has_role(auth.uid(), 'Admin'::app_role) AND EXISTS (
            SELECT 1 FROM public.poll_courses pc JOIN public.courses c ON c.id = pc.course_id
            WHERE pc.poll_id = poll_calendar_events.poll_id AND c.tenant_id = public.current_tenant_id()))
      OR public.is_super_admin()
    );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
