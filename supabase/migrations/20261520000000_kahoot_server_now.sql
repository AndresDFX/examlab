-- Reto en vivo: hora del servidor para anclar el cronómetro del jugador.
--
-- WHY: el countdown de cada pregunta (secondsLeft/getReadySecondsLeft) se calcula
-- en el cliente con `Date.now()` contra `question_started_at` (timestamp del
-- servidor). Si el reloj del DISPOSITIVO va adelantado, el cronómetro arranca
-- casi vencido → se salta el splash "¡Prepárate!", la grilla se deshabilita al
-- instante y se dispara el auto-envío en blanco que DEJA AL ALUMNO BLOQUEADO
-- para esa pregunta. Incidente real (FESNA, jul-2026): un alumno con el reloj
-- ~12 s adelantado no pudo responder ninguna pregunta.
--
-- Este RPC liviano deja que el cliente mida el desfase reloj-dispositivo↔servidor
-- una vez al entrar al juego y corrija todos los cronómetros. Es de solo lectura
-- y no expone nada sensible (solo la hora actual del servidor).
CREATE OR REPLACE FUNCTION public.kahoot_server_now()
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT now();
$function$;

REVOKE ALL ON FUNCTION public.kahoot_server_now() FROM public;
GRANT EXECUTE ON FUNCTION public.kahoot_server_now() TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
