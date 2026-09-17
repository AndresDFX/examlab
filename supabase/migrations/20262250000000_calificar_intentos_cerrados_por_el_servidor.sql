-- ═══════════════════════════════════════════════════════════════════════
-- Un intento que CIERRA EL SERVIDOR también tiene que calificarse.
--
-- ── El reporte ────────────────────────────────────────────────────────
-- Un examen entregado el 2026-09-01 seguía sin nota dos semanas después: en
-- la revisión del docente cada pregunta mostraba «— / 0.3» y tanto «Nota IA»
-- como «Nota Final» estaban vacías. Cuatro de sus trece preguntas son
-- CERRADAS, o sea que no necesitan modelo alguno para puntuarse — y aun así
-- no valían nada.
--
-- ── La causa ──────────────────────────────────────────────────────────
-- La calificación la dispara el CLIENTE: `performSubmit` del alumno llama a
-- `aiGradeOrEnqueue`. Pero hay dos caminos que cierran un intento SIN que
-- haya un cliente mirando:
--   · `close_expired_exam_attempts()`, el cron de cada minuto que cierra los
--     intentos vencidos (es el de este caso: `close_reason = 'vencimiento'`,
--     `closed_by = NULL`);
--   · `teacher_close_exam_attempt()`, cuando el docente termina a mano un
--     intento que quedó en curso.
-- Los dos viven en SQL, y **SQL no puede invocar una edge function**. Así que
-- marcaban la entrega como `completado` y ahí terminaba todo: nadie la
-- calificaba nunca, ni con IA ni sin ella.
--
-- El agujero es mayor de lo que parece por el lado del alumno: quien se
-- queda sin tiempo pierde TAMBIÉN el puntaje de lo que sí contestó bien en
-- las preguntas cerradas, que es puntaje verificable sin criterio humano ni
-- modelo. Esa mitad de la nota no debería depender de la IA.
--
-- ── El arreglo ────────────────────────────────────────────────────────
-- Los dos cierres encolan un trabajo en `ai_grading_queue`, exactamente el
-- mismo que encola el alumno al entregar. El worker lo drena y la edge
-- `ai-grade-submission` hace lo que ya sabe hacer: puntúa las deterministas
-- (cerrada, opción múltiple, red) SIN llamar al modelo y manda al modelo solo
-- las abiertas. La nota final sale con el valor de TODAS las preguntas.
--
-- ── Por qué un encolador nuevo y no `enqueue_ai_grading` ──────────────
-- Esa función arranca con `IF auth.uid() IS NULL THEN RAISE EXCEPTION`, y en
-- el cron `auth.uid()` es NULL: llamarla desde ahí aborta el cierre entero.
-- Se replica su semántica —incluida la deduplicación por (target, kind)—
-- pero sin exigir sesión, porque acá el actor ES el sistema.
-- ═══════════════════════════════════════════════════════════════════════

