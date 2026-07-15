-- Cierra la clase sistémica de sobre-permiso del docente (media): exam_assignments +
-- grupos de talleres/proyectos. Mismo molde que 20261180/20261190: la rama Docente de
-- *_staff_manage pasa de <x>_in_my_tenant (todo el tenant) a "dicta el curso".
-- Antes: un docente asignaba/desasignaba alumnos a exámenes ajenos y creaba/editaba
-- grupos + membresías (PII, signup_code) de talleres/proyectos de otro docente.

CREATE OR REPLACE FUNCTION public._teaches_workshop_group(_group_id uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.workshop_groups g WHERE g.id = _group_id AND public._teaches_workshop(g.workshop_id));
$$;
CREATE OR REPLACE FUNCTION public._teaches_project_group(_group_id uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.project_groups g WHERE g.id = _group_id AND public._teaches_project(g.project_id));
$$;

DO $$
DECLARE
  r record;
  specs jsonb := jsonb_build_array(
    jsonb_build_object('pol','exam_assignments_staff_manage','tbl','public.exam_assignments','admin','exam_in_my_tenant(exam_id)','doc','_teaches_exam(exam_id)'),
    jsonb_build_object('pol','workshop_groups_staff_manage','tbl','public.workshop_groups','admin','workshop_in_my_tenant(workshop_id)','doc','_teaches_workshop(workshop_id)'),
    jsonb_build_object('pol','workshop_group_members_staff_manage','tbl','public.workshop_group_members','admin','workshop_group_in_my_tenant(group_id)','doc','_teaches_workshop_group(group_id)'),
    jsonb_build_object('pol','project_groups_staff_manage','tbl','public.project_groups','admin','project_in_my_tenant(project_id)','doc','_teaches_project(project_id)'),
    jsonb_build_object('pol','project_group_members_staff_manage','tbl','public.project_group_members','admin','project_group_in_my_tenant(group_id)','doc','_teaches_project_group(group_id)')
  );
  expr text;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(specs) AS e(v)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = split_part(r.v->>'tbl','.',2)
        AND policyname = r.v->>'pol'
    ) THEN
      expr := format(
        '((public.has_role(auth.uid(), ''Admin''::public.app_role) AND public.%s) OR (public.has_role(auth.uid(), ''Docente''::public.app_role) AND public.%s) OR public.is_super_admin())',
        r.v->>'admin', r.v->>'doc'
      );
      EXECUTE format('ALTER POLICY %I ON %s USING (%s) WITH CHECK (%s)',
        r.v->>'pol', r.v->>'tbl', expr, expr);
    END IF;
  END LOOP;
END $$;
