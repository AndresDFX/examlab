-- ═══════════════════════════════════════════════════════════════════════
-- El cron de cierre deja de preguntar por cada intento en curso
-- ═══════════════════════════════════════════════════════════════════════
-- `close_expired_exam_attempts()` corre CADA MINUTO. Su CTE de candidatos
-- llamaba, POR CADA intento en curso, a dos funciones:
--
--   · `exam_attempt_deadline(s.id)`, que vuelve a leer `submissions` y `exams`
--     por clave primaria —datos que el JOIN de afuera YA trae— y además suma
--     el tiempo extra de `exam_timer_controls`.
--   · `exam_attempt_paused(...)`, que consulta `exam_timer_controls` otra vez.
--
-- Son ~4 consultas por alumno por minuto. Con 32 exámenes a la vez, unas 128
-- por minuto, sobre la misma tabla que esos 32 alumnos están escribiendo. Y
-- todo para descubrir que ningún examen que termina a las 22:00 venció a las
-- 20:15. Es parte de la carga que tumbó la instancia el 22-09.
--
-- ── El filtro previo, y por qué NO deja escapar ningún intento ─────────
-- El plazo efectivo es `base + extra`, donde `base` es `end_time` (horario
-- normal) o `started_at + time_limit_minutes` (relativo), y `extra` es tiempo
-- concedido: SIEMPRE ≥ 0. O sea que el plazo efectivo nunca es ANTERIOR al
-- base. Por lo tanto «el base todavía no venció» implica «el plazo tampoco»,
-- y ese intento se puede descartar sin calcular nada.
--
-- Es una condición NECESARIA, no suficiente: los que pasan el filtro siguen
-- pagando el cálculo exacto, con el tiempo extra y la pausa. Lo único que
-- cambia es que durante un examen en marcha no se paga por nadie.
--
-- `exam_attempt_paused` se evalúa DESPUÉS del filtro por el mismo motivo:
-- preguntar si está pausado un intento que ni siquiera llegó a su plazo es
-- trabajo tirado.
--
-- El minuto de gracia del `WHERE` de abajo se conserva tal cual; acá se resta
-- el mismo minuto para que el filtro no pueda descartar un candidato que la
-- condición final sí aceptaría.
CREATE OR REPLACE FUNCTION public.close_expired_exam_attempts()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_n    integer := 0;
  v_ids  uuid[];
  v_id   uuid;
BEGIN
  IF to_regclass('public.submissions') IS NULL THEN
    RETURN 0;
  END IF;

  WITH posibles AS (
    -- Filtro barato: solo lo que YA pasó su plazo base. Sin llamadas a
    -- funciones, con las columnas que el JOIN ya trae.
    SELECT s.id, s.exam_id, s.user_id
      FROM public.submissions s
      JOIN public.exams e ON e.id = s.exam_id
     WHERE s.status = 'en_progreso'
       AND e.deleted_at IS NULL
       AND (
         CASE
           WHEN COALESCE(e.schedule_type, 'normal') = 'relativo' THEN
             CASE
               WHEN COALESCE(e.time_limit_minutes, 0) > 0 AND s.started_at IS NOT NULL
                 THEN s.started_at + make_interval(mins => e.time_limit_minutes)
               ELSE NULL
             END
           ELSE e.end_time
         END
       ) < now() - interval '1 minute'
  ),
  candidatos AS (
    SELECT p.id, public.exam_attempt_deadline(p.id) AS plazo
      FROM posibles p
     WHERE NOT public.exam_attempt_paused(p.exam_id, p.user_id)
  ),
  cerrados AS (
    UPDATE public.submissions s
       SET status         = 'completado',
           submitted_at   = COALESCE(s.submitted_at, now()),
           closed_at      = now(),
           closed_by      = NULL,
           close_reason   = 'vencimiento',
           close_deadline = c.plazo,
           updated_at     = now()
      FROM candidatos c
     WHERE s.id = c.id
       AND c.plazo IS NOT NULL
       AND c.plazo < now() - interval '1 minute'
       AND s.status = 'en_progreso'
    RETURNING s.id
  )
  SELECT COALESCE(array_agg(id), '{}'::uuid[]), count(*)
    INTO v_ids, v_n
    FROM cerrados;

  -- Un fallo al encolar NO puede dejar el intento abierto: el cierre ya está
  -- hecho y es lo que protege la integridad del examen. Se aísla por fila.
  FOREACH v_id IN ARRAY v_ids LOOP
    BEGIN
      PERFORM public.enqueue_attempt_grading(v_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'No se pudo encolar la calificacion del intento %: %', v_id, SQLERRM;
    END;
  END LOOP;

  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.close_expired_exam_attempts() FROM PUBLIC;

COMMENT ON FUNCTION public.close_expired_exam_attempts() IS
  'Cada minuto: da por terminados los intentos de examen cuyo plazo efectivo ya vencio (con un minuto de gracia) y encola su calificacion. Respeta pausas, tiempo extra, schedule_type y papelera. Filtra primero por el plazo BASE para no calcular el plazo exacto de cada intento en curso en cada corrida.';
