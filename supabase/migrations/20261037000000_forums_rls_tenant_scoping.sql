-- ══════════════════════════════════════════════════════════════════════
-- Foros: cerrar el leak cross-tenant en las ramas de rol Admin sin scope.
--
-- Hallazgo (validación rol-a-rol, ciclo 6, 2026-06-30): las policies de
-- forums_select / forum_threads_select / forums_update / forum_threads_update
-- YA scopean la rama Admin con `has_role('Admin') AND course_in_my_tenant(...)`.
-- Pero quedaron con `has_role('Admin')` SIN scope de tenant (anti-patrón
-- documentado en CLAUDE.md, arreglado en 20260929/20260945 para otras tablas):
--   • forums_insert_teacher       (INSERT)
--   • forum_threads_insert        (INSERT)
--   • forum_replies_insert        (INSERT)
--   • forum_replies_update        (UPDATE)
--   • forum_replies_select        (SELECT)  ← leak de LECTURA
-- Como has_role('Admin') es un rol GLOBAL, un Admin de CUALQUIER institución
-- podía leer/crear/editar foros, hilos y respuestas de cursos de OTRA
-- institución (forum_replies_select además no tenía `OR is_super_admin()` que
-- sus hermanas sí tienen). Actualmente NO hay datos de foros en prod → leak
-- latente, se cierra antes de que el módulo se use.
--
-- Fix: scopear la rama Admin con course_in_my_tenant (por el course_id del hilo
-- en el caso de replies) y agregar `OR is_super_admin()` para paridad con las
-- policies hermanas (el dueño de plataforma ve/gestiona todo). Las ramas de
-- docente (course_teachers) y estudiante (course_enrollments) ya son
-- implícitamente tenant-scoped y no se tocan.
--
-- ALTER POLICY solo cambia la expresión (preserva cmd + roles). Guardado por
-- to_regclass por si el módulo de foros no existe en un entorno a medio migrar.
-- ══════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF to_regclass('public.forums') IS NOT NULL THEN
    ALTER POLICY forums_insert_teacher ON public.forums
    WITH CHECK (
      (created_by = auth.uid()) AND (
        (has_role(auth.uid(), 'Admin'::app_role) AND public.course_in_my_tenant(course_id))
        OR EXISTS (SELECT 1 FROM public.course_teachers ct WHERE ct.course_id = forums.course_id AND ct.user_id = auth.uid())
        OR public.is_super_admin()
      )
    );
  END IF;

  IF to_regclass('public.forum_threads') IS NOT NULL THEN
    ALTER POLICY forum_threads_insert ON public.forum_threads
    WITH CHECK (
      (author_id = auth.uid()) AND (
        (has_role(auth.uid(), 'Admin'::app_role) AND public.course_in_my_tenant(course_id))
        OR EXISTS (SELECT 1 FROM public.course_teachers ct WHERE ct.course_id = forum_threads.course_id AND ct.user_id = auth.uid())
        OR (
          EXISTS (SELECT 1 FROM public.course_enrollments ce WHERE ce.course_id = forum_threads.course_id AND ce.user_id = auth.uid())
          AND public.is_forum_open(forum_id) AND NOT public._course_in_papelera(course_id)
        )
        OR public.is_super_admin()
      )
    );
  END IF;

  IF to_regclass('public.forum_replies') IS NOT NULL THEN
    ALTER POLICY forum_replies_insert ON public.forum_replies
    WITH CHECK (
      (author_id = auth.uid()) AND EXISTS (
        SELECT 1 FROM public.forum_threads t
        WHERE t.id = forum_replies.thread_id AND t.is_locked = false AND (
          (has_role(auth.uid(), 'Admin'::app_role) AND public.course_in_my_tenant(t.course_id))
          OR EXISTS (SELECT 1 FROM public.course_teachers ct WHERE ct.course_id = t.course_id AND ct.user_id = auth.uid())
          OR (
            EXISTS (SELECT 1 FROM public.course_enrollments ce WHERE ce.course_id = t.course_id AND ce.user_id = auth.uid())
            AND public.is_forum_open(t.forum_id) AND NOT public._course_in_papelera(t.course_id)
          )
          OR public.is_super_admin()
        )
      )
    );

    ALTER POLICY forum_replies_update ON public.forum_replies
    USING (
      (author_id = auth.uid())
      OR (
        has_role(auth.uid(), 'Admin'::app_role)
        AND EXISTS (SELECT 1 FROM public.forum_threads t WHERE t.id = forum_replies.thread_id AND public.course_in_my_tenant(t.course_id))
      )
      OR EXISTS (
        SELECT 1 FROM public.forum_threads t
        JOIN public.course_teachers ct ON ct.course_id = t.course_id
        WHERE t.id = forum_replies.thread_id AND ct.user_id = auth.uid()
      )
      OR public.is_super_admin()
    );

    ALTER POLICY forum_replies_select ON public.forum_replies
    USING (
      EXISTS (
        SELECT 1 FROM public.forum_threads t
        WHERE t.id = forum_replies.thread_id AND (
          (has_role(auth.uid(), 'Admin'::app_role) AND public.course_in_my_tenant(t.course_id))
          OR EXISTS (SELECT 1 FROM public.course_teachers ct WHERE ct.course_id = t.course_id AND ct.user_id = auth.uid())
          OR (
            EXISTS (SELECT 1 FROM public.course_enrollments ce WHERE ce.course_id = t.course_id AND ce.user_id = auth.uid())
            AND NOT public._course_in_papelera(t.course_id)
          )
          OR public.is_super_admin()
        )
      )
    );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