DO $guard$
BEGIN
  IF to_regclass('public.submissions') IS NULL
     OR to_regclass('public.ai_grading_queue') IS NULL THEN
    RETURN;
  END IF;

  -- ── Encolador para intentos cerrados por el servidor ────────────────
  --
  -- El mapeo de columnas replica el del cliente (`app.student.take.$examId`):
  -- la edge del examen escribe `submissions` por su cuenta y devuelve
  -- `persistedInternally`, así que estos campos son los que el worker usa
  -- como respaldo, no la vía principal.
  CREATE OR REPLACE FUNCTION public.enqueue_attempt_grading(_submission_id uuid)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, extensions AS $fn$
  DECLARE
    v_course uuid;
    v_ya     uuid;
    v_id     uuid;
    v_grade  numeric;
    v_over   numeric;
  BEGIN
    SELECT e.course_id, s.ai_grade, s.final_override_grade
      INTO v_course, v_grade, v_over
      FROM public.submissions s
      JOIN public.exams e ON e.id = s.exam_id
     WHERE s.id = _submission_id
       -- Papelera: lo que está borrado no se opera desde ningún flujo.
       AND e.deleted_at IS NULL;

    IF NOT FOUND THEN
      RETURN NULL;
    END IF;

    -- Ya tiene nota (la puso la IA o la puso el docente): no se vuelve a
    -- calificar sola. Recalificar es una decisión del docente, con su botón.
    IF v_grade IS NOT NULL OR v_over IS NOT NULL THEN
      RETURN NULL;
    END IF;

    -- Dedup, igual que `enqueue_ai_grading`: si ya hay un trabajo activo para
    -- esta entrega se reusa. El índice único parcial
    -- `idx_ai_grading_queue_active_dedup` es el respaldo atómico ante carreras
    -- (el cron y el docente pueden cerrar el mismo intento en el mismo
    -- segundo), por eso además hay handler de `unique_violation`.
    SELECT id INTO v_ya
      FROM public.ai_grading_queue
     WHERE target_table = 'submissions'
       AND target_row_id = _submission_id
       AND kind = 'exam_submission'
       AND status IN ('pending', 'processing')
     ORDER BY created_at ASC
     LIMIT 1;
    IF v_ya IS NOT NULL THEN
      RETURN v_ya;
    END IF;

    BEGIN
      INSERT INTO public.ai_grading_queue (
        kind, invoke_target, body,
        target_table, target_row_id,
        field_grade, field_feedback, field_likelihood,
        course_id, created_by, status
      ) VALUES (
        -- MISMO kind que usa el submit del alumno y el recalificado del
        -- monitor. Con un kind distinto la dedup no los vería como el mismo
        -- trabajo y la entrega se calificaría dos veces (doble gasto de IA).
        'exam_submission', 'ai-grade-submission',
        jsonb_build_object('submissionId', _submission_id),
        'submissions', _submission_id,
        'ai_grade', 'ai_detected_reasons', 'ai_detected_score',
        v_course,
        -- El actor es el sistema: no hay usuario a quien atribuirlo.
        NULL, 'pending'
      ) RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      SELECT id INTO v_id
        FROM public.ai_grading_queue
       WHERE target_table = 'submissions'
         AND target_row_id = _submission_id
         AND kind = 'exam_submission'
         AND status IN ('pending', 'processing')
       ORDER BY created_at ASC
       LIMIT 1;
    END;

    RETURN v_id;
  END;
  $fn$;

  REVOKE ALL ON FUNCTION public.enqueue_attempt_grading(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.enqueue_attempt_grading(uuid) FROM anon;

  COMMENT ON FUNCTION public.enqueue_attempt_grading(uuid) IS
    'Encola la calificacion de un intento de examen cerrado por el servidor (cron de vencimiento o cierre manual del docente). Idempotente y sin exigir sesion: el actor es el sistema.';
END
$guard$;

-- ── El cierre automático encola ────────────────────────────────────────
-- El encolado va DESPUÉS del UPDATE y sobre las filas que el UPDATE tocó de
-- verdad (`RETURNING`), no sobre los candidatos: así un intento que otro
-- proceso cerró primero no genera un trabajo repetido.
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

  WITH candidatos AS (
    SELECT s.id, public.exam_attempt_deadline(s.id) AS plazo
      FROM public.submissions s
      JOIN public.exams e ON e.id = s.exam_id
     WHERE s.status = 'en_progreso'
       AND e.deleted_at IS NULL
       AND NOT public.exam_attempt_paused(s.exam_id, s.user_id)
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
  'Cada minuto: da por terminados los intentos de examen cuyo plazo efectivo ya vencio (con un minuto de gracia) y encola su calificacion. Respeta pausas, tiempo extra, schedule_type y papelera.';

-- ── El cierre manual del docente también encola ────────────────────────
CREATE OR REPLACE FUNCTION public.teacher_close_exam_attempt(_submission_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_sub   record;
  v_ok    boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;

  SELECT s.id, s.exam_id, s.user_id, s.status, s.submitted_at, s.closed_at
    INTO v_sub
    FROM public.submissions s
   WHERE s.id = _submission_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.exams e
     WHERE e.id = v_sub.exam_id
       -- Papelera: lo que está borrado no se opera desde ningún flujo.
       AND e.deleted_at IS NULL
       AND (
         EXISTS (SELECT 1 FROM public.course_teachers ct
                  WHERE ct.course_id = e.course_id AND ct.user_id = v_uid)
         OR public.is_admin_of_course_tenant(e.course_id)
       )
  ) INTO v_ok;

  IF NOT v_ok THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  -- Idempotente: terminar algo ya terminado no es un error, es un no-op. Dos
  -- docentes pulsando a la vez, o el cron corriendo en el mismo segundo, tienen
  -- que converger sin ruido.
  IF v_sub.status <> 'en_progreso' THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'status', v_sub.status);
  END IF;

  UPDATE public.submissions
     SET status         = 'completado',
         submitted_at   = COALESCE(submitted_at, now()),
         closed_at      = now(),
         closed_by      = v_uid,
         close_reason   = 'manual',
         close_deadline = public.exam_attempt_deadline(_submission_id),
         updated_at     = now()
   WHERE id = _submission_id
     AND status = 'en_progreso';

  -- Terminar un intento existe PARA poder calificarlo: encolar acá es lo que
  -- evita que el docente tenga que acordarse de pulsar «Recalificar» después.
  BEGIN
    PERFORM public.enqueue_attempt_grading(_submission_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'No se pudo encolar la calificacion del intento %: %', _submission_id, SQLERRM;
  END;

  RETURN jsonb_build_object('ok', true, 'changed', true, 'status', 'completado');
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_close_exam_attempt(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_close_exam_attempt(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_close_exam_attempt(uuid) TO authenticated;

COMMENT ON FUNCTION public.teacher_close_exam_attempt(uuid) IS
  'Da por terminado un intento en curso y encola su calificacion. Docente del curso / Admin de la institucion / SuperAdmin. Idempotente.';

-- ── Rescate de lo ya cerrado y sin calificar ───────────────────────────
-- Los intentos que el servidor cerró ANTES de esta migración no tienen quien
-- los califique: nadie va a volver a cerrarlos. Se encolan una vez.
DO $rescate$
DECLARE
  v_id uuid;
  v_n  integer := 0;
BEGIN
  IF to_regclass('public.submissions') IS NULL
     OR to_regclass('public.ai_grading_queue') IS NULL THEN
    RETURN;
  END IF;

  FOR v_id IN
    SELECT s.id
      FROM public.submissions s
      JOIN public.exams e ON e.id = s.exam_id
     WHERE s.close_reason IS NOT NULL
       AND s.ai_grade IS NULL
       AND s.final_override_grade IS NULL
       AND e.deleted_at IS NULL
  LOOP
    BEGIN
      IF public.enqueue_attempt_grading(v_id) IS NOT NULL THEN
        v_n := v_n + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'No se pudo encolar el rescate del intento %: %', v_id, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE 'Intentos cerrados sin calificar encolados: %', v_n;
END
$rescate$;
