-- Tabla de preguntas de talleres (mismo modelo que questions de exámenes)
CREATE TABLE public.workshop_questions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workshop_id UUID NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('abierta','cerrada','codigo','diagrama')),
  content TEXT NOT NULL,
  options JSONB,
  position INTEGER NOT NULL DEFAULT 0,
  points NUMERIC NOT NULL DEFAULT 1,
  expected_rubric TEXT,
  starter_code TEXT,
  test_cases JSONB,
  language TEXT DEFAULT 'java',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_workshop_questions_workshop ON public.workshop_questions(workshop_id);

ALTER TABLE public.workshop_questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated view workshop questions"
ON public.workshop_questions FOR SELECT TO authenticated
USING (true);

CREATE POLICY "Docentes/Admins manage workshop questions"
ON public.workshop_questions FOR ALL TO authenticated
USING (has_role(auth.uid(), 'Docente'::app_role) OR has_role(auth.uid(), 'Admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'Docente'::app_role) OR has_role(auth.uid(), 'Admin'::app_role));

-- Tabla de respuestas de estudiantes a preguntas de taller
CREATE TABLE public.workshop_submission_answers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  submission_id UUID NOT NULL,
  question_id UUID NOT NULL,
  answer_text TEXT,
  selected_option TEXT,
  code_content TEXT,
  diagram_code TEXT,
  ai_grade NUMERIC,
  ai_feedback TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (submission_id, question_id)
);

CREATE INDEX idx_workshop_answers_submission ON public.workshop_submission_answers(submission_id);
CREATE INDEX idx_workshop_answers_question ON public.workshop_submission_answers(question_id);

ALTER TABLE public.workshop_submission_answers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own workshop answers"
ON public.workshop_submission_answers FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.workshop_submissions ws
    WHERE ws.id = submission_id
      AND (ws.user_id = auth.uid()
           OR has_role(auth.uid(), 'Docente'::app_role)
           OR has_role(auth.uid(), 'Admin'::app_role))
  )
);

CREATE POLICY "Users insert own workshop answers"
ON public.workshop_submission_answers FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.workshop_submissions ws
    WHERE ws.id = submission_id AND ws.user_id = auth.uid()
  )
  OR has_role(auth.uid(), 'Docente'::app_role)
  OR has_role(auth.uid(), 'Admin'::app_role)
);

CREATE POLICY "Users update own workshop answers"
ON public.workshop_submission_answers FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.workshop_submissions ws
    WHERE ws.id = submission_id
      AND (ws.user_id = auth.uid()
           OR has_role(auth.uid(), 'Docente'::app_role)
           OR has_role(auth.uid(), 'Admin'::app_role))
  )
);

CREATE POLICY "Docentes/Admins delete workshop answers"
ON public.workshop_submission_answers FOR DELETE TO authenticated
USING (has_role(auth.uid(), 'Docente'::app_role) OR has_role(auth.uid(), 'Admin'::app_role));

CREATE TRIGGER update_workshop_answers_updated_at
BEFORE UPDATE ON public.workshop_submission_answers
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();