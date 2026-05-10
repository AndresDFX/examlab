-- 1. Drop tabla huérfana confirmada por code_deadscan
DROP TABLE IF EXISTS public.course_grading_weights CASCADE;

-- 2. Tabla de tokens de Google Calendar por docente
CREATE TABLE public.teacher_google_tokens (
  teacher_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  refresh_token  text NOT NULL,
  access_token   text,
  expires_at     timestamptz,
  calendar_id    text,
  calendar_name  text,
  google_email   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.teacher_google_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY tgt_owner_all ON public.teacher_google_tokens
  FOR ALL TO authenticated
  USING (teacher_id = auth.uid() OR public.has_role(auth.uid(), 'Admin'::app_role))
  WITH CHECK (teacher_id = auth.uid() OR public.has_role(auth.uid(), 'Admin'::app_role));

CREATE TRIGGER trg_teacher_google_tokens_touch
  BEFORE UPDATE ON public.teacher_google_tokens
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Mapping de sesión <-> evento de Google
ALTER TABLE public.attendance_sessions
  ADD COLUMN IF NOT EXISTS google_event_id text;

CREATE INDEX IF NOT EXISTS idx_attendance_sessions_google_event_id
  ON public.attendance_sessions(google_event_id)
  WHERE google_event_id IS NOT NULL;