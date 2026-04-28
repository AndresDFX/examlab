-- Session lock for exam taking: prevents the same submission from being
-- active on multiple devices simultaneously.
-- exam_session_id: unique token per browser session (generated client-side)
-- session_heartbeat_at: updated every ~8s by the active tab; expires = lock released

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS exam_session_id text,
  ADD COLUMN IF NOT EXISTS session_heartbeat_at timestamptz;
