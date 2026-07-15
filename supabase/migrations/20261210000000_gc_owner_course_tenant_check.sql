-- generated_contents_owner (#14 del barrido RLS, baja): la rama del DUEÑO
-- (teacher_id=auth.uid()) no acotaba course_id, mientras la de Admin sí exige
-- course_in_my_tenant. Así un docente podía anclar su contenido a un curso de OTRO
-- tenant (o a cualquiera). No es leak directo (la visibilidad al alumno va por
-- content_course_assignments/sessions, con su propia RLS), pero es inconsistente y
-- deja el course_id sin scope. Aplicamos el mismo check de tenant a dueño + admin.
-- No rompe el flujo normal: el docente ancla su contenido a un curso de SU tenant
-- (o course_id NULL = general); solo se bloquea el cross-tenant.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='generated_contents' AND policyname='generated_contents_owner'
  ) THEN
    ALTER POLICY generated_contents_owner ON public.generated_contents
      USING (
        (((teacher_id = auth.uid()) OR public.has_role(auth.uid(), 'Admin'::public.app_role))
          AND ((course_id IS NULL) OR public.course_in_my_tenant(course_id)))
        OR public.is_super_admin()
      )
      WITH CHECK (
        (((teacher_id = auth.uid()) OR public.has_role(auth.uid(), 'Admin'::public.app_role))
          AND ((course_id IS NULL) OR public.course_in_my_tenant(course_id)))
        OR public.is_super_admin()
      );
  END IF;
END $$;
