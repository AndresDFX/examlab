-- ══════════════════════════════════════════════════════════════════════
-- SECURITY DEFINER RPC: cerrar authz gaps (workflow validación).
--
-- Barrido de funciones SECURITY DEFINER en public con EXECUTE a authenticated/anon
-- que actúan sin verificar al caller. Dos clases con fix distinto:
--
-- (A) Diagnósticos de PLATAFORMA — solo los llama el edge `health-check` con
--     SERVICE_ROLE, pero estaban GRANT a anon + authenticated → cualquiera (incluso
--     SIN autenticar) podía leer definiciones de cron, tamaño de DB, extensiones y
--     stats de edge functions. Fix: REVOKE EXECUTE de anon + authenticated (queda
--     service_role, que es lo único que los usa). Igual `tenant_role_count`, que solo
--     lo llaman el edge admin-set-user-active (service_role) y tenant_user_counts
--     (SECURITY DEFINER → corre como owner, no necesita el grant de authenticated).
--
-- (B) Contadores de errores IA por entidad — los llama el docente (user JWT) desde su
--     dashboard, pero devolvían TODOS los exams/projects/workshops de TODOS los tenants
--     (solo id + count, sin scope). El cliente ya usa únicamente sus propios ids, así
--     que acotar server-side al curso accesible del caller (docente del curso / Admin
--     del tenant / SuperAdmin) NO cambia la UI y cierra la fuga de ids+conteos ajenos.
-- ══════════════════════════════════════════════════════════════════════

-- ─── (A) REVOKE diagnósticos de plataforma (solo service_role los usa) ─────
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.system_cron_jobs()',
    'public.system_storage_usage()',
    'public.system_db_extensions()',
    'public.system_edge_function_stats()',
    'public.tenant_role_count(uuid, public.app_role)'
  ] LOOP
    IF to_regprocedure(fn) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated', fn);
    END IF;
  END LOOP;
END $$;

-- ─── (B) Contadores de errores IA acotados al curso accesible del caller ───
-- Predicado de acceso: docente del curso, o Admin del tenant del curso, o SA
-- (is_admin_of_course_tenant ya = SA OR Admin-mismo-tenant).

CREATE OR REPLACE FUNCTION public.count_ai_errors_per_exam()
 RETURNS TABLE(exam_id uuid, error_count bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT s.exam_id, COUNT(*)::bigint AS error_count
  FROM public.submissions s
  JOIN public.exams e ON e.id = s.exam_id
  WHERE s.submitted_at IS NOT NULL
    AND jsonb_path_exists(s.answers, '$."__breakdown"[*]."ai_error"')
    AND (
      public.is_admin_of_course_tenant(e.course_id)
      OR EXISTS (SELECT 1 FROM public.course_teachers ct
                 WHERE ct.course_id = e.course_id AND ct.user_id = auth.uid())
    )
  GROUP BY s.exam_id;
$function$;

CREATE OR REPLACE FUNCTION public.count_ai_errors_per_project()
 RETURNS TABLE(project_id uuid, error_count bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ps.project_id, COUNT(DISTINCT ps.id)::bigint AS error_count
  FROM public.project_submissions ps
  JOIN public.project_submission_files psf ON psf.submission_id = ps.id
  JOIN public.projects p ON p.id = ps.project_id
  WHERE psf.ai_feedback ~* 'error\s*ia|internal error: code execution|el modelo no'
    AND (
      public.is_admin_of_course_tenant(p.course_id)
      OR EXISTS (SELECT 1 FROM public.course_teachers ct
                 WHERE ct.course_id = p.course_id AND ct.user_id = auth.uid())
    )
  GROUP BY ps.project_id;
$function$;

CREATE OR REPLACE FUNCTION public.count_ai_errors_per_workshop()
 RETURNS TABLE(workshop_id uuid, error_count bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ws.workshop_id, COUNT(DISTINCT ws.id)::bigint AS error_count
  FROM public.workshop_submissions ws
  JOIN public.workshop_submission_answers wsa ON wsa.submission_id = ws.id
  JOIN public.workshops w ON w.id = ws.workshop_id
  WHERE wsa.ai_feedback ~* 'error\s*ia|internal error: code execution|el modelo no'
    AND (
      public.is_admin_of_course_tenant(w.course_id)
      OR EXISTS (SELECT 1 FROM public.course_teachers ct
                 WHERE ct.course_id = w.course_id AND ct.user_id = auth.uid())
    )
  GROUP BY ws.workshop_id;
$function$;

NOTIFY pgrst, 'reload schema';
