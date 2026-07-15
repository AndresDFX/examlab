-- Docente: acotar la GESTIÓN a SUS cursos (course_teachers), no a todo el tenant.
--
-- Bug confirmado (verificado empíricamente con SET ROLE): las policies
-- courses_docente_manage y enrollments_docente_manage usaban course_in_my_tenant
-- (cualquier curso del tenant), así que un docente podía EDITAR/BORRAR cursos que
-- NO dicta y MATRICULAR/desmatricular estudiantes en cursos de OTRO docente de la
-- misma institución. El SELECT de enrollments ya usaba _teaches_course (la
-- intención real: cada docente ve/gestiona SUS cursos). Alineamos la gestión.
--
-- INSERT de curso: se mantiene tenant-scoped — el curso aún no existe, y el
-- trigger tg_course_add_creator_teacher asigna al creador como docente, por lo que
-- las ediciones POSTERIORES ya matchean _teaches_course.

DO $$
BEGIN
  IF to_regclass('public.courses') IS NOT NULL THEN
    -- Reemplaza la [ALL] tenant-wide por INSERT (crear) + UPDATE/DELETE (solo propios).
    DROP POLICY IF EXISTS courses_docente_manage ON public.courses;

    DROP POLICY IF EXISTS courses_docente_insert ON public.courses;
    CREATE POLICY courses_docente_insert ON public.courses
      FOR INSERT TO authenticated
      WITH CHECK (
        ((tenant_id = public.current_tenant_id()) AND public.has_role(auth.uid(), 'Docente'::public.app_role))
        OR public.is_super_admin()
      );

    DROP POLICY IF EXISTS courses_docente_update ON public.courses;
    CREATE POLICY courses_docente_update ON public.courses
      FOR UPDATE TO authenticated
      USING (
        (public._teaches_course(id) AND public.has_role(auth.uid(), 'Docente'::public.app_role))
        OR public.is_super_admin()
      )
      WITH CHECK (
        ((tenant_id = public.current_tenant_id()) AND public.has_role(auth.uid(), 'Docente'::public.app_role))
        OR public.is_super_admin()
      );

    DROP POLICY IF EXISTS courses_docente_delete ON public.courses;
    CREATE POLICY courses_docente_delete ON public.courses
      FOR DELETE TO authenticated
      USING (
        (public._teaches_course(id) AND public.has_role(auth.uid(), 'Docente'::public.app_role))
        OR public.is_super_admin()
      );
  END IF;

  IF to_regclass('public.course_enrollments') IS NOT NULL THEN
    -- La gestión de matrículas del docente pasa de "cualquier curso del tenant"
    -- a "solo cursos que dicta" (igual que ya hacía el SELECT).
    ALTER POLICY enrollments_docente_manage ON public.course_enrollments
      USING (public._teaches_course(course_id) AND public.has_role(auth.uid(), 'Docente'::public.app_role))
      WITH CHECK (public._teaches_course(course_id) AND public.has_role(auth.uid(), 'Docente'::public.app_role));
  END IF;
END $$;
