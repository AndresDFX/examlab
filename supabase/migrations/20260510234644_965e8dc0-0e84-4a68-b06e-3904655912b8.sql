ALTER TABLE public.attendance_sessions
  ADD COLUMN IF NOT EXISTS meeting_url TEXT;

ALTER TABLE public.attendance_sessions
  DROP CONSTRAINT IF EXISTS attendance_sessions_meeting_url_check;
ALTER TABLE public.attendance_sessions
  ADD CONSTRAINT attendance_sessions_meeting_url_check CHECK (
    meeting_url IS NULL OR meeting_url ~* '^https?://'
  );