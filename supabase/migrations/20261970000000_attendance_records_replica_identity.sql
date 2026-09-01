-- ══════════════════════════════════════════════════════════════════════════
-- El contador de presentes de la proyección de check-in no se movía.
--
-- ── Lo medido ─────────────────────────────────────────────────────────────
-- La pantalla proyectada decía "0 / 21" con QUINCE filas ya en `presente` para
-- esa misma sesión (verificado en producción). O sea: la carga inicial funcionó
-- —en ese momento había 0— y los quince check-in posteriores nunca llegaron al
-- canal.
--
-- ── Una causa que sí se puede cerrar desde acá ────────────────────────────
-- `attendance_records` está en la publicación `supabase_realtime` desde la
-- migración 20260507100000, pero NUNCA se le puso `REPLICA IDENTITY FULL`. Sin
-- eso, en un UPDATE el WAL solo lleva la clave primaria de la fila vieja, y
-- Realtime no puede evaluar la política de RLS contra ella: descarta el evento
-- en silencio.
--
-- Y acá los UPDATE son el camino NORMAL, no el raro: `student_check_in_attendance`
-- escribe con
--   INSERT … ON CONFLICT (session_id, user_id) DO UPDATE SET status = 'presente'
-- así que cualquier alumno que ya tuviera una fila —porque el docente pasó lista
-- antes, porque se marcó y volvió a escanear, o porque estaba en 'ausente'— entra
-- por el UPDATE. Lo mismo cuando el docente corrige un estado desde su grilla.
--
-- Las demás tablas realtime del proyecto ya la tienen puesta a propósito
-- (`notifications`, `ai_grading_queue`, `poll_options`, `poll_responses`,
-- `kahoot_games`, `kahoot_players`); esta se quedó afuera.
--
-- ── Lo que esto NO garantiza, y por eso además hay sondeo ─────────────────
-- La política de esta tabla pasa por `attendance_session_in_my_tenant`, que a su
-- vez resuelve el tenant del perfil. Evaluar eso dentro del canal de Realtime es
-- frágil, y un canal que no engancha no deja ningún rastro en pantalla: el
-- contador simplemente no se mueve. Por eso la proyección ahora refresca cada 8 s
-- ADEMÁS del canal (mismo criterio que `use-notifications`, que poll-ea cada 15 s
-- teniendo realtime). Esta migración quita una causa conocida; el sondeo es el
-- que garantiza que el número de la pared sea cierto.
-- ══════════════════════════════════════════════════════════════════════════

DO $mig$
BEGIN
  IF to_regclass('public.attendance_records') IS NULL THEN
    RAISE NOTICE 'Sin attendance_records: nada que hacer.';
    RETURN;
  END IF;

  ALTER TABLE public.attendance_records REPLICA IDENTITY FULL;
  RAISE NOTICE 'attendance_records: REPLICA IDENTITY FULL aplicada.';
END $mig$;

-- Defensivo: si por lo que sea la tabla no estaba publicada, se agrega. El
-- bloque tolera el duplicado porque `ADD TABLE` de algo ya publicado lanza.
DO $pub$
BEGIN
  IF to_regclass('public.attendance_records') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'Sin publicacion supabase_realtime: nada que agregar.';
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'attendance_records'
  ) THEN
    RAISE NOTICE 'attendance_records ya estaba publicada.';
    RETURN;
  END IF;
  ALTER PUBLICATION supabase_realtime ADD TABLE public.attendance_records;
  RAISE NOTICE 'attendance_records agregada a supabase_realtime.';
END $pub$;
