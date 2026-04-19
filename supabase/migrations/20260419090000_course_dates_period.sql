-- ============================================================
-- MIGRATION: Course dates, period, and teacher assignment
-- ============================================================

-- Add date fields and period to courses
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS period TEXT;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS end_date DATE;

-- Teacher-course assignment (which teacher owns which course)
CREATE TABLE IF NOT EXISTS public.course_teachers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(course_id, user_id)
);
ALTER TABLE public.course_teachers ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_course_teachers_course ON public.course_teachers(course_id);
CREATE INDEX IF NOT EXISTS idx_course_teachers_user ON public.course_teachers(user_id);

CREATE POLICY "Authenticated view course_teachers"
  ON public.course_teachers FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins manage course_teachers"
  ON public.course_teachers FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Admin'));
CREATE POLICY "Docentes manage own course_teachers"
  ON public.course_teachers FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') AND auth.uid() = user_id)
  WITH CHECK (public.has_role(auth.uid(), 'Docente') AND auth.uid() = user_id);
