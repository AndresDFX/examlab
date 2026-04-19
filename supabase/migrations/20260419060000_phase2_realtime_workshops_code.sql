-- ============================================================
-- MIGRATION: Realtime Timer Controls, Code Execution, Workshops
-- ============================================================

-- ============ EXAM TIMER CONTROLS (Realtime) ============
-- Stores teacher interventions on exam timers (pause, add time)
CREATE TABLE public.exam_timer_controls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id UUID NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  target_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE, -- NULL = global (all students)
  action TEXT NOT NULL, -- 'pause' | 'resume' | 'add_time'
  extra_seconds INTEGER DEFAULT 0,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.exam_timer_controls ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_timer_controls_exam ON public.exam_timer_controls(exam_id);
CREATE INDEX idx_timer_controls_target ON public.exam_timer_controls(target_user_id);

-- RLS: Teachers/Admins can manage, students can read their own or global
CREATE POLICY "Teachers/Admins manage timer controls"
  ON public.exam_timer_controls FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));

CREATE POLICY "Students see own or global timer controls"
  ON public.exam_timer_controls FOR SELECT TO authenticated
  USING (target_user_id = auth.uid() OR target_user_id IS NULL);

-- Enable Realtime for timer controls
ALTER PUBLICATION supabase_realtime ADD TABLE public.exam_timer_controls;

-- ============ CODE EXECUTION LOGS ============
CREATE TABLE public.code_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID REFERENCES public.submissions(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  language TEXT NOT NULL DEFAULT 'java', -- java | python | javascript
  source_code TEXT NOT NULL,
  stdin TEXT DEFAULT '',
  stdout TEXT,
  stderr TEXT,
  exit_code INTEGER,
  execution_time_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | completed | error | timeout
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.code_executions ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_code_exec_submission ON public.code_executions(submission_id);
CREATE INDEX idx_code_exec_user ON public.code_executions(user_id);

CREATE POLICY "Users see own code executions"
  ON public.code_executions FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));
CREATE POLICY "Users insert own code executions"
  ON public.code_executions FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Teachers/Admins manage code executions"
  ON public.code_executions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));

-- ============ QUESTIONS: Add language field for code questions ============
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'java';
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS starter_code TEXT;
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS test_cases JSONB;

-- ============ WORKSHOPS (Phase 2) ============
CREATE TABLE public.workshops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  title TEXT NOT NULL,
  description TEXT,
  instructions TEXT,
  external_link TEXT,
  ai_generated BOOLEAN NOT NULL DEFAULT false,
  due_date TIMESTAMPTZ,
  rubric JSONB, -- AI grading rubric criteria
  max_score NUMERIC NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | published | closed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.workshops ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER workshops_updated BEFORE UPDATE ON public.workshops
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_workshops_course ON public.workshops(course_id);
CREATE INDEX idx_workshops_created_by ON public.workshops(created_by);

CREATE POLICY "Authenticated view workshops"
  ON public.workshops FOR SELECT TO authenticated USING (true);
CREATE POLICY "Docentes/Admins manage workshops"
  ON public.workshops FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));

-- ============ WORKSHOP ASSIGNMENTS ============
CREATE TABLE public.workshop_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id UUID NOT NULL REFERENCES public.workshops(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workshop_id, user_id)
);
ALTER TABLE public.workshop_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own workshop assignments"
  ON public.workshop_assignments FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));
CREATE POLICY "Docentes/Admins manage workshop assignments"
  ON public.workshop_assignments FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));

-- ============ WORKSHOP SUBMISSIONS ============
CREATE TABLE public.workshop_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id UUID NOT NULL REFERENCES public.workshops(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT, -- text content or notes
  file_url TEXT, -- uploaded file URL
  external_link TEXT, -- student's external link
  ai_grade NUMERIC,
  ai_feedback TEXT,
  final_grade NUMERIC,
  teacher_feedback TEXT,
  status TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | entregado | calificado
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workshop_id, user_id)
);
ALTER TABLE public.workshop_submissions ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER workshop_submissions_updated BEFORE UPDATE ON public.workshop_submissions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_ws_submissions_workshop ON public.workshop_submissions(workshop_id);
CREATE INDEX idx_ws_submissions_user ON public.workshop_submissions(user_id);

CREATE POLICY "Users see own workshop submissions"
  ON public.workshop_submissions FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));
CREATE POLICY "Users insert own workshop submissions"
  ON public.workshop_submissions FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own workshop submissions"
  ON public.workshop_submissions FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));
CREATE POLICY "Docentes/Admins delete workshop submissions"
  ON public.workshop_submissions FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));
