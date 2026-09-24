-- ═══════════════════════════════════════════════════════════════════════
-- Suspender por advertencias vuelve a CERRAR el intento de verdad.
--
-- Contexto: hasta la mig 20262460000000, superar el tope de advertencias
-- marcaba la entrega como `sospechoso`, y ESE estado era el que impedía
-- reanudarla. Al reservar `sospechoso` para el fraude detectado (que es lo
-- correcto: las advertencias en un teléfono las produce el teclado o una
-- notificación), la suspensión pasó a guardarse como `completado` — y ahí se
-- abrió un agujero que hay que cerrar en el mismo movimiento:
--
--   · Una entrega `completado` SIN nota es **reanudable** a propósito («entregué
--     limpio y todavía no hay feedback»). O sea que el propio estudiante
--     deshacía su suspensión con solo volver a entrar, y el listado hasta le
--     ofrecía «Reintentar examen».
--   · Y `teacher_clear_exam_warnings` —la herramienta del docente para perdonar
--     advertencias y reabrir— preguntaba por `status = 'sospechoso'`, así que
--     quedó inerte justo para el caso que existe para atender.
--
-- Lo que distingue una suspensión de una entrega limpia ya no puede ser el
-- estado: es el CIERRE. `closed_at` + `close_reason` ya existían (mig
-- 20261960000000) para «el docente lo dio por terminado» y «se venció el
-- plazo»; se agrega el tercer motivo real, `advertencias`, y con él vuelven a
-- funcionar las dos defensas que ya estaban escritas: el trigger
-- `tg_block_reopen_closed_attempt` en la base y el filtro de reanudables en la
-- pantalla.
-- ═══════════════════════════════════════════════════════════════════════

-- 1) ─────────────── El motivo nuevo
DO $$
BEGIN
  IF to_regclass('public.submissions') IS NOT NULL THEN
    ALTER TABLE public.submissions
      DROP CONSTRAINT IF EXISTS submissions_close_reason_check;
    ALTER TABLE public.submissions
      ADD CONSTRAINT submissions_close_reason_check
      CHECK (close_reason IS NULL OR close_reason IN ('manual', 'vencimiento', 'advertencias'));
  END IF;
END $$;

-- 2) ─────────────── Backfill: marcar las suspensiones que quedaron sueltas
-- La mig 20262460000000 devolvió a `completado` las entregas marcadas solo por
-- advertencias, pero sin `closed_at` quedaron REANUDABLES por el estudiante.
-- Se les pone el cierre que les corresponde, tomando el tope de SU examen (no
-- un 3 fijo: el docente lo configura por examen).
DO $$
DECLARE
  _n INTEGER := 0;
BEGIN
  IF to_regclass('public.submissions') IS NOT NULL
     AND to_regclass('public.exams') IS NOT NULL THEN
    UPDATE public.submissions s
       SET closed_at    = COALESCE(s.submitted_at, now()),
           close_reason = 'advertencias'
      FROM public.exams e
     WHERE e.id = s.exam_id
       AND s.status = 'completado'
       AND s.closed_at IS NULL
       AND s.submitted_at IS NOT NULL
       AND COALESCE(s.focus_warnings, 0) >= COALESCE(e.max_warnings, 3);

    GET DIAGNOSTICS _n = ROW_COUNT;
    RAISE NOTICE 'Suspensiones por advertencias marcadas como cerradas: %', _n;
  END IF;
END $$;

