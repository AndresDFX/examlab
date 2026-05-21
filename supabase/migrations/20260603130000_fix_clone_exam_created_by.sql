-- Fix clone_exam: missing created_by (NOT NULL) in INSERT caused 23502
-- not_null_violation when duplicating any exam.

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

  INSERT INTO public.exams (
    course_id, created_by, title, description, time_limit_minutes, navigation_type,
    shuffle_enabled, start_time, end_time, status, max_warnings,
    weight, max_attempts, retry_mode, is_external, schedule_type,
    cut_id
  )
  SELECT
    _target_course_id, auth.uid(), _final_title, e.description, e.time_limit_minutes, e.navigation_type,
    e.shuffle_enabled, _final_start, _final_end, 'draft', e.max_warnings,
    e.weight, e.max_attempts, e.retry_mode, e.is_external, e.schedule_type,
    CASE WHEN _target_course_id = e.course_id THEN e.cut_id ELSE NULL END
  FROM public.exams e WHERE e.id = _source_id
  RETURNING id INTO _new_id;

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

NOTIFY pgrst, 'reload schema';
