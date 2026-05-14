-- ──────────────────────────────────────────────────────────────────────
-- Funciones de diagnóstico del sistema — extensiones de DB + última
-- invocación de cada edge function conocida.
--
-- Estas funciones las llama `health-check` (edge) con service_role para
-- alimentar el panel `/app/admin/system`. NO se exponen al rol
-- authenticated — no hay razón para que un usuario normal vea las
-- extensiones instaladas o los registros de auditoría de funciones que
-- no le tocan.
--
-- 1) system_db_extensions() — qué extensiones de Postgres están
--    instaladas + versión. Útil para detectar si pg_net, vault,
--    pgsodium, etc. están disponibles antes de pelearse con migraciones
--    fallidas.
--
-- 2) system_edge_function_stats() — para cada edge function conocida,
--    cuándo se invocó por última vez y con qué resultado. Las invocaciones
--    se infieren del módulo de auditoría — cada edge que logea con
--    `audit_email_event`, `logEvent`, etc. queda registrado ahí. Las
--    funciones que NO loguean a audit (calendar-ics, send-push) aparecen
--    con last_invoked_at = NULL hasta que se instrumenten.
-- ──────────────────────────────────────────────────────────────────────

-- 1) ─────────────────────────────────────── extensiones de Postgres

CREATE OR REPLACE FUNCTION public.system_db_extensions()
RETURNS TABLE(name text, version text, schema text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    e.extname::text   AS name,
    e.extversion::text AS version,
    n.nspname::text   AS schema
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  ORDER BY e.extname;
$$;

REVOKE ALL ON FUNCTION public.system_db_extensions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.system_db_extensions() TO service_role;

-- 2) ──────────────────────────────────── stats de edge functions

CREATE OR REPLACE FUNCTION public.system_edge_function_stats()
RETURNS TABLE(
  function_name      text,
  last_invoked_at    timestamptz,
  last_action        text,
  last_severity      text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  fn record;
BEGIN
  -- Lista hardcoded de edge functions del proyecto + sus action keys
  -- en audit_logs. Mantenenmos sincronizado con `supabase/functions/`.
  -- Si una función nueva se agrega y queremos verla acá, hay que
  -- registrarla en este VALUES + asegurar que loguea con esos actions.
  FOR fn IN
    SELECT * FROM (VALUES
      ('send-email',
        ARRAY['email.dispatched','email.delivered','email.failed','email.skipped']::text[]),
      ('health-check',
        ARRAY['system.diagnostic.edge_function_failed','system.diagnostic.warnings_detected']::text[]),
      ('ai-grade-submission',
        ARRAY['ai.grading_started','ai.grading_failed']::text[]),
      ('ai-generate-questions',
        ARRAY['ai.questions_generation_failed']::text[]),
      ('detect-plagiarism',
        ARRAY['fraud.plagiarism_detection_started','fraud.plagiarism_detected','fraud.plagiarism_detection_failed']::text[]),
      ('send-push', ARRAY[]::text[]),
      ('calendar-ics', ARRAY[]::text[])
    ) AS x(fname, patterns)
  LOOP
    function_name := fn.fname;
    last_invoked_at := NULL;
    last_action := NULL;
    last_severity := NULL;

    IF array_length(fn.patterns, 1) IS NOT NULL THEN
      SELECT al.created_at, al.action, al.severity
        INTO last_invoked_at, last_action, last_severity
        FROM public.audit_logs al
       WHERE al.action = ANY(fn.patterns)
       ORDER BY al.created_at DESC
       LIMIT 1;
    END IF;

    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.system_edge_function_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.system_edge_function_stats() TO service_role;

NOTIFY pgrst, 'reload schema';
