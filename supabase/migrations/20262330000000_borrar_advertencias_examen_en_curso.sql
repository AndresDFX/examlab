-- ═══════════════════════════════════════════════════════════════════════
-- Borrar advertencias de un intento que TODAVÍA está en curso
-- ═══════════════════════════════════════════════════════════════════════
-- El panel de advertencias del monitor solo se abría para intentos
-- finalizados, así que el docente veía el contador subir por un falso
-- positivo —una notificación del sistema sacó al alumno de pantalla
-- completa— y no tenía cómo perdonarlo. Es justo cuando más urge: al tercer
-- strike el intento se suspende solo.
--
-- ── Por qué esto NO se podía resolver en el cliente ────────────────────
-- Hacerlo desde el monitor con un UPDATE normal falla de dos formas, las dos
-- silenciosas:
--
--   1. Le PISA LAS RESPUESTAS al alumno. El monitor escribe la columna
--      `answers` ENTERA a partir de la copia que cargó (su sondeo es de 60 s)
--      y el alumno autoguarda cada 1,5 s. Perdonar un strike le borraría
--      hasta un minuto de examen.
--   2. NO QUEDA. El autoguardado del alumno reescribe `answers` —incluido
--      `__warning_events`— y `focus_warnings` desde sus propias variables
--      locales. El borrado del docente se revierte en 1,5 s, y el contador
--      con el que el alumno decide suspenderse ni se entera, así que la
--      suspensión igual se dispara.
--
-- Por eso el borrado vive acá: la escritura es ATÓMICA y quirúrgica (toca
-- SOLO la clave `__warning_events` sobre el valor ACTUAL de la fila, nunca
-- sobre una copia vieja), y además se avisa al alumno por el canal que ya
-- existe para las órdenes del docente (`exam_timer_controls`, que el examen
-- sondea cada 4 s y ADEMÁS está publicada en realtime — al revés que
-- `submissions`, que no lo está).
--
-- El aviso lleva el estado nuevo en su propio payload en vez de pedirle al
-- alumno que relea su fila: entre el borrado y la relectura cabe un
-- autoguardado que restauraría lo viejo, y el alumno releería justo eso. Con
-- el payload el alumno adopta el valor correcto y su siguiente autoguardado
-- lo reescribe igual — converge solo.

-- Payload del aviso. Nullable: las órdenes que ya existían no lo usan.
DO $$
BEGIN
  IF to_regclass('public.exam_timer_controls') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'exam_timer_controls'
          AND column_name = 'payload'
     )
  THEN
    ALTER TABLE public.exam_timer_controls ADD COLUMN payload jsonb;
  END IF;
END $$;

-- `action` no tiene CHECK, así que 'clear_warnings' entra sin tocar nada.

-- Tipos que SUMAN strike. Espeja TIPOS_QUE_SUMAN_STRIKE de
-- src/modules/exams/proctoring.ts — el array de eventos mezcla los strikes
-- reales con señales blandas (copiar, pegar, captura) que se registran para
-- que el docente las VEA pero no cuentan. Un test compara las dos listas: si
-- divergen, perdonar un "intento de copiar" regalaría un strike inexistente.
CREATE OR REPLACE FUNCTION public._exam_warning_is_strike(_type text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT _type IN ('pestaña', 'fullscreen_exit', 'visibility_hidden');
$fn$;

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

  SELECT s.id, s.exam_id, s.user_id, s.status, s.focus_warnings, s.answers
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
  IF v_sub.status = 'sospechoso'
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
