-- ──────────────────────────────────────────────────────────────────────
-- RPCs para clonar examen/taller/proyecto completo a otro curso.
--
-- Clona:
--   - Fila principal (exams/workshops/projects) con todos los campos de
--     configuración (max_warnings, navigation_type, weight, group_mode...)
--   - Preguntas hijas (questions/workshop_questions/project_files)
--
-- NO clona:
--   - Asignaciones de estudiantes
--   - Submissions / calificaciones
--   - Grupos / miembros
--   - Eventos de calendario externos
--
-- Status del clon: 'draft' SIEMPRE — el docente revisa fechas/peso
-- antes de publicar. Title se renombra a "Copia de ..." por default.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) clone_exam ──

CREATE OR REPLACE FUNCTION public.clone_exam(
  _source_id        UUID,
  _target_course_id UUID,
  _new_title        TEXT DEFAULT NULL,
  _new_start_time   TIMESTAMPTZ DEFAULT NULL,
  _new_end_time     TIMESTAMPTZ DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _new_id UUID;
  _final_title TEXT;
  _final_start TIMESTAMPTZ;
  _final_end TIMESTAMPTZ;
BEGIN
  -- El usuario debe poder editar el examen origen Y el curso destino.
  IF NOT (
    public.has_role(auth.uid(), 'Admin')
    OR (
      EXISTS (
        SELECT 1 FROM public.exams e
        JOIN public.course_teachers ct ON ct.course_id = e.course_id
        WHERE e.id = _source_id AND ct.user_id = auth.uid()
      )
      AND EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = _target_course_id AND ct.user_id = auth.uid()
      )
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para clonar este examen al curso destino';
  END IF;

  SELECT
    COALESCE(_new_title, 'Copia de ' || e.title),
    COALESCE(_new_start_time, e.start_time),
    COALESCE(_new_end_time, e.end_time)
    INTO _final_title, _final_start, _final_end
    FROM public.exams e WHERE e.id = _source_id;

  -- Insertar nuevo examen copiando todos los campos relevantes
  INSERT INTO public.exams (
    course_id, title, description, time_limit_minutes, navigation_type,
    shuffle_enabled, start_time, end_time, status, max_warnings,
    weight, max_attempts, retry_mode, is_external, schedule_type,
    cut_id
  )
  SELECT
    _target_course_id, _final_title, e.description, e.time_limit_minutes, e.navigation_type,
    e.shuffle_enabled, _final_start, _final_end, 'draft', e.max_warnings,
    e.weight, e.max_attempts, e.retry_mode, e.is_external, e.schedule_type,
    -- cut_id apunta a un corte del curso ORIGEN — no es válido en el
    -- destino. Dejamos NULL para que el docente lo asigne manualmente.
    CASE WHEN _target_course_id = e.course_id THEN e.cut_id ELSE NULL END
  FROM public.exams e WHERE e.id = _source_id
  RETURNING id INTO _new_id;

  -- Clonar preguntas
  INSERT INTO public.questions (
    exam_id, type, content, options, expected_rubric, language, starter_code,
    points, position
  )
  SELECT
    _new_id, q.type, q.content, q.options, q.expected_rubric, q.language, q.starter_code,
    q.points, q.position
  FROM public.questions q
  WHERE q.exam_id = _source_id;

  RETURN _new_id;
END
$$;

REVOKE ALL ON FUNCTION public.clone_exam(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clone_exam(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- ── 2) clone_workshop ──

CREATE OR REPLACE FUNCTION public.clone_workshop(
  _source_id        UUID,
  _target_course_id UUID,
  _new_title        TEXT DEFAULT NULL,
  _new_start_date   TIMESTAMPTZ DEFAULT NULL,
  _new_due_date     TIMESTAMPTZ DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _new_id UUID;
  _final_title TEXT;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'Admin')
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

  SELECT COALESCE(_new_title, 'Copia de ' || w.title)
    INTO _final_title
    FROM public.workshops w WHERE w.id = _source_id;

  INSERT INTO public.workshops (
    course_id, title, description, instructions, start_date, due_date,
    status, weight, is_external, group_mode, group_size_min, group_size_max,
    max_score, cut_id
  )
  SELECT
    _target_course_id, _final_title, w.description, w.instructions,
    COALESCE(_new_start_date, w.start_date),
    COALESCE(_new_due_date, w.due_date),
    'draft', w.weight, w.is_external, w.group_mode, w.group_size_min, w.group_size_max,
    w.max_score,
    CASE WHEN _target_course_id = w.course_id THEN w.cut_id ELSE NULL END
  FROM public.workshops w WHERE w.id = _source_id
  RETURNING id INTO _new_id;

  INSERT INTO public.workshop_questions (
    workshop_id, type, content, options, expected_rubric, language, starter_code,
    points, position
  )
  SELECT
    _new_id, q.type, q.content, q.options, q.expected_rubric, q.language, q.starter_code,
    q.points, q.position
  FROM public.workshop_questions q
  WHERE q.workshop_id = _source_id;

  RETURN _new_id;
END
$$;

REVOKE ALL ON FUNCTION public.clone_workshop(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clone_workshop(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- ── 3) clone_project ──

CREATE OR REPLACE FUNCTION public.clone_project(
  _source_id        UUID,
  _target_course_id UUID,
  _new_title        TEXT DEFAULT NULL,
  _new_start_date   TIMESTAMPTZ DEFAULT NULL,
  _new_due_date     TIMESTAMPTZ DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _new_id UUID;
  _final_title TEXT;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'Admin')
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

  SELECT COALESCE(_new_title, 'Copia de ' || p.title)
    INTO _final_title
    FROM public.projects p WHERE p.id = _source_id;

  INSERT INTO public.projects (
    course_id, title, description, instructions, external_link,
    start_date, due_date, status, max_score, weight, is_external,
    group_mode, group_size_min, group_size_max
  )
  SELECT
    _target_course_id, _final_title, p.description, p.instructions, p.external_link,
    COALESCE(_new_start_date, p.start_date),
    COALESCE(_new_due_date, p.due_date),
    'draft', p.max_score, p.weight, p.is_external,
    p.group_mode, p.group_size_min, p.group_size_max
  FROM public.projects p WHERE p.id = _source_id
  RETURNING id INTO _new_id;

  -- Clonar archivos esperados (preguntas/slots del proyecto)
  INSERT INTO public.project_files (
    project_id, type, title, description, expected_rubric, language,
    starter_code, points, position, options
  )
  SELECT
    _new_id, f.type, f.title, f.description, f.expected_rubric, f.language,
    f.starter_code, f.points, f.position, f.options
  FROM public.project_files f
  WHERE f.project_id = _source_id;

  RETURN _new_id;
END
$$;

REVOKE ALL ON FUNCTION public.clone_project(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clone_project(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

NOTIFY pgrst, 'reload schema';
