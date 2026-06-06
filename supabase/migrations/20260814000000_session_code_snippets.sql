-- ──────────────────────────────────────────────────────────────────────
-- Snippets de código por sesión presencial.
--
-- Permite que el docente, durante una clase, escriba/edite/ejecute código
-- en cualquiera de los lenguajes que la plataforma soporta (Java, Python,
-- JavaScript, etc.) y deje esos snippets ligados a la sesión para que
-- los alumnos los vean (y opcionalmente los ejecuten) más tarde desde
-- su vista de asistencia.
--
-- Modelo:
--   parent = attendance_sessions
--   child  = session_code_snippets (N por sesión)
--
-- Análogo a `project_files` (varios archivos esperados por proyecto):
-- una tabla intermedia con position para orden + contenido del snippet.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.attendance_sessions') IS NULL THEN
    RAISE NOTICE 'public.attendance_sessions no existe — abortando creación de session_code_snippets';
    RETURN;
  END IF;

  CREATE TABLE IF NOT EXISTS public.session_code_snippets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES public.attendance_sessions(id) ON DELETE CASCADE,
    -- Posición ordinal dentro de la sesión. 0-indexed. Permite reordenar
    -- snippets arrastrando (cuando el docente decide cambiar el orden
    -- de los ejemplos en clase). Sin UNIQUE — gaps tolerados (mismo
    -- patrón que whiteboard_pages.position).
    position INT NOT NULL DEFAULT 0,
    -- Título opcional — el docente puede dejar "" si quiere y la UI
    -- muestra "Snippet N". Útil cuando hace 5 ejemplos rápidos sin
    -- nombrarlos.
    title TEXT NOT NULL DEFAULT '',
    -- Lenguaje. Los valores soportados se alinean con `CodeLanguage`
    -- del front (java | python | javascript). NO usamos CHECK estricto
    -- porque el set de lenguajes puede crecer (cpp, rust, etc.) y
    -- queremos que el front sea la fuente de verdad — el edge function
    -- `execute-code` ya valida que el lenguaje pertenezca a su mapping.
    language TEXT NOT NULL DEFAULT 'java',
    source_code TEXT NOT NULL DEFAULT '',
    -- Últimos resultados de ejecución (cache para que al volver el
    -- alumno vea el output sin tener que re-ejecutar). Pueden quedar
    -- NULL si nunca se ejecutó. Sin límites de tamaño aquí — el caller
    -- (execute-code) ya trunca a 50k chars.
    last_stdout TEXT,
    last_stderr TEXT,
    last_exit_code INT,
    last_executed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_session_code_snippets_session
    ON public.session_code_snippets(session_id, position);

  -- Trigger updated_at usando el helper estándar del repo.
  -- Si no existe (ambiente recién montado), seguimos sin el trigger —
  -- las columnas funcionan igual, solo perdemos el auto-touch.
  IF to_regprocedure('public.update_updated_at_column()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_session_code_snippets_updated_at ON public.session_code_snippets;
    CREATE TRIGGER trg_session_code_snippets_updated_at
      BEFORE UPDATE ON public.session_code_snippets
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;

  -- ── RLS ───────────────────────────────────────────────────────────
  -- SELECT: docente del curso, admin/superadmin, o alumno matriculado
  --         en el curso de la sesión.
  -- INSERT/UPDATE/DELETE: docente del curso o admin/superadmin.
  --
  -- Misma estructura que las policies de attendance_sessions — la
  -- pertenencia al curso se deriva via sub-query a attendance_sessions.
  ALTER TABLE public.session_code_snippets ENABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS session_code_snippets_select ON public.session_code_snippets;
  CREATE POLICY session_code_snippets_select
    ON public.session_code_snippets FOR SELECT TO authenticated
    USING (
      EXISTS (
        SELECT 1 FROM public.attendance_sessions s
        WHERE s.id = session_code_snippets.session_id
          AND (
            public.has_role(auth.uid(), 'Admin'::public.app_role)
            OR public.is_super_admin()
            OR EXISTS (
              SELECT 1 FROM public.course_teachers ct
              WHERE ct.course_id = s.course_id
                AND ct.user_id = auth.uid()
            )
            OR EXISTS (
              SELECT 1 FROM public.course_enrollments ce
              WHERE ce.course_id = s.course_id
                AND ce.user_id = auth.uid()
            )
          )
      )
    );

  DROP POLICY IF EXISTS session_code_snippets_write ON public.session_code_snippets;
  CREATE POLICY session_code_snippets_write
    ON public.session_code_snippets FOR ALL TO authenticated
    USING (
      EXISTS (
        SELECT 1 FROM public.attendance_sessions s
        WHERE s.id = session_code_snippets.session_id
          AND (
            public.has_role(auth.uid(), 'Admin'::public.app_role)
            OR public.is_super_admin()
            OR EXISTS (
              SELECT 1 FROM public.course_teachers ct
              WHERE ct.course_id = s.course_id
                AND ct.user_id = auth.uid()
            )
          )
      )
    )
    WITH CHECK (
      EXISTS (
        SELECT 1 FROM public.attendance_sessions s
        WHERE s.id = session_code_snippets.session_id
          AND (
            public.has_role(auth.uid(), 'Admin'::public.app_role)
            OR public.is_super_admin()
            OR EXISTS (
              SELECT 1 FROM public.course_teachers ct
              WHERE ct.course_id = s.course_id
                AND ct.user_id = auth.uid()
            )
          )
      )
    );
END $$;

NOTIFY pgrst, 'reload schema';
