-- ──────────────────────────────────────────────────────────────────────
-- Multitenant — Fase D: aislamiento real via RESTRICTIVE policies.
--
-- Postgres RLS soporta dos tipos de policies:
--   - PERMISSIVE (default): se OR-ean entre sí
--   - RESTRICTIVE: se AND-ean a TODAS las PERMISSIVE y otras RESTRICTIVE
--
-- En lugar de reescribir las ~100 policies existentes para agregarles
-- el filtro de tenant, agregamos UNA policy RESTRICTIVE por tabla que
-- enforza el aislamiento. Esto se AND-ea automáticamente con todo lo
-- demás: las policies viejas siguen decidiendo "puede ver por rol"; la
-- nueva enforza "y además mismo tenant".
--
-- Excepciones especiales:
--   - tenants: ya tiene policy que maneja su propio caso
--   - profiles: incluye `OR id = auth.uid()` para que Superadmin (tenant_id NULL)
--     pueda verse a sí mismo
--   - user_roles: incluye `OR user_id = auth.uid()` por la misma razón
--
-- Si esta migración rompe algo, ROLLBACK es simple:
--   DROP POLICY tenant_isolation ON public.<tabla> CASCADE;
-- por cada tabla afectada.
-- ──────────────────────────────────────────────────────────────────────

-- ── Helper para tablas con caso especial de self-access ──
-- Aplica la RESTRICTIVE policy y permite además acceso al "propio" registro
-- (cuando una persona puede ver su propio perfil/rol aunque tenant_id sea NULL).

DO $$
DECLARE
  _t TEXT;
  _standard_tables TEXT[];
BEGIN
  -- Lista de tablas que reciben el patrón ESTÁNDAR:
  --   USING (public.has_tenant_access(tabla.tenant_id))
  --
  -- Incluye tablas con tenant_id NOT NULL — donde Superadmin pasa por
  -- el check porque has_tenant_access devuelve TRUE para él.
  _standard_tables := ARRAY[
    -- Core de la Fase B (excepto profiles/user_roles que son especiales)
    'courses', 'exams', 'workshops', 'projects',
    -- Tablas de Fase C (orden alfabético para legibilidad)
    'ai_prompts',
    'assessment_templates',
    'attendance_check_in_state',
    'attendance_records',
    'attendance_sessions',
    'audit_logs',
    'certificates',
    'code_executions',
    'conversations',
    'course_enrollments',
    'course_teachers',
    'exam_assignments',
    'exam_notes',
    'exam_timer_controls',
    'feedback_comments',
    'feedback_threads',
    'forum_replies',
    'forum_threads',
    'forum_upvotes',
    'generated_contents',
    'grade_cuts',
    'integrity_reviews',
    'messages',
    'notifications',
    'project_assignments',
    'project_courses',
    'project_files',
    'project_group_members',
    'project_groups',
    'project_submission_files',
    'project_submissions',
    'question_bank',
    'questions',
    'similarity_pairs',
    'student_calendar_tokens',
    'submissions',
    'teacher_google_tokens',
    'tutor_chat_messages',
    'tutor_chat_sessions',
    'web_push_subscriptions',
    'workshop_assignments',
    'workshop_group_members',
    'workshop_groups',
    'workshop_questions',
    'workshop_submission_answers',
    'workshop_submissions'
  ];

  FOREACH _t IN ARRAY _standard_tables LOOP
    -- Verifica que la tabla existe y tiene columna tenant_id
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=_t AND column_name='tenant_id'
    ) THEN
      EXECUTE format(
        'DROP POLICY IF EXISTS %I ON public.%I',
        'tenant_isolation', _t
      );
      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (public.has_tenant_access(%I.tenant_id)) WITH CHECK (public.has_tenant_access(%I.tenant_id))',
        'tenant_isolation', _t, _t, _t
      );
      RAISE NOTICE 'Aislamiento aplicado a %', _t;
    ELSE
      RAISE NOTICE 'Saltada (sin tenant_id): %', _t;
    END IF;
  END LOOP;
END $$;

-- ── Tablas especiales: profiles + user_roles ──
-- Permiten self-access aunque tenant_id sea NULL (caso Superadmin).
-- También permiten que el Superadmin vea cualquiera vía has_role check.

-- profiles: yo puedo verme + Superadmin todo + mismo tenant
DROP POLICY IF EXISTS tenant_isolation ON public.profiles;
CREATE POLICY tenant_isolation
  ON public.profiles AS RESTRICTIVE
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'Superadmin')
    OR id = auth.uid()
    OR tenant_id = public.current_tenant_id_safe()
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'Superadmin')
    OR id = auth.uid()
    OR tenant_id = public.current_tenant_id_safe()
  );

-- user_roles: mismo patrón
DROP POLICY IF EXISTS tenant_isolation ON public.user_roles;
CREATE POLICY tenant_isolation
  ON public.user_roles AS RESTRICTIVE
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'Superadmin')
    OR user_id = auth.uid()
    OR tenant_id = public.current_tenant_id_safe()
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'Superadmin')
    OR user_id = auth.uid()
    OR tenant_id = public.current_tenant_id_safe()
  );

-- ── Notas operacionales ──
--
-- Después de aplicar esta migración:
--
-- 1) Los usuarios del tenant inicial 'examlab' SIGUEN viendo todo lo
--    suyo. Las RLS originales no cambiaron y el filtro de tenant lo
--    cumplen automáticamente porque su tenant_id ya está poblado.
--
-- 2) Si creas un segundo tenant y haces login con un user de ese
--    tenant, NO va a ver datos del tenant 1.
--
-- 3) Superadmin (con role='Superadmin' en user_roles, tenant_id=NULL)
--    ve TODO porque has_tenant_access() retorna TRUE para él.
--
-- 4) Las edge functions que usan service_role bypassean RLS y ven
--    todo. Tienen que filtrar manualmente por tenant_id cuando aplique.
--
-- 5) Triggers SECURITY DEFINER (las funciones helper) también bypassean
--    RLS — solo importan los checks en las policies del cliente.
--
-- Diagnostic queries útiles después del deploy:
--   -- Ver qué policies existen sobre una tabla
--   SELECT * FROM pg_policies WHERE tablename = 'courses';
--   -- Probar el helper como un user específico
--   SET ROLE authenticated; SET request.jwt.claims = '...'; SELECT current_tenant_id_safe();

NOTIFY pgrst, 'reload schema';
