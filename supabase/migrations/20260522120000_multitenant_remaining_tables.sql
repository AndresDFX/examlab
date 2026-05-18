-- ──────────────────────────────────────────────────────────────────────
-- Multitenant — Fase C: tenant_id en todas las tablas restantes.
--
-- Para cada tabla en la lista TENANT_TABLES:
--   1. ADD COLUMN tenant_id UUID (si no existe)
--   2. UPDATE backfill al tenant inicial — JOIN al parent cuando aplica
--   3. ALTER COLUMN SET NOT NULL
--   4. ADD CONSTRAINT FK ON DELETE CASCADE
--   5. CREATE INDEX
--   6. Trigger BEFORE INSERT que rellena tenant_id del actor
--
-- Tablas que se INFIEREN del parent (UPDATE join):
--   questions, submissions, exam_assignments → exams
--   workshop_* → workshops
--   project_* → projects
--   course_teachers, course_enrollments, grade_cuts → courses
--   attendance_records → attendance_sessions (que tiene tenant via course)
--
-- Los singletons (email_settings, code_execution_settings, etc.) NO van
-- en esta fase — se transforman en Fase E con un patrón especial
-- (deja de ser singleton global, pasa a "singleton por tenant").
-- ──────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  _initial_tenant UUID;
  _t TEXT;
  _tables_simple TEXT[];        -- Tablas sin parent; tenant_id = inicial
  _tables_via_exam TEXT[];      -- Hijas de exams
  _tables_via_workshop TEXT[];  -- Hijas de workshops
  _tables_via_project TEXT[];   -- Hijas de projects
  _tables_via_course TEXT[];    -- Hijas directas de courses
