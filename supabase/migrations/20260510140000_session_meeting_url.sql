-- Añade `meeting_url` a attendance_sessions: enlace de Meet / Teams /
-- Zoom / Jitsi / etc. que el docente programa por sesión y que el
-- estudiante usa desde el tablero del curso para unirse a la reunión.
-- Es texto libre con CHECK suave de que sea http(s) si está poblado.

ALTER TABLE public.attendance_sessions
  ADD COLUMN IF NOT EXISTS meeting_url TEXT;

ALTER TABLE public.attendance_sessions
  DROP CONSTRAINT IF EXISTS attendance_sessions_meeting_url_check;
ALTER TABLE public.attendance_sessions
  ADD CONSTRAINT attendance_sessions_meeting_url_check CHECK (
    meeting_url IS NULL OR meeting_url ~* '^https?://'
  );
