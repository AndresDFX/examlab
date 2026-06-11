-- ════════════════════════════════════════════════════════════════════
-- FUGA CROSS-TENANT en encuestas (polls + kahoot).
--
-- Bug: TODAS las RLS de polls / poll_courses / poll_options /
-- poll_responses y de las tablas kahoot_* autorizaban con el patrón LAXO
-- `public.has_role(auth.uid(), 'Admin')` (sin scope de tenant). Resultado:
-- un Admin de la institución A veía (y podía editar) las encuestas de la
-- institución B → "las encuestas creadas en un tenant quedaban multitenant".
-- Los clauses de docente/alumno SÍ estaban scopeados por curso (un docente
-- solo enseña cursos de su tenant; un alumno solo está matriculado en los
-- suyos), así que la fuga era exclusiva del rol Admin.
--
-- Fix: reemplazar el `has_role('Admin') OR is_super_admin()` laxo por un
-- chequeo scopeado al tenant del curso de la encuesta:
--   - Tablas con course_id directo (poll_courses): is_admin_of_course_tenant.
--   - Tablas con poll_id (polls/options/responses/kahoot_*): nuevo helper
--     _poll_admin_in_tenant (SECURITY DEFINER → no recursión RLS).
-- Ambos = is_super_admin() OR (Admin AND curso de la encuesta en su tenant).
-- SuperAdmin sigue viendo todo (cross-tenant por diseño; la UI filtra al
-- elegir "ver como" un tenant).
--
-- Redefine la misma superficie de policies que la mig definitiva
-- 20260915000000 (recursión) MÁS las policies de escritura de
-- 20260720000000 (polls/poll_options FOR ALL) y las de kahoot
-- (20260921000100), que no habían sido scopeadas.
-- ════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.polls') IS NULL THEN
    RAISE NOTICE 'polls no existe — se omite';
    RETURN;
  END IF;

  -- ── Helper: ¿el caller es Admin del tenant de la encuesta (o SA)? ──────
  -- SECURITY DEFINER → bypassa RLS de polls/poll_courses/courses, así que no
  -- participa en ningún ciclo de policies (mismo principio que _poll_*).
  -- Una encuesta vive en UN tenant (enforce_course_tenant impide linkear
  -- cursos de tenants distintos), así que basta con que el curso ancla O
  -- cualquier curso linkeado esté en el tenant del Admin.
  CREATE OR REPLACE FUNCTION public._poll_admin_in_tenant(_poll_id uuid, _uid uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
    SELECT public.is_super_admin()
       OR (
         public.has_role(_uid, 'Admin')
         AND EXISTS (
           SELECT 1 FROM public.courses c
            WHERE c.tenant_id = (SELECT tenant_id FROM public.profiles WHERE id = _uid)
              AND (
                c.id = (SELECT course_id FROM public.polls WHERE id = _poll_id)
                OR c.id IN (SELECT course_id FROM public.poll_courses WHERE poll_id = _poll_id)
              )
         )
       )
  $fn$;
  GRANT EXECUTE ON FUNCTION public._poll_admin_in_tenant(uuid, uuid) TO authenticated;

  -- ── poll_courses (course_id directo → is_admin_of_course_tenant) ──────
  EXECUTE 'DROP POLICY IF EXISTS poll_courses_insert_teacher ON public.poll_courses';
  EXECUTE $P$CREATE POLICY poll_courses_insert_teacher ON public.poll_courses
    FOR INSERT TO authenticated
    WITH CHECK (
      public._poll_anchor_teacher(poll_courses.poll_id, auth.uid())
      OR public.is_admin_of_course_tenant(poll_courses.course_id)
    )$P$;

  EXECUTE 'DROP POLICY IF EXISTS poll_courses_update_teacher ON public.poll_courses';
  EXECUTE $P$CREATE POLICY poll_courses_update_teacher ON public.poll_courses
    FOR UPDATE TO authenticated
    USING (
      public._poll_anchor_teacher(poll_courses.poll_id, auth.uid())
      OR public.is_admin_of_course_tenant(poll_courses.course_id)
    )
    WITH CHECK (
      public._poll_anchor_teacher(poll_courses.poll_id, auth.uid())
      OR public.is_admin_of_course_tenant(poll_courses.course_id)
    )$P$;

  EXECUTE 'DROP POLICY IF EXISTS poll_courses_delete_teacher ON public.poll_courses';
  EXECUTE $P$CREATE POLICY poll_courses_delete_teacher ON public.poll_courses
    FOR DELETE TO authenticated
    USING (
      public._poll_anchor_teacher(poll_courses.poll_id, auth.uid())
      OR public.is_admin_of_course_tenant(poll_courses.course_id)
    )$P$;

  EXECUTE 'DROP POLICY IF EXISTS poll_courses_select ON public.poll_courses';
  EXECUTE $P$CREATE POLICY poll_courses_select ON public.poll_courses
    FOR SELECT TO authenticated
    USING (
      EXISTS (SELECT 1 FROM public.course_teachers ct
               WHERE ct.course_id = poll_courses.course_id AND ct.user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.course_enrollments ce
                  WHERE ce.course_id = poll_courses.course_id AND ce.user_id = auth.uid())
      OR public.is_admin_of_course_tenant(poll_courses.course_id)
    )$P$;

  -- ── polls SELECT (helper anti-recursión + admin scopeado) ─────────────
  EXECUTE 'DROP POLICY IF EXISTS polls_select_course_members ON public.polls';
  EXECUTE $P$CREATE POLICY polls_select_course_members ON public.polls
    FOR SELECT TO authenticated
    USING (
      public._poll_has_member(polls.id, auth.uid())
      OR public._poll_admin_in_tenant(polls.id, auth.uid())
    )$P$;

  -- ── polls WRITE (FOR ALL) — antes laxo (mig 20260720000000) ───────────
  EXECUTE 'DROP POLICY IF EXISTS polls_write_course_teacher ON public.polls';
  EXECUTE $P$CREATE POLICY polls_write_course_teacher ON public.polls
    FOR ALL TO authenticated
    USING (
      EXISTS (SELECT 1 FROM public.course_teachers
               WHERE course_id = polls.course_id AND user_id = auth.uid())
      OR public.is_admin_of_course_tenant(polls.course_id)
    )
    WITH CHECK (
      EXISTS (SELECT 1 FROM public.course_teachers
               WHERE course_id = polls.course_id AND user_id = auth.uid())
      OR public.is_admin_of_course_tenant(polls.course_id)
    )$P$;

  -- ── poll_options SELECT + WRITE ───────────────────────────────────────
  IF to_regclass('public.poll_options') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS poll_options_select ON public.poll_options';
    EXECUTE $P$CREATE POLICY poll_options_select ON public.poll_options
      FOR SELECT TO authenticated
      USING (
        public._poll_has_member(poll_options.poll_id, auth.uid())
        OR public._poll_admin_in_tenant(poll_options.poll_id, auth.uid())
      )$P$;

    EXECUTE 'DROP POLICY IF EXISTS poll_options_write_teacher ON public.poll_options';
    EXECUTE $P$CREATE POLICY poll_options_write_teacher ON public.poll_options
      FOR ALL TO authenticated
      USING (
        public._poll_anchor_teacher(poll_options.poll_id, auth.uid())
        OR public._poll_admin_in_tenant(poll_options.poll_id, auth.uid())
      )
      WITH CHECK (
        public._poll_anchor_teacher(poll_options.poll_id, auth.uid())
        OR public._poll_admin_in_tenant(poll_options.poll_id, auth.uid())
      )$P$;
  END IF;

  -- ── poll_responses SELECT ─────────────────────────────────────────────
  IF to_regclass('public.poll_responses') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS poll_responses_select_own_or_teacher ON public.poll_responses';
    EXECUTE $P$CREATE POLICY poll_responses_select_own_or_teacher ON public.poll_responses
      FOR SELECT TO authenticated
      USING (
        poll_responses.user_id = auth.uid()
        OR public._poll_linked_teacher(poll_responses.poll_id, auth.uid())
        OR public._poll_admin_in_tenant(poll_responses.poll_id, auth.uid())
      )$P$;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- KAHOOT — mismas tablas, mismo patrón laxo (mig 20260921000100). Kahoot es
-- un tipo de encuesta, así que su contenido también fugaba a Admins de otros
-- tenants. Scopeamos con _poll_admin_in_tenant (poll_id derivado por tabla).
-- ════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.kahoot_questions') IS NULL THEN
    RAISE NOTICE 'kahoot no existe — se omite';
    RETURN;
  END IF;

  -- kahoot_questions (poll_id directo)
  EXECUTE 'DROP POLICY IF EXISTS kahoot_questions_rw ON public.kahoot_questions';
  EXECUTE $P$CREATE POLICY kahoot_questions_rw ON public.kahoot_questions FOR ALL
    USING (public._poll_anchor_teacher(poll_id, auth.uid()) OR public._poll_admin_in_tenant(poll_id, auth.uid()))
    WITH CHECK (public._poll_anchor_teacher(poll_id, auth.uid()) OR public._poll_admin_in_tenant(poll_id, auth.uid()))$P$;

  -- kahoot_question_options (poll_id vía la pregunta)
  EXECUTE 'DROP POLICY IF EXISTS kahoot_q_options_rw ON public.kahoot_question_options';
  EXECUTE $P$CREATE POLICY kahoot_q_options_rw ON public.kahoot_question_options FOR ALL
    USING (EXISTS (
      SELECT 1 FROM public.kahoot_questions q
      WHERE q.id = question_id
        AND (public._poll_anchor_teacher(q.poll_id, auth.uid()) OR public._poll_admin_in_tenant(q.poll_id, auth.uid()))
    ))
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.kahoot_questions q
      WHERE q.id = question_id
        AND (public._poll_anchor_teacher(q.poll_id, auth.uid()) OR public._poll_admin_in_tenant(q.poll_id, auth.uid()))
    ))$P$;

  -- kahoot_games (poll_id directo)
  EXECUTE 'DROP POLICY IF EXISTS kahoot_games_select ON public.kahoot_games';
  EXECUTE $P$CREATE POLICY kahoot_games_select ON public.kahoot_games FOR SELECT
    USING (public._poll_has_member(poll_id, auth.uid()) OR public._poll_admin_in_tenant(poll_id, auth.uid()))$P$;

  -- kahoot_players (poll_id vía el juego)
  EXECUTE 'DROP POLICY IF EXISTS kahoot_players_select ON public.kahoot_players';
  EXECUTE $P$CREATE POLICY kahoot_players_select ON public.kahoot_players FOR SELECT
    USING (EXISTS (
      SELECT 1 FROM public.kahoot_games g
      WHERE g.id = game_id
        AND (public._poll_has_member(g.poll_id, auth.uid()) OR public._poll_admin_in_tenant(g.poll_id, auth.uid()))
    ))$P$;

  -- kahoot_answers (propias del jugador, o docente/admin-tenant del juego)
  EXECUTE 'DROP POLICY IF EXISTS kahoot_answers_select ON public.kahoot_answers';
  EXECUTE $P$CREATE POLICY kahoot_answers_select ON public.kahoot_answers FOR SELECT
    USING (
      EXISTS (SELECT 1 FROM public.kahoot_players p WHERE p.id = player_id AND p.user_id = auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.kahoot_games g
        WHERE g.id = game_id
          AND (public._poll_anchor_teacher(g.poll_id, auth.uid()) OR public._poll_admin_in_tenant(g.poll_id, auth.uid()))
      )
    )$P$;
END $$;

NOTIFY pgrst, 'reload schema';
