-- ============================================================
-- MIGRATION: RPC to notify exam teachers on student suspension
-- Students cannot INSERT notifications for teachers under the
-- existing RLS policy (only self / Docente / Admin). This function
-- uses SECURITY DEFINER so a suspended student can trigger it.
-- ============================================================

CREATE OR REPLACE FUNCTION public.notify_exam_teachers(
  _exam_id UUID,
  _title TEXT,
  _body TEXT,
  _link TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _count INTEGER := 0;
  _course_id UUID;
  _created_by UUID;
BEGIN
  SELECT e.course_id, e.created_by INTO _course_id, _created_by
  FROM public.exams e WHERE e.id = _exam_id;

  IF _course_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Only the caller's own submission may trigger this
  IF NOT EXISTS (
    SELECT 1 FROM public.submissions s
    WHERE s.exam_id = _exam_id AND s.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- Notify: exam creator + any Docente enrolled in the course
  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT DISTINCT tid, _title, _body, 'exam', _link
  FROM (
    SELECT _created_by AS tid WHERE _created_by IS NOT NULL
    UNION
    SELECT ce.user_id
    FROM public.course_enrollments ce
    JOIN public.user_roles ur ON ur.user_id = ce.user_id
    WHERE ce.course_id = _course_id AND ur.role = 'Docente'
  ) teachers
  WHERE tid IS NOT NULL;

  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.notify_exam_teachers(UUID, TEXT, TEXT, TEXT) TO authenticated;
