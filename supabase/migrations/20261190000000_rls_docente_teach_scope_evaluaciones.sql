-- Docente: acotar la GESTIÓN de evaluaciones/sesiones a SUS cursos (course_teachers),
-- no a todo el tenant. Mismo bug sistémico que ya se arregló en courses/enrollments
-- (20261180000000): las policies *_staff_manage usaban <x>_in_my_tenant (cualquier
-- curso del tenant) + (Docente OR Admin), así que un docente podía CREAR/EDITAR/BORRAR
-- exámenes, talleres, proyectos, sus PREGUNTAS (incl. la respuesta correcta y la
-- rúbrica), archivos de proyecto y sesiones/registros de asistencia de cursos que NO
-- dicta (de otro docente de la misma institución). Verificado empíricamente.
--
-- Fix (molde de intro_videos 20261039 y courses 20261180): separar la rama Docente de
-- la Admin — Admin → <x>_in_my_tenant (todo su tenant), Docente → "dicta el curso",
-- SA → todo. El SELECT queda como está (el alumno del curso ya lo necesita).
--
-- NOTA: las tablas de grupos (workshop_groups/members, project_groups/members) y
-- exam_assignments tienen el MISMO patrón (severidad media) y quedan pendientes con
-- este mismo molde — ver docs/HALLAZGOS-*.

-- ── Helpers "¿el usuario dicta el curso de esta entidad?" (SECURITY DEFINER) ──
CREATE OR REPLACE FUNCTION public._teaches_exam(_exam_id uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.exams e WHERE e.id = _exam_id AND public._teaches_course(e.course_id));
$$;
CREATE OR REPLACE FUNCTION public._teaches_workshop(_workshop_id uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.workshops w WHERE w.id = _workshop_id AND public._teaches_course(w.course_id));
$$;
CREATE OR REPLACE FUNCTION public._teaches_project(_project_id uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = _project_id AND public._teaches_course(p.course_id));
$$;
CREATE OR REPLACE FUNCTION public._teaches_attendance_session(_session_id uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.attendance_sessions s WHERE s.id = _session_id AND public._teaches_course(s.course_id));
$$;

DO $$
DECLARE
  r record;
  -- tabla → (helper de tenant para Admin, helper de "dicta" para Docente, columna id)
  specs jsonb := jsonb_build_array(
    jsonb_build_object('pol','exams_staff_manage','tbl','public.exams','admin','course_in_my_tenant(course_id)','doc','_teaches_course(course_id)'),
    jsonb_build_object('pol','workshops_staff_manage','tbl','public.workshops','admin','course_in_my_tenant(course_id)','doc','_teaches_course(course_id)'),
    jsonb_build_object('pol','projects_staff_manage','tbl','public.projects','admin','course_in_my_tenant(course_id)','doc','_teaches_course(course_id)'),
    jsonb_build_object('pol','attendance_sessions_staff_manage','tbl','public.attendance_sessions','admin','course_in_my_tenant(course_id)','doc','_teaches_course(course_id)'),
    jsonb_build_object('pol','questions_staff_manage','tbl','public.questions','admin','exam_in_my_tenant(exam_id)','doc','_teaches_exam(exam_id)'),
    jsonb_build_object('pol','workshop_questions_staff_manage','tbl','public.workshop_questions','admin','workshop_in_my_tenant(workshop_id)','doc','_teaches_workshop(workshop_id)'),
    jsonb_build_object('pol','project_files_staff_manage','tbl','public.project_files','admin','project_in_my_tenant(project_id)','doc','_teaches_project(project_id)'),
    jsonb_build_object('pol','attendance_records_staff_manage','tbl','public.attendance_records','admin','attendance_session_in_my_tenant(session_id)','doc','_teaches_attendance_session(session_id)')
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
