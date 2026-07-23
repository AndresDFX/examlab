-- ══════════════════════════════════════════════════════════════════════
-- Tipo de sesión: Presencial | Virtual | Autónoma.
--
-- CONTEXTO: hasta ahora una attendance_session no tenía "modalidad". Se agrega
-- para distinguir:
--   • presencial — clase en el aula (check-in por QR rotativo).
--   • virtual    — clase por videollamada (meeting_url).
--   • autonoma   — el alumno revisa el material por su cuenta; al llegar la
--                  fecha/hora de inicio se le NOTIFICA para que lo revise, y
--                  "asiste" marcando el material como revisado (ver la RPC
--                  student_review_autonomous_session en la migración siguiente).
--
-- DEFAULT 'virtual': el pedido de negocio es que TODOS los registros existentes
-- queden como virtual. El NOT NULL DEFAULT hace que Postgres rellene las filas
-- existentes automáticamente (sin UPDATE aparte). OJO: course_schedules.modalidad
-- usa DEFAULT 'presencial'; acá el default es 'virtual' a propósito (decisión de
-- negocio para el backfill de las sesiones históricas).
--
-- notified_start_at: guard de idempotencia del cron que notifica el inicio de
-- las sesiones autónomas (ver migración 20261490000000). NULL = aún no notificada.
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.attendance_sessions') IS NULL THEN
    RAISE NOTICE 'public.attendance_sessions no existe — abortando migración session_type';
    RETURN;
  END IF;

  ALTER TABLE public.attendance_sessions
    ADD COLUMN IF NOT EXISTS session_type TEXT NOT NULL DEFAULT 'virtual';

  -- CHECK idempotente (DROP + ADD por si se reagenda la migración).
  ALTER TABLE public.attendance_sessions
    DROP CONSTRAINT IF EXISTS attendance_sessions_session_type_check;
  ALTER TABLE public.attendance_sessions
    ADD CONSTRAINT attendance_sessions_session_type_check
    CHECK (session_type IN ('presencial', 'virtual', 'autonoma'));

  ALTER TABLE public.attendance_sessions
    ADD COLUMN IF NOT EXISTS notified_start_at TIMESTAMPTZ NULL;

  COMMENT ON COLUMN public.attendance_sessions.session_type IS
    'Modalidad de la sesión: presencial | virtual | autonoma. Default virtual (backfill de históricos, decisión de negocio).';
  COMMENT ON COLUMN public.attendance_sessions.notified_start_at IS
    'Marca cuándo el cron notificó el inicio de una sesión autónoma (anti-reenvío). NULL = aún no notificada.';

  -- Índice parcial para que el cron encuentre rápido las autónomas due sin notificar.
  CREATE INDEX IF NOT EXISTS idx_attendance_sessions_autonoma_pending
    ON public.attendance_sessions (session_date, start_time)
    WHERE session_type = 'autonoma' AND notified_start_at IS NULL AND deleted_at IS NULL;
END $$;

NOTIFY pgrst, 'reload schema';
