-- ══════════════════════════════════════════════════════════════════════
-- Informes GENERADOS — historial de informes producidos a partir de una
-- PLANTILLA (report_templates) para un curso/estudiante/periodo.
--
-- Separa el concepto **Plantilla** (blueprint reutilizable, `report_templates`)
-- del concepto **Informe generado** (instancia concreta con datos reales,
-- descargable como Word/PDF). Antes el informe generado era efímero (se
-- renderizaba en memoria y se imprimía); ahora cada generación se persiste con
-- un snapshot del HTML compuesto, así el docente tiene historial + re-descarga.
--
-- NO es para estudiantes: la RLS sólo deja ver/crear al docente del curso, al
-- Admin del tenant o al SuperAdmin (el alumno nunca ve este módulo ni la tabla).
-- Inmutable: sin policy de UPDATE (un informe generado es un snapshot).
-- ══════════════════════════════════════════════════════════════════════

DO $mig$
BEGIN
  IF to_regclass('public.courses') IS NULL THEN
    RAISE NOTICE 'skip generated_reports: courses ausente';
    RETURN;
  END IF;

  CREATE TABLE IF NOT EXISTS public.generated_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Plantilla origen (puede borrarse después → SET NULL; guardamos el nombre).
    template_id uuid REFERENCES public.report_templates(id) ON DELETE SET NULL,
    template_name text NOT NULL,
    scope text NOT NULL DEFAULT 'curso',        -- 'estudiante' | 'curso'
    -- Curso del informe (siempre presente). Si el curso se elimina físicamente,
    -- el informe generado se va con él (CASCADE).
    course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
    course_name text,
    student_id uuid,                            -- apunta a auth.users (sin FK, patrón profiles)
    student_name text,
    periodo text,
    -- Si el informe vino de un ACTA (snapshot inmutable), lo enlazamos.
    acta_id uuid REFERENCES public.course_actas(id) ON DELETE SET NULL,
    -- Snapshot del HTML compuesto (re-descargable como Word/PDF sin recalcular).
    html text NOT NULL,
    page_orientation text DEFAULT 'portrait',
    page_size text DEFAULT 'A4',
    created_by uuid NOT NULL DEFAULT auth.uid(),
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_generated_reports_course ON public.generated_reports(course_id);
  CREATE INDEX IF NOT EXISTS idx_generated_reports_created_by ON public.generated_reports(created_by);
  CREATE INDEX IF NOT EXISTS idx_generated_reports_created_at ON public.generated_reports(created_at DESC);

  ALTER TABLE public.generated_reports ENABLE ROW LEVEL SECURITY;
END
$mig$;

-- ── RLS ──
DO $mig$
BEGIN
  IF to_regclass('public.generated_reports') IS NULL THEN
    RAISE NOTICE 'skip generated_reports RLS: tabla ausente';
    RETURN;
  END IF;

  -- SELECT: el creador, o staff (docente del curso / Admin del tenant / SA),
  -- siempre acotado al tenant del curso. El estudiante NO ve nada.
  DROP POLICY IF EXISTS "generated_reports_select" ON public.generated_reports;
  CREATE POLICY "generated_reports_select" ON public.generated_reports
    FOR SELECT
    USING (
      created_by = auth.uid()
      OR (
        public.course_in_my_tenant(course_id)
        AND (
          public.has_role(auth.uid(), 'Admin')
          OR public.is_super_admin()
          OR EXISTS (
            SELECT 1 FROM public.course_teachers ct
             WHERE ct.course_id = generated_reports.course_id
               AND ct.user_id = auth.uid()
          )
        )
      )
    );

  -- INSERT: el caller debe ser staff del curso (docente / Admin del tenant / SA)
  -- y firmar como sí mismo.
  DROP POLICY IF EXISTS "generated_reports_insert" ON public.generated_reports;
  CREATE POLICY "generated_reports_insert" ON public.generated_reports
    FOR INSERT
    WITH CHECK (
      created_by = auth.uid()
      AND public.course_in_my_tenant(course_id)
      AND (
        public.has_role(auth.uid(), 'Admin')
        OR public.is_super_admin()
        OR EXISTS (
          SELECT 1 FROM public.course_teachers ct
           WHERE ct.course_id = generated_reports.course_id
             AND ct.user_id = auth.uid()
        )
      )
    );

  -- DELETE: el creador o Admin/SA del tenant del curso.
  DROP POLICY IF EXISTS "generated_reports_delete" ON public.generated_reports;
  CREATE POLICY "generated_reports_delete" ON public.generated_reports
    FOR DELETE
    USING (
      created_by = auth.uid()
      OR (
        public.course_in_my_tenant(course_id)
        AND (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin())
      )
    );
  -- Sin policy de UPDATE → inmutable (un informe generado es un snapshot).
END
$mig$;

NOTIFY pgrst, 'reload schema';