-- 3) ─────────────── Perdonar advertencias vuelve a reabrir
CREATE OR REPLACE FUNCTION public.teacher_clear_exam_warnings(
  _submission_id uuid,
  _index integer DEFAULT NULL   -- NULL = borrarlas todas
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_sub     record;
  v_exam    record;
  v_ok      boolean;
  v_eventos jsonb;
  v_nuevos  jsonb;
  v_strikes integer;
  v_status  text;
  v_limpiar boolean := false;
  v_abierto boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;

  -- `close_reason` es lo que hoy distingue una SUSPENSIÓN por advertencias de
  -- una entrega limpia: desde la mig 20262460000000 las dos son `completado`.
  SELECT s.id, s.exam_id, s.user_id, s.status, s.focus_warnings, s.answers, s.close_reason
    INTO v_sub
    FROM public.submissions s
   WHERE s.id = _submission_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  SELECT e.id, e.course_id, e.start_time, e.end_time, e.max_warnings
    INTO v_exam
    FROM public.exams e
   WHERE e.id = v_sub.exam_id AND e.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  -- Misma autorización que `teacher_close_exam_attempt`: siendo SECURITY
  -- DEFINER la RLS no se aplica sola, así que se replica el predicado.
  SELECT (
    EXISTS (SELECT 1 FROM public.course_teachers ct
             WHERE ct.course_id = v_exam.course_id AND ct.user_id = v_uid)
    OR public.is_admin_of_course_tenant(v_exam.course_id)
  ) INTO v_ok;
  IF NOT v_ok THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  v_eventos := COALESCE(v_sub.answers -> '__warning_events', '[]'::jsonb);
  IF jsonb_typeof(v_eventos) <> 'array' THEN
    v_eventos := '[]'::jsonb;
  END IF;

  IF _index IS NULL THEN
    v_nuevos := '[]'::jsonb;
  ELSIF _index < 0 OR _index >= jsonb_array_length(v_eventos) THEN
    -- Índice fuera de rango: el docente tenía la lista vieja en pantalla. No
    -- es un error del sistema, pero tampoco se borra "el que quedó ahí".
    RETURN jsonb_build_object('ok', false, 'error', 'stale_index');
  ELSE
    SELECT COALESCE(jsonb_agg(ev ORDER BY i), '[]'::jsonb)
      INTO v_nuevos
      FROM jsonb_array_elements(v_eventos) WITH ORDINALITY AS t(ev, i)
     WHERE i - 1 <> _index;
  END IF;

  -- El contador se RECALCULA contando strikes en lo que queda, en vez de
  -- restarle uno al valor viejo: así el número no puede quedar desfasado del
  -- array aunque venga torcido de antes.
  SELECT count(*) INTO v_strikes
    FROM jsonb_array_elements(v_nuevos) AS t(ev)
   WHERE public._exam_warning_is_strike(ev ->> 'type');

  v_status  := v_sub.status;
  v_abierto := now() >= v_exam.start_time AND now() <= v_exam.end_time;

  -- Un intento EN CURSO no cambia de estado por esto: perdonar un strike no
  -- puede terminarle el examen al alumno.
  IF (v_sub.status = 'sospechoso' OR v_sub.close_reason = 'advertencias')
     AND v_strikes < COALESCE(v_exam.max_warnings, 3) THEN
    IF v_abierto THEN
      v_status  := 'en_progreso';
      v_limpiar := true;   -- que pueda reingresar
    ELSE
      v_status  := 'completado';
    END IF;
  END IF;

  -- La escritura: `answers` se toma del valor ACTUAL de la fila (no de una
  -- copia del cliente), así que lo que el alumno haya guardado mientras tanto
  -- se conserva. Solo cambia la clave `__warning_events`.
  UPDATE public.submissions
     SET answers = jsonb_set(
           COALESCE(answers, '{}'::jsonb), '{__warning_events}', v_nuevos, true),
         focus_warnings = v_strikes,
         status = v_status,
         submitted_at = CASE WHEN v_limpiar THEN NULL ELSE submitted_at END,
         -- Reabrir por esta vía limpia las marcas de cierre, o el trigger
         -- anti-reanudación dejaría al alumno con un intento "en curso" que
         -- no puede retomar.
         closed_at    = CASE WHEN v_limpiar THEN NULL ELSE closed_at END,
         closed_by    = CASE WHEN v_limpiar THEN NULL ELSE closed_by END,
         close_reason = CASE WHEN v_limpiar THEN NULL ELSE close_reason END
   WHERE id = _submission_id;

  -- Aviso al alumno SOLO si sigue rindiendo: para un intento ya terminado no
  -- hay nadie escuchando y sería una fila de ruido en cada corrección.
  IF v_status = 'en_progreso' THEN
    INSERT INTO public.exam_timer_controls
      (exam_id, target_user_id, action, extra_seconds, created_by, payload)
    VALUES (
      v_sub.exam_id, v_sub.user_id, 'clear_warnings', 0, v_uid,
      jsonb_build_object('focus_warnings', v_strikes, 'warning_events', v_nuevos)
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'focus_warnings', v_strikes,
    'status', v_status,
    'restored', v_limpiar,
    'events', v_nuevos
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.teacher_clear_exam_warnings(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_clear_exam_warnings(uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_clear_exam_warnings(uuid, integer) TO authenticated;
