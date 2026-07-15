-- ══════════════════════════════════════════════════════════════════════
-- C7: no existía nada que EXPIRE un check-in de asistencia. Si el docente abre
-- un check-in (10 min por defecto) y cierra la laptop / navega sin pulsar
-- "Cerrar check-in", attendance_sessions.check_in_open queda en true y la fila
-- attendance_check_in_state persiste indefinidamente. La vista del estudiante
-- filtra solo check_in_open=true (no puede leer closes_at — vive en la tabla
-- privada attendance_check_in_state, RLS Docente/Admin) → la tarjeta "Check-in
-- disponible" seguía apareciendo horas/días después de vencida la ventana.
--
-- Fix (raíz, robusto para todas las vías): un pg_cron cada minuto cierra los
-- check-ins cuya ventana ya venció y limpia su estado. Cerrar (true→false) NO
-- dispara el trigger de notificación (que solo reacciona a false→true), y NO
-- marca a nadie ausente (eso sigue siendo la acción explícita del docente).
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.close_expired_attendance_check_ins()
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_closed integer := 0;
BEGIN
  IF to_regclass('public.attendance_check_in_state') IS NULL THEN
    RETURN 0;
  END IF;

  -- Cerrar la sesión (primero, antes de borrar el estado que la referencia).
  UPDATE public.attendance_sessions s
     SET check_in_open = false
    FROM public.attendance_check_in_state st
   WHERE st.session_id = s.id
     AND s.check_in_open IS TRUE
     AND st.closes_at IS NOT NULL
     AND st.closes_at < now();
  GET DIAGNOSTICS v_closed = ROW_COUNT;

  -- Limpiar el estado vencido (la seed nunca debe quedar viva de más).
  DELETE FROM public.attendance_check_in_state st
   WHERE st.closes_at IS NOT NULL
     AND st.closes_at < now();

  RETURN v_closed;
END
$function$;

-- Solo el sistema (cron / service_role) lo invoca; sin GRANT a anon/authenticated.
REVOKE ALL ON FUNCTION public.close_expired_attendance_check_ins() FROM PUBLIC;

DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    RAISE NOTICE 'pg_cron no instalado, salida limpia.';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'close-expired-attendance-checkins') THEN
    PERFORM cron.schedule(
      'close-expired-attendance-checkins',
      '* * * * *',
      $$ SELECT public.close_expired_attendance_check_ins(); $$
    );
  END IF;
END
$cron$;

INSERT INTO public.cron_job_descriptions (jobname, description)
VALUES (
  'close-expired-attendance-checkins',
  'Cada minuto: cierra los check-in de asistencia cuya ventana (closes_at) ya venció y limpia attendance_check_in_state. Evita que la tarjeta "Check-in disponible" quede colgada indefinidamente para el estudiante cuando el docente no la cerró a mano. No marca ausentes (eso es acción explícita del docente).'
)
ON CONFLICT (jobname) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at = now();

NOTIFY pgrst, 'reload schema';
