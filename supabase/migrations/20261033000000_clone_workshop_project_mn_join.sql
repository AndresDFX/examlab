-- ══════════════════════════════════════════════════════════════════════
-- Clonar taller / proyecto: CREAR la fila M:N en workshop_courses /
-- project_courses.
--
-- Hallazgo (validación rol-a-rol, ciclo 4, 2026-06-30): clone_workshop /
-- clone_project insertan SOLO en workshops / projects (con course_id/weight/
-- cut_id en las columnas LEGACY), pero NO crean la fila en las tablas M:N
-- workshop_courses / project_courses. Sin embargo el gradebook
-- (app.teacher.gradebook.tsx), la vista del estudiante (app.student.grades.tsx),
-- el boletín (report-context.ts) y el acta oficial (generate_course_acta) leen
-- el PESO y el CORTE del taller/proyecto EXCLUSIVAMENTE vía esas tablas M:N —
-- NO vía las columnas legacy. Consecuencia:
--
--   • Taller clonado → SIN fila workshop_courses → INVISIBLE en notas hasta
--     que el docente lo re-guarde (verificado: 2 talleres huérfanos en prod).
--   • Proyecto clonado → SIN fila project_courses → el self-heal del front
--     (app.teacher.projects.tsx) lo materializa con weight=1/cut_id=NULL,
--     PERDIENDO el peso y el corte que la copia debía preservar.
--
-- Fix: tras el RETURNING id, crear la fila M:N para el curso destino copiando
-- weight + cut_id de la fila M:N del ORIGEN (para su propio curso), con fallback
-- a la columna legacy. cut_id solo se copia si el destino es el MISMO curso del
-- origen (un corte pertenece a un curso puntual) — idéntico criterio al INSERT
-- de la fila padre. ON CONFLICT DO NOTHING por si el destino ya tuviera la fila.
--
-- Se copian VERBATIM los cuerpos de 20261016000000 (que ya incluyen created_by =
-- auth.uid(), la autorización tenant-scoped is_admin_of_course_tenant y el guard
-- de papelera) + el INSERT M:N. Firma sin cambios → CREATE OR REPLACE. clone_exam
-- NO se toca: los exámenes son 1:N (usan exams.cut_id directo, no una M:N).
-- ══════════════════════════════════════════════════════════════════════

