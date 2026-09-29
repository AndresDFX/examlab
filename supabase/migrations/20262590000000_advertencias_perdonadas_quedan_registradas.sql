-- Borrar una advertencia ya no destruye la evidencia.
--
-- ── El caso que lo destapó ───────────────────────────────────────────────
--
-- Parcial de UNIAJ, 2026-09-28: 17 borrados de advertencias en 50 minutos. Al
-- revisar después el expediente de un estudiante, el registro decía «0
-- advertencias» y un solo evento. Lo que había pasado de verdad —dos
-- advertencias, borradas a las 23:51:06 y a las 23:54:34— solo sobrevivía en
-- `audit_logs`, y ahí únicamente como número (`previous_warnings: 1`). Ni el
-- tipo, ni la hora, ni en qué pregunta.
--
-- `teacher_clear_exam_warnings` reescribe `__warning_events` con lo que queda y
-- no guarda copia. Perdonar es una decisión legítima y frecuente del docente;
-- lo que no puede ser es que borre el rastro de lo que se perdonó.
--
-- ── Por qué una COLUMNA y no una clave dentro de `answers` ───────────────
--
-- `answers` lo reescribe el autoguardado del alumno cada 1,5 s desde su copia
-- LOCAL, que no conoce ninguna clave nueva: guardarlo ahí lo borraría al
-- instante, y justo en el caso que importa (un examen EN CURSO, que es cuando
-- se perdona). Una columna propia no la toca ese UPDATE.
--
-- ── Y el recuento pasa a mirar el EVENTO, no su tipo ────────────────────
--
-- Desde que pegar puede sumar o no según la pregunta (mig 20262600000000), el
-- tipo dejó de alcanzar para saber si un evento sumó. Ahora manda lo que quedó
-- escrito en el evento (`suma`), con el tipo como respaldo para los eventos
-- históricos que no lo traen. Es el espejo de `eventoSumoStrike`
-- (src/modules/exams/proctoring.ts); si divergen, perdonar descuenta mal.

-- 1) ─────────────── Dónde queda lo perdonado
DO $mig$
BEGIN
  IF to_regclass('public.submissions') IS NOT NULL THEN
    ALTER TABLE public.submissions
      ADD COLUMN IF NOT EXISTS cleared_warning_events jsonb NOT NULL DEFAULT '[]'::jsonb;

    COMMENT ON COLUMN public.submissions.cleared_warning_events IS
      'Advertencias que el docente perdono, con quien y cuando. Solo la escribe teacher_clear_exam_warnings; el autoguardado del alumno no la toca. Sin esto, borrar una advertencia destruia el rastro de lo borrado.';
  END IF;
END $mig$;

