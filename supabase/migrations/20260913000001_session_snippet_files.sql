-- ──────────────────────────────────────────────────────────────────────
-- Multi-archivo para snippets de código de sesión.
--
-- Hoy `session_code_snippets.source_code` guarda UN solo archivo. Esta
-- migración agrega `session_snippet_files`: N archivos por snippet, cada
-- uno con su filename + content + position. Permite, por ejemplo, un
-- ejemplo Java con varias clases en archivos separados que se compilan
-- juntas.
--
-- Backward-compatible:
--   - `source_code` queda como fallback legacy (NO se borra). Snippets
--     viejos sin filas en session_snippet_files se siguen mostrando como
--     un único archivo derivado de source_code.
--   - Cuando un snippet tiene filas en session_snippet_files, esas filas
--     son la fuente de verdad de los archivos.
--
-- Modelo:
--   parent = session_code_snippets
--   child  = session_snippet_files (N por snippet)
--
-- RLS heredada del snippet via EXISTS sub-query a session_code_snippets
-- (que a su vez deriva la pertenencia al curso de attendance_sessions).
-- Docente del curso CRUD, alumno SELECT — mismo patrón que
-- session_code_snippets.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.session_code_snippets') IS NULL THEN
    RAISE NOTICE 'public.session_code_snippets no existe — abortando creación de session_snippet_files';
    RETURN;
  END IF;

  CREATE TABLE IF NOT EXISTS public.session_snippet_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snippet_id UUID NOT NULL REFERENCES public.session_code_snippets(id) ON DELETE CASCADE,
    -- Nombre del archivo tal cual lo escribe el docente (ej. Main.java,
    -- Util.java, helper.py). Para Java DEBE coincidir con el nombre de la
    -- clase pública del archivo — la UI sugiere el filename pero no fuerza
    -- el constraint (el compilador remoto/local da el error real si no
    -- coincide).
    filename TEXT NOT NULL DEFAULT 'Main.java',
    content TEXT NOT NULL DEFAULT '',
    -- Posición ordinal dentro del snippet. 0-indexed, gaps tolerados
    -- (mismo patrón que session_code_snippets.position).
    position INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_session_snippet_files_snippet
    ON public.session_snippet_files(snippet_id, position);

  -- ── RLS ───────────────────────────────────────────────────────────
  -- Hereda del snippet padre: si el caller puede SELECT/escribir el
  -- snippet (ver policies de session_code_snippets), puede SELECT/escribir
  -- sus archivos. Evitamos repetir el árbol de course_teachers /
  -- course_enrollments aquí — delegamos a una sub-query sobre la tabla
  -- padre que YA tiene RLS aplicada implícitamente vía EXISTS (la
  -- sub-query corre con las policies del caller).
  ALTER TABLE public.session_snippet_files ENABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS session_snippet_files_select ON public.session_snippet_files;
  CREATE POLICY session_snippet_files_select
    ON public.session_snippet_files FOR SELECT TO authenticated
    USING (
      EXISTS (
        SELECT 1
        FROM public.session_code_snippets sn
        JOIN public.attendance_sessions s ON s.id = sn.session_id
        WHERE sn.id = session_snippet_files.snippet_id
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

  DROP POLICY IF EXISTS session_snippet_files_write ON public.session_snippet_files;
  CREATE POLICY session_snippet_files_write
    ON public.session_snippet_files FOR ALL TO authenticated
    USING (
      EXISTS (
        SELECT 1
        FROM public.session_code_snippets sn
        JOIN public.attendance_sessions s ON s.id = sn.session_id
        WHERE sn.id = session_snippet_files.snippet_id
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
        SELECT 1
        FROM public.session_code_snippets sn
        JOIN public.attendance_sessions s ON s.id = sn.session_id
        WHERE sn.id = session_snippet_files.snippet_id
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