-- ── clone_workshop ──
CREATE OR REPLACE FUNCTION public.clone_workshop(_source_id uuid, _target_course_id uuid, _new_title text DEFAULT NULL::text, _new_start_date timestamp with time zone DEFAULT NULL::timestamp with time zone, _new_due_date timestamp with time zone DEFAULT NULL::timestamp with time zone, _copy_questions boolean DEFAULT true, _copy_groups boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _new_id UUID;
  _final_title TEXT;
BEGIN
  IF NOT (
    (
      public.is_admin_of_course_tenant((SELECT w.course_id FROM public.workshops w WHERE w.id = _source_id))
      AND public.is_admin_of_course_tenant(_target_course_id)
    )
    OR (
      EXISTS (
        SELECT 1 FROM public.workshops w
        JOIN public.course_teachers ct ON ct.course_id = w.course_id
        WHERE w.id = _source_id AND ct.user_id = auth.uid()
      )
      AND EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = _target_course_id AND ct.user_id = auth.uid()
      )
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para clonar este taller al curso destino';
  END IF;

  -- Papelera: no se puede clonar un taller origen en la papelera.
  IF (SELECT w.deleted_at FROM public.workshops w WHERE w.id = _source_id) IS NOT NULL THEN
    RAISE EXCEPTION 'No se puede clonar: el taller origen está en la papelera';
  END IF;

  SELECT COALESCE(_new_title, 'Copia de ' || w.title)
    INTO _final_title
    FROM public.workshops w WHERE w.id = _source_id;

  INSERT INTO public.workshops (
    course_id, created_by, title, description, instructions, start_date, due_date,
    status, weight, is_external, group_mode, group_size_min, group_size_max,
    max_score, cut_id
  )
  SELECT
    _target_course_id, auth.uid(), _final_title, w.description, w.instructions,
    COALESCE(_new_start_date, w.start_date),
    COALESCE(_new_due_date, w.due_date),
    'draft', w.weight, w.is_external,
    CASE WHEN _copy_groups THEN w.group_mode ELSE 'individual' END,
    CASE WHEN _copy_groups THEN w.group_size_min ELSE NULL END,
    CASE WHEN _copy_groups THEN w.group_size_max ELSE NULL END,
    w.max_score,
    CASE WHEN _target_course_id = w.course_id THEN w.cut_id ELSE NULL END
  FROM public.workshops w WHERE w.id = _source_id
  RETURNING id INTO _new_id;

  -- Fila M:N para el curso destino (fuente de verdad de peso/corte en notas).
  INSERT INTO public.workshop_courses (workshop_id, course_id, weight, cut_id)
  SELECT
    _new_id,
    _target_course_id,
    COALESCE(wc.weight, w.weight),
    CASE WHEN _target_course_id = w.course_id THEN COALESCE(wc.cut_id, w.cut_id) ELSE NULL END
  FROM public.workshops w
  LEFT JOIN public.workshop_courses wc
    ON wc.workshop_id = w.id AND wc.course_id = w.course_id
  WHERE w.id = _source_id
  ON CONFLICT (workshop_id, course_id) DO NOTHING;

  IF _copy_questions THEN
    INSERT INTO public.workshop_questions (
      workshop_id, type, content, options, expected_rubric, language, starter_code,
      points, position
    )
    SELECT
      _new_id, q.type, q.content, q.options, q.expected_rubric, q.language, q.starter_code,
      q.points, q.position
    FROM public.workshop_questions q
    WHERE q.workshop_id = _source_id;
  END IF;

  RETURN _new_id;
END
$function$;

-- ── clone_project ──
CREATE OR REPLACE FUNCTION public.clone_project(_source_id uuid, _target_course_id uuid, _new_title text DEFAULT NULL::text, _new_start_date timestamp with time zone DEFAULT NULL::timestamp with time zone, _new_due_date timestamp with time zone DEFAULT NULL::timestamp with time zone, _copy_files boolean DEFAULT true, _copy_groups boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _new_id UUID;
  _final_title TEXT;
BEGIN
  IF NOT (
    (
      public.is_admin_of_course_tenant((SELECT p.course_id FROM public.projects p WHERE p.id = _source_id))
      AND public.is_admin_of_course_tenant(_target_course_id)
    )
    OR (
      EXISTS (
        SELECT 1 FROM public.projects p
        JOIN public.course_teachers ct ON ct.course_id = p.course_id
        WHERE p.id = _source_id AND ct.user_id = auth.uid()
      )
      AND EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = _target_course_id AND ct.user_id = auth.uid()
      )
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para clonar este proyecto al curso destino';
  END IF;

  -- Papelera: no se puede clonar un proyecto origen en la papelera.
  IF (SELECT p.deleted_at FROM public.projects p WHERE p.id = _source_id) IS NOT NULL THEN
    RAISE EXCEPTION 'No se puede clonar: el proyecto origen está en la papelera';
  END IF;

  SELECT COALESCE(_new_title, 'Copia de ' || p.title)
    INTO _final_title
    FROM public.projects p WHERE p.id = _source_id;

  INSERT INTO public.projects (
    course_id, created_by, title, description, instructions, external_link,
    start_date, due_date, status, max_score, weight, is_external,
    group_mode, group_size_min, group_size_max
  )
  SELECT
    _target_course_id, auth.uid(), _final_title, p.description, p.instructions, p.external_link,
    COALESCE(_new_start_date, p.start_date),
    COALESCE(_new_due_date, p.due_date),
    'draft', p.max_score, p.weight, p.is_external,
    CASE WHEN _copy_groups THEN p.group_mode ELSE 'individual' END,
    CASE WHEN _copy_groups THEN p.group_size_min ELSE NULL END,
    CASE WHEN _copy_groups THEN p.group_size_max ELSE NULL END
  FROM public.projects p WHERE p.id = _source_id
  RETURNING id INTO _new_id;

  -- Fila M:N para el curso destino. En proyectos el peso/corte vive SOLO en
  -- project_courses (projects no tiene cut_id legacy). weight es NOT NULL → 1.
  INSERT INTO public.project_courses (project_id, course_id, weight, cut_id)
  SELECT
    _new_id,
    _target_course_id,
    COALESCE(pc.weight, p.weight, 1),
    CASE WHEN _target_course_id = p.course_id THEN pc.cut_id ELSE NULL END
  FROM public.projects p
  LEFT JOIN public.project_courses pc
    ON pc.project_id = p.id AND pc.course_id = p.course_id
  WHERE p.id = _source_id
  ON CONFLICT (project_id, course_id) DO NOTHING;

  IF _copy_files THEN
    INSERT INTO public.project_files (
      project_id, type, title, description, expected_rubric, language,
      starter_code, points, position, options
    )
    SELECT
      _new_id, f.type, f.title, f.description, f.expected_rubric, f.language,
      f.starter_code, f.points, f.position, f.options
    FROM public.project_files f
    WHERE f.project_id = _source_id;
  END IF;

  RETURN _new_id;
END
$function$;

NOTIFY pgrst, 'reload schema';