-- 2) ─────────────── Espejo en SQL de `eventoSumoStrike`
CREATE OR REPLACE FUNCTION public._exam_warning_event_is_strike(_ev jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT COALESCE(
    (_ev ->> 'suma')::boolean,
    public._exam_warning_is_strike(_ev ->> 'type')
  );
$fn$;

COMMENT ON FUNCTION public._exam_warning_event_is_strike(jsonb) IS
  'Si ESTE evento sumo un strike. Espejo de eventoSumoStrike en src/modules/exams/proctoring.ts: manda la marca suma que dejo quien lo registro, y cae al tipo para los eventos viejos que no la traen.';

-- 3) ─────────────── El perdón conserva lo que borra
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
  v_borrados jsonb;
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
  SELECT s.id, s.exam_id, s.user_id, s.status, s.focus_warnings, s.answers,
         s.close_reason, s.cleared_warning_events
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
    v_nuevos   := '[]'::jsonb;
    v_borrados := v_eventos;
  ELSIF _index < 0 OR _index >= jsonb_array_length(v_eventos) THEN
    -- Índice fuera de rango: el docente tenía la lista vieja en pantalla. No
    -- es un error del sistema, pero tampoco se borra "el que quedó ahí".
    RETURN jsonb_build_object('ok', false, 'error', 'stale_index');
  ELSE
    SELECT COALESCE(jsonb_agg(ev ORDER BY i) FILTER (WHERE i - 1 <> _index), '[]'::jsonb),
           COALESCE(jsonb_agg(ev ORDER BY i) FILTER (WHERE i - 1 =  _index), '[]'::jsonb)
      INTO v_nuevos, v_borrados
      FROM jsonb_array_elements(v_eventos) WITH ORDINALITY AS t(ev, i);
  END IF;

  -- El contador se RECALCULA contando strikes en lo que queda, en vez de
  -- restarle uno al valor viejo: así el número no puede quedar desfasado del
  -- array aunque venga torcido de antes.
  SELECT count(*) INTO v_strikes
    FROM jsonb_array_elements(v_nuevos) AS t(ev)
   WHERE public._exam_warning_event_is_strike(ev);

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
         -- Lo perdonado se ACUMULA: un segundo perdón no puede tapar al
         -- primero, que es justo lo que pasó en el caso que originó esto (dos
         -- borrados seguidos sobre el mismo intento).
         cleared_warning_events = COALESCE(cleared_warning_events, '[]'::jsonb) || (
           SELECT COALESCE(jsonb_agg(
                    ev || jsonb_build_object('perdonada_at', now(), 'perdonada_por', v_uid)
                  ), '[]'::jsonb)
             FROM jsonb_array_elements(v_borrados) AS t(ev)
         ),
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
    'events', v_nuevos,
    'cleared', v_borrados
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.teacher_clear_exam_warnings(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_clear_exam_warnings(uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_clear_exam_warnings(uuid, integer) TO authenticated;


-- 4) ─────────────── Que el alumno no pueda borrar lo perdonado
--
-- La columna nueva es un REGISTRO, y uno que puede jugar en contra de quien lo
-- generó: si el alumno la pudiera escribir, vaciarla borraría exactamente la
-- evidencia que esta migración existe para conservar. Va con la nota y los
-- metadatos de revisión, que es la familia que no se toca nunca.
--
-- Se reproduce la función entera porque la 20262580000000 ya está aplicada; es
-- el mismo criterio con el que esa reprodujo la de la 20262410000000.
DO $mig$ BEGIN
  IF to_regclass('public.submissions') IS NULL THEN
    RAISE NOTICE 'submissions no existe en este entorno: se omite';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.tg_guard_exam_submission_grade()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $fn$
  DECLARE
    v_uid uuid := auth.uid();
    v_toca_notas boolean;
    v_toca_cierre boolean;
    v_cierre_propio boolean;
    v_is_staff boolean;
  BEGIN
    IF v_uid IS NULL THEN RETURN NEW; END IF;  -- service_role / sistema

    v_toca_notas :=
         NEW.final_override_grade IS DISTINCT FROM OLD.final_override_grade
      OR NEW.ai_grade             IS DISTINCT FROM OLD.ai_grade
      OR NEW.ai_detected          IS DISTINCT FROM OLD.ai_detected
      OR NEW.ai_detected_score    IS DISTINCT FROM OLD.ai_detected_score
      OR NEW.ai_detected_reasons  IS DISTINCT FROM OLD.ai_detected_reasons
      OR NEW.ai_review_at         IS DISTINCT FROM OLD.ai_review_at
      OR NEW.ai_review_by         IS DISTINCT FROM OLD.ai_review_by
      OR NEW.teacher_feedback     IS DISTINCT FROM OLD.teacher_feedback
      OR NEW.extra_seconds        IS DISTINCT FROM OLD.extra_seconds
      -- El registro de lo perdonado: solo lo escribe la RPC del docente.
      OR NEW.cleared_warning_events IS DISTINCT FROM OLD.cleared_warning_events
      OR NEW.status = 'calificado'
      OR (OLD.status = 'calificado' AND NEW.status IS DISTINCT FROM OLD.status);

    v_toca_cierre :=
         NEW.closed_at      IS DISTINCT FROM OLD.closed_at
      OR NEW.closed_by      IS DISTINCT FROM OLD.closed_by
      OR NEW.close_reason   IS DISTINCT FROM OLD.close_reason
      OR NEW.close_deadline IS DISTINCT FROM OLD.close_deadline;

    v_cierre_propio :=
          OLD.closed_at    IS NULL
      AND OLD.closed_by    IS NULL
      AND OLD.close_reason IS NULL
      AND NEW.closed_at    IS NOT NULL
      AND NEW.closed_by     = v_uid
      AND NEW.user_id       = v_uid
      AND NEW.status       <> 'en_progreso'
      AND NEW.close_deadline IS NOT DISTINCT FROM OLD.close_deadline;

    IF NOT v_toca_notas AND (NOT v_toca_cierre OR v_cierre_propio) THEN
      RETURN NEW;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM public.exams e
      JOIN public.course_teachers ct ON ct.course_id = e.course_id
      WHERE e.id = NEW.exam_id AND ct.user_id = v_uid
    ) OR EXISTS (
      SELECT 1 FROM public.exams e
      WHERE e.id = NEW.exam_id AND public.is_admin_of_course_tenant(e.course_id)
    ) INTO v_is_staff;

    IF v_is_staff THEN RETURN NEW; END IF;

    RAISE EXCEPTION 'No autorizado: solo el docente del curso o un administrador pueden modificar la calificación o los metadatos de revisión de una entrega';
  END
  $fn$;

  REVOKE ALL ON FUNCTION public.tg_guard_exam_submission_grade() FROM PUBLIC;

  DROP TRIGGER IF EXISTS trg_guard_exam_submission_grade ON public.submissions;
  CREATE TRIGGER trg_guard_exam_submission_grade
    BEFORE UPDATE ON public.submissions
    FOR EACH ROW EXECUTE FUNCTION public.tg_guard_exam_submission_grade();
END $mig$;
