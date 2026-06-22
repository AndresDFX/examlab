-- ════════════════════════════════════════════════════════════════════
-- HOTFIX de seguridad: las funciones close_*_for_course del cascade
-- (mig 20260991) son SECURITY DEFINER e INTERNAS (solo el trigger
-- tg_cascade_close_on_course_finalized debe invocarlas). La mig original
-- hizo `REVOKE ALL ... FROM PUBLIC`, pero en Supabase el rol `authenticated`
-- (y `anon`) tienen EXECUTE concedido por SEPARADO sobre las funciones de
-- `public` (ALTER DEFAULT PRIVILEGES del proyecto), así que el REVOKE de
-- PUBLIC NO los bloqueó: cualquier usuario autenticado podía llamar
-- close_exams_for_course('<cualquier course_id>') y CERRAR contenido de
-- otro curso/tenant (escritura cross-tenant — DoS/vandalismo, ya que la
-- función bypassa RLS). Detectado en la validación e2e post-Publish (todas
-- devolvían HTTP 200 a un authenticated).
--
-- Fix: REVOKE EXECUTE también de `authenticated` y `anon`. El trigger sigue
-- funcionando: tg_cascade_close_on_course_finalized es SECURITY DEFINER (owner
-- postgres) y las invoca por PERFORM con privilegio del OWNER, no del caller —
-- los grants al rol del cliente son irrelevantes para esa ruta.
-- ════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  fn text;
  fns text[] := ARRAY[
    'public.close_exams_for_course(uuid)',
    'public.close_workshops_for_course(uuid)',
    'public.close_projects_for_course(uuid)',
    'public.close_whiteboards_for_course(uuid)',
    'public.close_polls_for_course(uuid)',
    'public.close_forums_for_course(uuid)',
    'public.close_checkin_for_course(uuid)'
  ];
BEGIN
  FOREACH fn IN ARRAY fns LOOP
    IF to_regprocedure(fn) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
