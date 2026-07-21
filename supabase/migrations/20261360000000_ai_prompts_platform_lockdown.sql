-- ════════════════════════════════════════════════════════════════════════
-- Lockdown de seguridad: los prompts del ASISTENTE DE PLATAFORMA (use_cases
-- platform_support*) solo los edita el SuperAdmin.
--
-- Gap: las policies de Admin sobre ai_prompts (ai_prompts_admin_global +
-- ai_prompts_admin_write_global) permitían a un Admin de tenant crear/editar
-- filas `course_id IS NULL AND tenant_id = current_tenant_id()`, INCLUIDAS las
-- de platform_support*/support_triage → un Admin podía inyectar u override el
-- prompt del asistente de plataforma para SU institución. Los prompts de
-- plataforma son cross-tenant y deben ser SA-only.
--
-- Fix: se elimina la policy duplicada `ai_prompts_admin_global` (era un subset
-- de ai_prompts_admin_write_global sin el OR is_super_admin — el SA sigue
-- cubierto por ai_prompts_super_admin_all) y se recrea la global de Admin
-- EXCLUYENDO los use_cases del asistente de plataforma. Los grading use_cases
-- (exam_question, workshop_full, etc.) globales siguen editables por el Admin.
-- ════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.ai_prompts') IS NOT NULL THEN
    DROP POLICY IF EXISTS ai_prompts_admin_global ON public.ai_prompts;
    DROP POLICY IF EXISTS ai_prompts_admin_write_global ON public.ai_prompts;

    CREATE POLICY ai_prompts_admin_write_global ON public.ai_prompts
      FOR ALL
      USING (
        (
          course_id IS NULL
          AND tenant_id = public.current_tenant_id()
          AND public.has_role(auth.uid(), 'Admin'::public.app_role)
          AND use_case <> ALL (ARRAY[
            'platform_support','platform_support_docente','platform_support_estudiante',
            'platform_support_superadmin','support_triage'
          ])
        )
        OR public.is_super_admin()
      )
      WITH CHECK (
        (
          course_id IS NULL
          AND tenant_id = public.current_tenant_id()
          AND public.has_role(auth.uid(), 'Admin'::public.app_role)
          AND use_case <> ALL (ARRAY[
            'platform_support','platform_support_docente','platform_support_estudiante',
            'platform_support_superadmin','support_triage'
          ])
        )
        OR public.is_super_admin()
      );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
