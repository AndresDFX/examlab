-- ============================================================
-- MIGRATION: Attendance module + grading weights per course
-- ============================================================

-- Grading weights per course (what % each component is worth)
CREATE TABLE public.course_grading_weights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  component TEXT NOT NULL, -- 'asistencia' | 'talleres' | 'parciales' | custom name
  weight NUMERIC NOT NULL DEFAULT 0, -- percentage (0-100)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(course_id, component)
);
ALTER TABLE public.course_grading_weights ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_grading_weights_course ON public.course_grading_weights(course_id);

CREATE POLICY "Authenticated view grading weights"
  ON public.course_grading_weights FOR SELECT TO authenticated USING (true);
CREATE POLICY "Docentes/Admins manage grading weights"
  ON public.course_grading_weights FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));

-- Attendance sessions
CREATE TABLE public.attendance_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  session_date DATE NOT NULL,
  title TEXT, -- optional label like "Clase 1", "Laboratorio 3"
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(course_id, session_date, title)
);
ALTER TABLE public.attendance_sessions ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_attendance_sessions_course ON public.attendance_sessions(course_id);

CREATE POLICY "Authenticated view attendance sessions"
  ON public.attendance_sessions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Docentes/Admins manage attendance sessions"
  ON public.attendance_sessions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));

-- Attendance records (per student per session)
CREATE TABLE public.attendance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.attendance_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'presente', -- presente | ausente | tardanza | justificado
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, user_id)
);
ALTER TABLE public.attendance_records ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_attendance_records_session ON public.attendance_records(session_id);
CREATE INDEX idx_attendance_records_user ON public.attendance_records(user_id);

CREATE POLICY "Users see own attendance"
  ON public.attendance_records FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));
CREATE POLICY "Docentes/Admins manage attendance"
  ON public.attendance_records FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));
