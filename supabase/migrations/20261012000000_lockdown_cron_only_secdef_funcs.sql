-- ──────────────────────────────────────────────────────────────────────
-- Lockdown de funciones SECURITY DEFINER que SOLO debe invocar pg_cron.
--
-- Hallazgo (auditoría exhaustiva de funciones SECDEF, 2026-06-28): estas 6
-- funciones tenían EXECUTE para PUBLIC (ACL `=X/...`), así que CUALQUIER usuario
-- `authenticated` podía invocarlas vía PostgREST `/rpc/<fn>`. Como son SECURITY
-- DEFINER (bypassan RLS) y NO tienen guard de caller (asumían "solo cron"),
-- esto era escalada de privilegios. La más grave:
--
--   🔴 purge_deleted_items(interval): hard-DELETE de items en papelera (courses,
--      exams, workshops, projects, ... y tenants por cascade) más viejos que el
--      TTL. Verificado: un Docente la ejecutó vía RPC (con TTL=100 años, no borró
--      nada — pero con el default de 30 días habría purgado la papelera de TODOS
--      los tenants).
--
-- Las otras 5 son jobs batch de notificación/finalización por fecha.
-- NINGUNA tiene llamadas `.rpc()` reales en el front/edge (solo aparecían en el
-- archivo de tipos autogenerado o en comentarios) → revocarlas de PUBLIC no
-- rompe ningún flujo cliente. pg_cron corre como postgres/service_role, que
-- conservan EXECUTE (grants explícitos en el ACL) → los cron jobs siguen
-- funcionando.
-- ──────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  sig TEXT;
  sigs TEXT[] := ARRAY[
    'public.purge_deleted_items(interval)',
    'public.auto_finalize_courses()',
    'public.notify_students_course_closing(integer)',
    'public.notify_students_cut_closing(integer)',
    'public.notify_teachers_pending_grading()',
    'public.notify_teachers_workshop_due_tomorrow()'
  ];
BEGIN
  FOREACH sig IN ARRAY sigs LOOP
    IF to_regprocedure(sig) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig);
      -- Aseguramos que service_role conserve EXECUTE (los workers/cron lo usan).
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
    ELSE
      RAISE NOTICE 'omitido (no existe): %', sig;
    END IF;
  END LOOP;
END $$;
