-- ══════════════════════════════════════════════════════════════════════
-- Fix cross-tenant leak — session_code_snippets + session_snippet_files.
--
-- Las 4 policies (SELECT + write [ALL] de ambas tablas) tenían la rama
-- `has_role(auth.uid(),'Admin')` SIN scope de tenant → anti-patrón documentado
-- en CLAUDE.md: un Admin del tenant A podía LEER y ESCRIBIR (source_code,
-- filenames, contenidos, last_stdout/stderr) los snippets de código de clase de
-- CUALQUIER sesión de CUALQUIER curso del tenant B, vía REST directo.
--
-- La tabla hermana (attendance_records / attendance_check_in_state), que cuelga
-- del MISMO padre (attendance_sessions → course_id → tenant), SÍ fue scopeada en
-- rounds previos (20260945/20260996). Estas dos quedaron fuera; las reescrituras
-- de papelera (20261020/20261024) re-copiaron la rama Admin cruda.
--
-- Fix: gatear la rama Admin con `course_in_my_tenant(s.course_id)` (SECURITY
-- DEFINER, ya usado en todo el repo). is_super_admin() (bypass cross-tenant),
-- course_teachers, y las ramas alumno/papelera quedan intactas. ALTER POLICY
-- preserva cmd/roles/permissive. Reproducción verbatim del qual + gate.
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.session_code_snippets') IS NOT NULL THEN
    -- SELECT: alumno (code_shared + papelera), docente, Admin-del-tenant, SA.
    EXECUTE $pol$
      ALTER POLICY session_code_snippets_select ON public.session_code_snippets
        USING (EXISTS (
          SELECT 1 FROM public.attendance_sessions s
          WHERE s.id = session_code_snippets.session_id
            AND (
              public.is_super_admin()
              OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND public.course_in_my_tenant(s.course_id))
              OR EXISTS (SELECT 1 FROM public.course_teachers ct WHERE ct.course_id = s.course_id AND ct.user_id = auth.uid())
              OR (COALESCE(s.code_shared, false) = true AND s.deleted_at IS NULL AND NOT public._course_in_papelera(s.course_id)
                  AND EXISTS (SELECT 1 FROM public.course_enrollments ce WHERE ce.course_id = s.course_id AND ce.user_id = auth.uid()))
            )
        ))
    $pol$;

    -- write [ALL]: solo staff del tenant (docente del curso / Admin del tenant / SA).
    EXECUTE $pol$
      ALTER POLICY session_code_snippets_write ON public.session_code_snippets
        USING (EXISTS (
          SELECT 1 FROM public.attendance_sessions s
          WHERE s.id = session_code_snippets.session_id
            AND (
              public.is_super_admin()
              OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND public.course_in_my_tenant(s.course_id))
              OR EXISTS (SELECT 1 FROM public.course_teachers ct WHERE ct.course_id = s.course_id AND ct.user_id = auth.uid())
            )
        ))
        WITH CHECK (EXISTS (
          SELECT 1 FROM public.attendance_sessions s
          WHERE s.id = session_code_snippets.session_id
            AND (
              public.is_super_admin()
              OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND public.course_in_my_tenant(s.course_id))
              OR EXISTS (SELECT 1 FROM public.course_teachers ct WHERE ct.course_id = s.course_id AND ct.user_id = auth.uid())
            )
        ))
    $pol$;
  END IF;

  IF to_regclass('public.session_snippet_files') IS NOT NULL THEN
    -- SELECT: docente, Admin-del-tenant, SA, y alumno matriculado (lectura del archivo).
    EXECUTE $pol$
      ALTER POLICY session_snippet_files_select ON public.session_snippet_files
        USING (EXISTS (
          SELECT 1 FROM public.session_code_snippets sn
          JOIN public.attendance_sessions s ON s.id = sn.session_id
          WHERE sn.id = session_snippet_files.snippet_id
            AND (
              public.is_super_admin()
              OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND public.course_in_my_tenant(s.course_id))
              OR EXISTS (SELECT 1 FROM public.course_teachers ct WHERE ct.course_id = s.course_id AND ct.user_id = auth.uid())
              OR EXISTS (SELECT 1 FROM public.course_enrollments ce WHERE ce.course_id = s.course_id AND ce.user_id = auth.uid())
            )
        ))
    $pol$;

    EXECUTE $pol$
      ALTER POLICY session_snippet_files_write ON public.session_snippet_files
        USING (EXISTS (
          SELECT 1 FROM public.session_code_snippets sn
          JOIN public.attendance_sessions s ON s.id = sn.session_id
          WHERE sn.id = session_snippet_files.snippet_id
            AND (
              public.is_super_admin()
              OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND public.course_in_my_tenant(s.course_id))
              OR EXISTS (SELECT 1 FROM public.course_teachers ct WHERE ct.course_id = s.course_id AND ct.user_id = auth.uid())
            )
        ))
        WITH CHECK (EXISTS (
          SELECT 1 FROM public.session_code_snippets sn
          JOIN public.attendance_sessions s ON s.id = sn.session_id
          WHERE sn.id = session_snippet_files.snippet_id
            AND (
              public.is_super_admin()
              OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND public.course_in_my_tenant(s.course_id))
              OR EXISTS (SELECT 1 FROM public.course_teachers ct WHERE ct.course_id = s.course_id AND ct.user_id = auth.uid())
            )
        ))
    $pol$;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
