-- ──────────────────────────────────────────────────────────────────────
-- Fix DEFINITIVO de la recursión 42P17 entre poll_courses ↔ polls.
--
-- Síntoma: al crear/asociar una encuesta a cursos, el INSERT en
-- poll_courses devuelve:
--   "infinite recursion detected in policy for relation poll_courses" (42P17)
--
-- Causa: las policies cruzaban tablas con subqueries que disparan la RLS
-- de la tabla referenciada:
--   - poll_courses (write) consulta polls  →  RLS de polls
--   - polls (select) consulta poll_courses →  RLS de poll_courses
--   → ciclo infinito.
-- La mig 20260819000000 intentó romperlo separando el FOR ALL, pero el
-- ciclo persiste si quedó una policy vieja o si el entorno marcó esa
-- migración como aplicada sin ejecutarla (caso conocido en este deploy).
--
-- Solución a prueba de balas: las verificaciones cross-table se mueven a
-- funciones SECURITY DEFINER. Una función SECURITY DEFINER NO evalúa la
-- RLS de las tablas que consulta internamente → rompe cualquier ciclo
-- posible, sin importar el estado previo de las policies. La semántica se
-- preserva EXACTAMENTE:
--   - escritura de poll_courses: docente del curso ANCLA (polls.course_id)
--   - lectura de polls/options:  docente o alumno de ALGÚN curso linkeado
--   - lectura de poll_responses: propias, o docente de algún curso linkeado
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.poll_courses') IS NULL OR to_regclass('public.polls') IS NULL THEN
    RAISE NOTICE 'polls/poll_courses no existen — se omite';
    RETURN;
  END IF;

  -- ── Helpers SECURITY DEFINER (bypassan RLS → no recursión) ──────────

  -- ¿El caller es docente del curso ANCLA del poll? (autoriza escritura)
  CREATE OR REPLACE FUNCTION public._poll_anchor_teacher(_poll_id uuid, _uid uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
    SELECT EXISTS (
      SELECT 1 FROM public.polls p
       JOIN public.course_teachers ct ON ct.course_id = p.course_id
       WHERE p.id = _poll_id AND ct.user_id = _uid
    )
  $fn$;

  -- ¿El caller es docente o alumno de ALGÚN curso linkeado? (autoriza lectura)
  CREATE OR REPLACE FUNCTION public._poll_has_member(_poll_id uuid, _uid uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
    SELECT EXISTS (
      SELECT 1 FROM public.poll_courses pc
       JOIN public.course_teachers ct ON ct.course_id = pc.course_id
       WHERE pc.poll_id = _poll_id AND ct.user_id = _uid
    ) OR EXISTS (
      SELECT 1 FROM public.poll_courses pc
       JOIN public.course_enrollments ce ON ce.course_id = pc.course_id
       WHERE pc.poll_id = _poll_id AND ce.user_id = _uid
    )
  $fn$;

  -- ¿El caller es docente de ALGÚN curso linkeado? (ver respuestas ajenas;
  -- NO incluye alumnos — preserva la privacidad del policy original)
  CREATE OR REPLACE FUNCTION public._poll_linked_teacher(_poll_id uuid, _uid uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
    SELECT EXISTS (
      SELECT 1 FROM public.poll_courses pc
       JOIN public.course_teachers ct ON ct.course_id = pc.course_id
       WHERE pc.poll_id = _poll_id AND ct.user_id = _uid
    )
  $fn$;

  GRANT EXECUTE ON FUNCTION public._poll_anchor_teacher(uuid, uuid) TO authenticated;
  GRANT EXECUTE ON FUNCTION public._poll_has_member(uuid, uuid) TO authenticated;
  GRANT EXECUTE ON FUNCTION public._poll_linked_teacher(uuid, uuid) TO authenticated;

  -- ── poll_courses: dropear TODAS las policies de escritura conocidas
  --    (la FOR ALL vieja + las split de 20260819) y recrear SIN subquery
  --    directa a polls. ──────────────────────────────────────────────
  EXECUTE 'DROP POLICY IF EXISTS poll_courses_write_teacher ON public.poll_courses';
  EXECUTE 'DROP POLICY IF EXISTS poll_courses_insert_teacher ON public.poll_courses';
  EXECUTE 'DROP POLICY IF EXISTS poll_courses_update_teacher ON public.poll_courses';
  EXECUTE 'DROP POLICY IF EXISTS poll_courses_delete_teacher ON public.poll_courses';

  EXECUTE $P$CREATE POLICY poll_courses_insert_teacher ON public.poll_courses
    FOR INSERT TO authenticated
    WITH CHECK (
      public._poll_anchor_teacher(poll_courses.poll_id, auth.uid())
      OR public.has_role(auth.uid(), 'Admin')
      OR public.is_super_admin()
    )$P$;

  EXECUTE $P$CREATE POLICY poll_courses_update_teacher ON public.poll_courses
    FOR UPDATE TO authenticated
    USING (
      public._poll_anchor_teacher(poll_courses.poll_id, auth.uid())
      OR public.has_role(auth.uid(), 'Admin')
      OR public.is_super_admin()
    )
    WITH CHECK (
      public._poll_anchor_teacher(poll_courses.poll_id, auth.uid())
      OR public.has_role(auth.uid(), 'Admin')
      OR public.is_super_admin()
    )$P$;

  EXECUTE $P$CREATE POLICY poll_courses_delete_teacher ON public.poll_courses
    FOR DELETE TO authenticated
    USING (
      public._poll_anchor_teacher(poll_courses.poll_id, auth.uid())
      OR public.has_role(auth.uid(), 'Admin')
      OR public.is_super_admin()
    )$P$;

  -- poll_courses_select: lee course_teachers/course_enrollments directo
  -- (NO consulta polls), así que no participa en el ciclo. Lo recreamos
  -- por idempotencia/consistencia.
  EXECUTE 'DROP POLICY IF EXISTS poll_courses_select ON public.poll_courses';
  EXECUTE $P$CREATE POLICY poll_courses_select ON public.poll_courses
    FOR SELECT TO authenticated
    USING (
      EXISTS (SELECT 1 FROM public.course_teachers ct
               WHERE ct.course_id = poll_courses.course_id AND ct.user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.course_enrollments ce
                  WHERE ce.course_id = poll_courses.course_id AND ce.user_id = auth.uid())
      OR public.has_role(auth.uid(), 'Admin')
      OR public.is_super_admin()
    )$P$;

  -- ── polls SELECT: usar el helper (rompe el ciclo) ──────────────────
  EXECUTE 'DROP POLICY IF EXISTS polls_select_course_members ON public.polls';
  EXECUTE $P$CREATE POLICY polls_select_course_members ON public.polls
    FOR SELECT TO authenticated
    USING (
      public._poll_has_member(polls.id, auth.uid())
      OR public.has_role(auth.uid(), 'Admin')
      OR public.is_super_admin()
    )$P$;

  -- ── poll_options SELECT: helper (evita leer polls/poll_courses con RLS) ──
  IF to_regclass('public.poll_options') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS poll_options_select ON public.poll_options';
    EXECUTE $P$CREATE POLICY poll_options_select ON public.poll_options
      FOR SELECT TO authenticated
      USING (
        public._poll_has_member(poll_options.poll_id, auth.uid())
        OR public.has_role(auth.uid(), 'Admin')
        OR public.is_super_admin()
      )$P$;
  END IF;

  -- ── poll_responses SELECT: propias o docente de algún curso linkeado ──
  IF to_regclass('public.poll_responses') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS poll_responses_select_own_or_teacher ON public.poll_responses';
    EXECUTE $P$CREATE POLICY poll_responses_select_own_or_teacher ON public.poll_responses
      FOR SELECT TO authenticated
      USING (
        poll_responses.user_id = auth.uid()
        OR public._poll_linked_teacher(poll_responses.poll_id, auth.uid())
        OR public.has_role(auth.uid(), 'Admin')
        OR public.is_super_admin()
      )$P$;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
