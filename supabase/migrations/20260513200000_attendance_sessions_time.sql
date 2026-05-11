-- ──────────────────────────────────────────────────────────────────────
-- Attendance sessions: hora de inicio + duración reales.
--
-- Antes la edge function `calendar` hardcodeaba las sesiones a las
-- 09:00 hora Bogotá con 90 min de duración (ver `toIsoEvent` —
-- `// TODO V2: tomar la hora real cuando la tabla la guarde.`). Esta
-- migración agrega las dos columnas para que el docente pueda
-- programar sesiones con su hora real.
--
-- Diseño:
--   - `start_time TIME` (HH:MM:SS, sin zona). Tomado como hora local
--     de Bogotá al construir el ISO datetime para Google Calendar.
--     Nullable: si no se llena, mantenemos el comportamiento legado
--     (09:00 Bogotá).
--   - `duration_minutes INT`. Default 90 (mantiene el comportamiento
--     actual). Rango razonable 15..480.
--
-- NO se migra `session_date` a TIMESTAMPTZ porque eso rompería
-- muchísimas queries existentes (filtros por DATE en grades, gradebook,
-- attendance grouping, etc.). Mantenemos `session_date DATE` + `start_time`
-- como dos columnas — el JOIN se hace en cliente / edge function.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.attendance_sessions
  ADD COLUMN IF NOT EXISTS start_time TIME,
  ADD COLUMN IF NOT EXISTS duration_minutes INT;

ALTER TABLE public.attendance_sessions
  DROP CONSTRAINT IF EXISTS attendance_sessions_duration_check;
ALTER TABLE public.attendance_sessions
  ADD CONSTRAINT attendance_sessions_duration_check
    CHECK (duration_minutes IS NULL OR (duration_minutes BETWEEN 15 AND 480));

-- Forzar reload del schema cache de PostgREST para que el frontend
-- reciba el campo nuevo sin esperar al refresh automático.
NOTIFY pgrst, 'reload schema';