BEGIN
  SELECT id INTO _initial_tenant FROM public.tenants WHERE slug = 'examlab' LIMIT 1;
  IF _initial_tenant IS NULL THEN
    RAISE EXCEPTION 'Tenant inicial "examlab" no encontrado.';
  END IF;

  -- ── Tablas SIMPLES: tenant_id = tenant inicial (backfill plano) ──
  _tables_simple := ARRAY[
    'notifications',
    'conversations',
    'messages',
    'feedback_threads',
    'feedback_comments',
    'web_push_subscriptions',
    'audit_logs',
    'generated_contents',
    'forum_threads',
    'forum_replies',
    'forum_upvotes',
    'tutor_chat_sessions',
    'tutor_chat_messages',
    'certificates',
    'student_calendar_tokens',
    'question_bank',
    'integrity_reviews',
    'similarity_pairs',
    'code_executions',
    'teacher_google_tokens',
    'ai_prompts'
  ];

  FOREACH _t IN ARRAY _tables_simple LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name=_t
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=_t AND column_name='tenant_id'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN tenant_id UUID', _t);
      EXECUTE format('UPDATE public.%I SET tenant_id = %L WHERE tenant_id IS NULL', _t, _initial_tenant);
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id SET NOT NULL', _t);
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE',
        _t, _t || '_tenant_id_fkey'
      );
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON public.%I(tenant_id)',
        'idx_' || _t || '_tenant_id', _t
      );
      RAISE NOTICE 'Procesada (simple): %', _t;
    END IF;
  END LOOP;

  -- ── Tablas hijas de COURSES: backfill via JOIN al course ──
  _tables_via_course := ARRAY[
    'course_teachers',
    'course_enrollments',
    'grade_cuts'
  ];

  FOREACH _t IN ARRAY _tables_via_course LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name=_t
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=_t AND column_name='tenant_id'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN tenant_id UUID', _t);
      EXECUTE format(
        'UPDATE public.%I AS t SET tenant_id = c.tenant_id FROM public.courses c WHERE t.course_id = c.id AND t.tenant_id IS NULL',
        _t
      );
      -- Tablas que pueden tener filas huérfanas (sin parent) usan el tenant inicial
      EXECUTE format('UPDATE public.%I SET tenant_id = %L WHERE tenant_id IS NULL', _t, _initial_tenant);
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id SET NOT NULL', _t);
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE',
        _t, _t || '_tenant_id_fkey'
      );
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON public.%I(tenant_id)',
        'idx_' || _t || '_tenant_id', _t
      );
      RAISE NOTICE 'Procesada (via course): %', _t;
    END IF;
  END LOOP;

  -- ── Tablas hijas de EXAMS ──
  _tables_via_exam := ARRAY[
    'questions',
    'submissions',
    'exam_assignments',
    'exam_timer_controls',
    'exam_notes'
  ];

  FOREACH _t IN ARRAY _tables_via_exam LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name=_t
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=_t AND column_name='tenant_id'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN tenant_id UUID', _t);
      EXECUTE format(
        'UPDATE public.%I AS t SET tenant_id = e.tenant_id FROM public.exams e WHERE t.exam_id = e.id AND t.tenant_id IS NULL',
        _t
      );
      EXECUTE format('UPDATE public.%I SET tenant_id = %L WHERE tenant_id IS NULL', _t, _initial_tenant);
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id SET NOT NULL', _t);
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE',
        _t, _t || '_tenant_id_fkey'
      );
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON public.%I(tenant_id)',
        'idx_' || _t || '_tenant_id', _t
      );
      RAISE NOTICE 'Procesada (via exam): %', _t;
    END IF;
  END LOOP;

  -- ── Tablas hijas de WORKSHOPS ──
  _tables_via_workshop := ARRAY[
    'workshop_questions',
    'workshop_submissions',
    'workshop_submission_answers',
    'workshop_assignments',
    'workshop_groups',
    'workshop_group_members'
  ];

  FOREACH _t IN ARRAY _tables_via_workshop LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name=_t
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=_t AND column_name='tenant_id'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN tenant_id UUID', _t);
      EXECUTE format(
        'UPDATE public.%I AS t SET tenant_id = w.tenant_id FROM public.workshops w WHERE t.workshop_id = w.id AND t.tenant_id IS NULL',
        _t
      );
      EXECUTE format('UPDATE public.%I SET tenant_id = %L WHERE tenant_id IS NULL', _t, _initial_tenant);
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id SET NOT NULL', _t);
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE',
        _t, _t || '_tenant_id_fkey'
      );
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON public.%I(tenant_id)',
        'idx_' || _t || '_tenant_id', _t
      );
      RAISE NOTICE 'Procesada (via workshop): %', _t;
    END IF;
  END LOOP;

  -- ── Tablas hijas de PROJECTS ──
  _tables_via_project := ARRAY[
    'project_files',
    'project_submissions',
    'project_submission_files',
    'project_assignments',
    'project_courses',
    'project_groups',
    'project_group_members'
  ];

  FOREACH _t IN ARRAY _tables_via_project LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name=_t
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=_t AND column_name='tenant_id'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN tenant_id UUID', _t);
      EXECUTE format(
        'UPDATE public.%I AS t SET tenant_id = p.tenant_id FROM public.projects p WHERE t.project_id = p.id AND t.tenant_id IS NULL',
        _t
      );
      EXECUTE format('UPDATE public.%I SET tenant_id = %L WHERE tenant_id IS NULL', _t, _initial_tenant);
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id SET NOT NULL', _t);
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE',
        _t, _t || '_tenant_id_fkey'
      );
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON public.%I(tenant_id)',
        'idx_' || _t || '_tenant_id', _t
      );
      RAISE NOTICE 'Procesada (via project): %', _t;
    END IF;
  END LOOP;

  -- ── Tablas de asistencia: attendance_sessions tiene course_id directo ──
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='attendance_sessions'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='attendance_sessions' AND column_name='tenant_id'
  ) THEN
    ALTER TABLE public.attendance_sessions ADD COLUMN tenant_id UUID;
    UPDATE public.attendance_sessions AS t SET tenant_id = c.tenant_id
      FROM public.courses c WHERE t.course_id = c.id AND t.tenant_id IS NULL;
    EXECUTE format('UPDATE public.attendance_sessions SET tenant_id = %L WHERE tenant_id IS NULL', _initial_tenant);
    ALTER TABLE public.attendance_sessions ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE public.attendance_sessions
      ADD CONSTRAINT attendance_sessions_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_attendance_sessions_tenant_id
      ON public.attendance_sessions(tenant_id);
    RAISE NOTICE 'Procesada: attendance_sessions';
  END IF;

  -- attendance_records hereda via session_id → attendance_sessions
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='attendance_records'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='attendance_records' AND column_name='tenant_id'
  ) THEN
    ALTER TABLE public.attendance_records ADD COLUMN tenant_id UUID;
    UPDATE public.attendance_records AS r SET tenant_id = s.tenant_id
      FROM public.attendance_sessions s WHERE r.session_id = s.id AND r.tenant_id IS NULL;
    EXECUTE format('UPDATE public.attendance_records SET tenant_id = %L WHERE tenant_id IS NULL', _initial_tenant);
    ALTER TABLE public.attendance_records ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE public.attendance_records
      ADD CONSTRAINT attendance_records_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_attendance_records_tenant_id
      ON public.attendance_records(tenant_id);
    RAISE NOTICE 'Procesada: attendance_records';
  END IF;

  -- attendance_check_in_state via session_id
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='attendance_check_in_state'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='attendance_check_in_state' AND column_name='tenant_id'
  ) THEN
    ALTER TABLE public.attendance_check_in_state ADD COLUMN tenant_id UUID;
    UPDATE public.attendance_check_in_state AS r SET tenant_id = s.tenant_id
      FROM public.attendance_sessions s WHERE r.session_id = s.id AND r.tenant_id IS NULL;
    EXECUTE format('UPDATE public.attendance_check_in_state SET tenant_id = %L WHERE tenant_id IS NULL', _initial_tenant);
    ALTER TABLE public.attendance_check_in_state ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE public.attendance_check_in_state
      ADD CONSTRAINT attendance_check_in_state_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_attendance_check_in_state_tenant_id
      ON public.attendance_check_in_state(tenant_id);
    RAISE NOTICE 'Procesada: attendance_check_in_state';
  END IF;

  -- assessment_templates si existe
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='assessment_templates'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='assessment_templates' AND column_name='tenant_id'
  ) THEN
    ALTER TABLE public.assessment_templates ADD COLUMN tenant_id UUID;
    EXECUTE format('UPDATE public.assessment_templates SET tenant_id = %L WHERE tenant_id IS NULL', _initial_tenant);
    ALTER TABLE public.assessment_templates ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE public.assessment_templates
      ADD CONSTRAINT assessment_templates_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_assessment_templates_tenant_id
      ON public.assessment_templates(tenant_id);
    RAISE NOTICE 'Procesada: assessment_templates';
  END IF;

  RAISE NOTICE 'Fase C completada. Todas las tablas restantes tienen tenant_id.';

  -- ── Sanity check: contar huérfanos en CADA tabla con tenant_id NOT NULL ──
  DECLARE
    _orphans INT;
    _tab TEXT;
  BEGIN
    FOR _tab IN
      SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE c.table_schema='public'
          AND c.column_name='tenant_id'
          AND c.is_nullable='NO'
          AND t.table_type='BASE TABLE'
    LOOP
      EXECUTE format('SELECT COUNT(*) FROM public.%I WHERE tenant_id IS NULL', _tab) INTO _orphans;
      IF _orphans > 0 THEN
        RAISE EXCEPTION 'Tabla % tiene % filas con tenant_id NULL pese a ser NOT NULL. Corrupción detectada.', _tab, _orphans;
      END IF;
    END LOOP;
    RAISE NOTICE 'Sanity check Fase C: OK. Todas las tablas NOT NULL están limpias.';
  END;
END $$;

-- ── Triggers BEFORE INSERT que rellenan tenant_id en TODAS las tablas ──
-- Aplicamos el helper _fill_tenant_id_from_actor (definido en Fase B) a
-- las tablas críticas que reciben inserts del cliente.

DO $$
DECLARE
  _table TEXT;
  _tables_with_trigger TEXT[];
BEGIN
  _tables_with_trigger := ARRAY[
    'questions',
    'submissions',
    'exam_assignments',
    'workshop_questions',
    'workshop_submissions',
    'workshop_assignments',
    'project_files',
    'project_submissions',
    'project_assignments',
    'grade_cuts',
    'course_teachers',
    'course_enrollments',
    'attendance_sessions',
    'attendance_records',
    'notifications',
    'generated_contents',
    'forum_threads',
    'forum_replies',
    'tutor_chat_sessions',
    'tutor_chat_messages',
    'certificates',
    'question_bank',
    'audit_logs'
  ];

  FOREACH _table IN ARRAY _tables_with_trigger LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name=_table
    ) THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS %I ON public.%I',
        'trg_fill_tenant_id_' || _table, _table
      );
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public._fill_tenant_id_from_actor()',
        'trg_fill_tenant_id_' || _table, _table
      );
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
