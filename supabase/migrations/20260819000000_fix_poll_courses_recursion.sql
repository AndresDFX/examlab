-- ──────────────────────────────────────────────────────────────────────
-- Fix: "infinite recursion detected in policy for relation polls"
--
-- Causa raíz (mig 20260603010000_polls_multicourse):
--   - `polls_select_course_members` (en polls) consulta `poll_courses`
--     para validar si el caller es miembro de algún curso linkeado.
--   - `poll_courses_write_teacher` tenía `FOR ALL`, lo que incluye
--     SELECT. Su USING/WITH CHECK consulta `polls`.
--   - Al hacer SELECT en polls → RLS evalúa `polls_select_course_members`
--     → consulta `poll_courses` → RLS evalúa `poll_courses_write_teacher`
--     → consulta `polls` → loop infinito (42P17).
--
-- Síntoma: `GET /rest/v1/polls?deleted_at=not.is.null` (la query del
-- módulo Papelera para listar encuestas eliminadas) devolvía 500. La
-- policy `_select` de polls ya no se evaluaba "limpia" porque PostgreSQL
-- corre TODAS las policies permisivas aplicables y la `_write_teacher`
-- con FOR ALL se sumaba como segunda policy de SELECT.
--
-- Fix: dividir `poll_courses_write_teacher` (FOR ALL) en tres policies
-- separadas para INSERT/UPDATE/DELETE — ninguna aplica sobre SELECT, así
-- que el SELECT de poll_courses solo evalúa `poll_courses_select` (que
-- NO consulta polls) y la recursión se rompe.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.poll_courses') IS NULL THEN
    RAISE NOTICE 'public.poll_courses no existe — se omite';
    RETURN;
  END IF;

  -- Drop la policy FOR ALL problemática.
  EXECUTE 'DROP POLICY IF EXISTS poll_courses_write_teacher ON public.poll_courses';

  -- INSERT — solo el docente del curso ancla del poll. Como es INSERT,
  -- solo necesita WITH CHECK (no hay row preexistente).
  EXECUTE $POLICY$
    CREATE POLICY poll_courses_insert_teacher
      ON public.poll_courses FOR INSERT TO authenticated
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.polls p
           JOIN public.course_teachers ct ON ct.course_id = p.course_id
           WHERE p.id = poll_courses.poll_id AND ct.user_id = auth.uid()
        )
        OR public.has_role(auth.uid(), 'Admin')
        OR public.is_super_admin()
      )
  $POLICY$;

  -- UPDATE — mismo predicado en USING y WITH CHECK.
  EXECUTE $POLICY$
    CREATE POLICY poll_courses_update_teacher
      ON public.poll_courses FOR UPDATE TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.polls p
           JOIN public.course_teachers ct ON ct.course_id = p.course_id
           WHERE p.id = poll_courses.poll_id AND ct.user_id = auth.uid()
        )
        OR public.has_role(auth.uid(), 'Admin')
        OR public.is_super_admin()
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.polls p
           JOIN public.course_teachers ct ON ct.course_id = p.course_id
           WHERE p.id = poll_courses.poll_id AND ct.user_id = auth.uid()
        )
        OR public.has_role(auth.uid(), 'Admin')
        OR public.is_super_admin()
      )
  $POLICY$;

  -- DELETE — solo USING (DELETE no tiene WITH CHECK).
  EXECUTE $POLICY$
    CREATE POLICY poll_courses_delete_teacher
      ON public.poll_courses FOR DELETE TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.polls p
           JOIN public.course_teachers ct ON ct.course_id = p.course_id
           WHERE p.id = poll_courses.poll_id AND ct.user_id = auth.uid()
        )
        OR public.has_role(auth.uid(), 'Admin')
        OR public.is_super_admin()
      )
  $POLICY$;
END $$;

COMMENT ON POLICY poll_courses_insert_teacher ON public.poll_courses IS
  'Reemplaza la rama INSERT de poll_courses_write_teacher (FOR ALL, droppeada en mig 20260819). Sigue requiriendo que el caller sea docente del curso ancla del poll, Admin o SuperAdmin.';

COMMENT ON POLICY poll_courses_update_teacher ON public.poll_courses IS
  'Reemplaza la rama UPDATE de poll_courses_write_teacher (FOR ALL). Mismo predicado, sin aplicar sobre SELECT — eso rompía RLS de polls con recursión 42P17.';

COMMENT ON POLICY poll_courses_delete_teacher ON public.poll_courses IS
  'Reemplaza la rama DELETE de poll_courses_write_teacher (FOR ALL).';
