-- ──────────────────────────────────────────────────────────────────────
-- Tutor IA: fuentes parametrizables (Fase 1, SIN embeddings).
--
-- Cambia QUÉ entra al contexto del Tutor IA, no CÓMO se busca (sigue el
-- armado por presupuesto). Dos piezas:
--
-- 1) `tutor_ai_sources` — interruptores de fuentes, con DOS alcances en UNA
--    tabla (exactamente uno de subject_id / course_id):
--      • fila de ASIGNATURA  (subject_id, course_id NULL) → default que
--        configura el Admin de la institución y heredan sus cursos.
--      • fila de OVERRIDE     (course_id, subject_id NULL) → la escribe el
--        docente del curso (o Admin) para sobrescribir el default.
--    Resolución efectiva (en el edge): override del curso > asignatura >
--    default hardcodeado. Precedencia por FILA COMPLETA (como "Volver al
--    global" de ai_prompts): borrar la fila de override vuelve a la de la
--    asignatura.
--
--    Cuatro interruptores:
--      • src_subject_material    (on)  material de la asignatura
--      • src_course_material     (on)  material propio del curso
--      • src_course_transcripts  (on)  transcripciones de ESTE curso
--      • src_sibling_transcripts (off) transcripciones de otros grupos de la
--                                      MISMA asignatura y el MISMO periodo
--                                      (solo teacher_text, nunca content_text)
--
-- 2) `content_subject_assignments` — asigna material (generated_contents) a la
--    ASIGNATURA para que persista entre semestres: un curso nuevo de la misma
--    asignatura hereda el material sin reasignarlo.
--
-- RLS por institución: el Admin del tenant escribe la fila de asignatura y el
-- material de asignatura; el docente del curso (course_teachers) o el Admin
-- escriben el override del curso; SuperAdmin todo. Nunca USING(true) ni
-- has_role() sin scope de tenant. Las lecturas respetan la papelera
-- (deleted_at) de los cursos/contenidos vía las queries del edge.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.courses') IS NULL
     OR to_regclass('public.academic_subjects') IS NULL THEN
    RAISE NOTICE 'courses / academic_subjects no existen — abortando tutor_ai_sources';
    RETURN;
  END IF;

  -- ════════════════════════════════════════════════════════════════════
  -- 1) tutor_ai_sources
  -- ════════════════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS public.tutor_ai_sources (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    subject_id UUID REFERENCES public.academic_subjects(id) ON DELETE CASCADE,
    course_id  UUID REFERENCES public.courses(id) ON DELETE CASCADE,
    src_subject_material    BOOLEAN NOT NULL DEFAULT true,
    src_course_material     BOOLEAN NOT NULL DEFAULT true,
    src_course_transcripts  BOOLEAN NOT NULL DEFAULT true,
    src_sibling_transcripts BOOLEAN NOT NULL DEFAULT false,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Exactamente uno de los dos alcances.
    CONSTRAINT chk_tutor_ai_sources_scope
      CHECK ((subject_id IS NOT NULL) <> (course_id IS NOT NULL))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uq_tutor_ai_sources_subject
    ON public.tutor_ai_sources(subject_id) WHERE subject_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_tutor_ai_sources_course
    ON public.tutor_ai_sources(course_id) WHERE course_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_tutor_ai_sources_tenant
    ON public.tutor_ai_sources(tenant_id);

  DROP TRIGGER IF EXISTS trg_tutor_ai_sources_updated_at ON public.tutor_ai_sources;
  CREATE TRIGGER trg_tutor_ai_sources_updated_at
    BEFORE UPDATE ON public.tutor_ai_sources
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

  DROP TRIGGER IF EXISTS trg_tutor_ai_sources_set_tenant ON public.tutor_ai_sources;
  CREATE TRIGGER trg_tutor_ai_sources_set_tenant
    BEFORE INSERT ON public.tutor_ai_sources
    FOR EACH ROW EXECUTE FUNCTION public.tg_set_tenant_id();

  ALTER TABLE public.tutor_ai_sources ENABLE ROW LEVEL SECURITY;

  -- SELECT: miembros del tenant (docente necesita leer el default de la
  -- asignatura y el override del curso) o SuperAdmin.
  DROP POLICY IF EXISTS tutor_ai_sources_select ON public.tutor_ai_sources;
  CREATE POLICY tutor_ai_sources_select
    ON public.tutor_ai_sources FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());

  -- WRITE: fila de ASIGNATURA → Admin del tenant. Fila de OVERRIDE de curso →
  -- docente del curso o Admin/SuperAdmin del tenant del curso.
  DROP POLICY IF EXISTS tutor_ai_sources_write ON public.tutor_ai_sources;
  CREATE POLICY tutor_ai_sources_write
    ON public.tutor_ai_sources FOR ALL TO authenticated
    USING (
      public.is_super_admin()
      OR (
        subject_id IS NOT NULL
        AND tenant_id = public.current_tenant_id()
        AND public.has_role(auth.uid(), 'Admin')
      )
      OR (
        course_id IS NOT NULL
        AND (
          public.is_admin_of_course_tenant(course_id)
          OR EXISTS (
            SELECT 1 FROM public.course_teachers ct
            WHERE ct.course_id = tutor_ai_sources.course_id
              AND ct.user_id = auth.uid()
          )
        )
      )
    )
    WITH CHECK (
      public.is_super_admin()
      OR (
        subject_id IS NOT NULL
        AND tenant_id = public.current_tenant_id()
        AND public.has_role(auth.uid(), 'Admin')
      )
      OR (
        course_id IS NOT NULL
        AND (
          public.is_admin_of_course_tenant(course_id)
          OR EXISTS (
            SELECT 1 FROM public.course_teachers ct
            WHERE ct.course_id = tutor_ai_sources.course_id
              AND ct.user_id = auth.uid()
          )
        )
      )
    );

  -- ════════════════════════════════════════════════════════════════════
  -- 2) content_subject_assignments
  -- ════════════════════════════════════════════════════════════════════
  IF to_regclass('public.generated_contents') IS NOT NULL THEN
    CREATE TABLE IF NOT EXISTS public.content_subject_assignments (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id  UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
      content_id UUID NOT NULL REFERENCES public.generated_contents(id) ON DELETE CASCADE,
      subject_id UUID NOT NULL REFERENCES public.academic_subjects(id) ON DELETE CASCADE,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      position   INTEGER NOT NULL DEFAULT 0,
      UNIQUE (content_id, subject_id)
    );

    CREATE INDEX IF NOT EXISTS idx_csa_subject
      ON public.content_subject_assignments(subject_id);
    CREATE INDEX IF NOT EXISTS idx_csa_content
      ON public.content_subject_assignments(content_id);
    CREATE INDEX IF NOT EXISTS idx_csa_tenant
      ON public.content_subject_assignments(tenant_id);

    DROP TRIGGER IF EXISTS trg_csa_set_tenant ON public.content_subject_assignments;
    CREATE TRIGGER trg_csa_set_tenant
      BEFORE INSERT ON public.content_subject_assignments
      FOR EACH ROW EXECUTE FUNCTION public.tg_set_tenant_id();

    ALTER TABLE public.content_subject_assignments ENABLE ROW LEVEL SECURITY;

    -- SELECT: miembros del tenant (docente necesita VER el material heredado
    -- de la asignatura en su curso) o SuperAdmin.
    DROP POLICY IF EXISTS csa_select ON public.content_subject_assignments;
    CREATE POLICY csa_select
      ON public.content_subject_assignments FOR SELECT TO authenticated
      USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());

    -- WRITE: Admin del tenant (el material de la ASIGNATURA lo gobierna el
    -- Admin, decisión del dueño) o SuperAdmin.
    DROP POLICY IF EXISTS csa_write ON public.content_subject_assignments;
    CREATE POLICY csa_write
      ON public.content_subject_assignments FOR ALL TO authenticated
      USING (
        public.is_super_admin()
        OR (tenant_id = public.current_tenant_id() AND public.has_role(auth.uid(), 'Admin'))
      )
      WITH CHECK (
        public.is_super_admin()
        OR (
          tenant_id = public.current_tenant_id()
          AND public.has_role(auth.uid(), 'Admin')
          AND (created_by IS NULL OR created_by = auth.uid())
        )
      );

    COMMENT ON TABLE public.content_subject_assignments IS
      'Asigna material (generated_contents) a una ASIGNATURA para que persista entre semestres. Un curso nuevo de la misma asignatura hereda este material en el Tutor IA sin reasignarlo. Lo gobierna el Admin de la institución.';
  END IF;

  COMMENT ON TABLE public.tutor_ai_sources IS
    'Interruptores de fuentes del Tutor IA. Fila de asignatura (subject_id) = default de la institución; fila de override (course_id) = ajuste del docente del curso. Resolución: override > asignatura > default. Fase 1: sin embeddings.';

  IF to_regprocedure('public.is_admin_of_course_tenant(uuid)') IS NULL THEN
    RAISE NOTICE 'is_admin_of_course_tenant no existe — la rama de override por curso quedará limitada';
  END IF;
END $$;
