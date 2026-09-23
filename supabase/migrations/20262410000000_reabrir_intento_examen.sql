-- ═══════════════════════════════════════════════════════════════════════
-- Reabrir un intento de examen desde el monitor
-- ═══════════════════════════════════════════════════════════════════════
-- Es el inverso de `teacher_close_exam_attempt` (mig 20261960000000) y faltaba:
-- se podía dar por terminado un intento, pero no deshacerlo. El caso que lo pide
-- es concreto — al estudiante se le cortó el examen, el docente amplía el plazo y
-- quiere que retome donde iba.
--
-- ── El guard que hace que esto FUNCIONE, y no solo que corra ──────────
-- `close_expired_exam_attempts()` corre CADA MINUTO y cierra todo intento en
-- curso que haya pasado su plazo. O sea que reabrir sin mirar el plazo es
-- inútil: el intento vuelve a `completado` en menos de un minuto, el docente ve
-- que «no funciona» y no tiene forma de saber por qué.
--
-- Por eso la RPC calcula el plazo que el intento tendría DESPUÉS de conceder los
-- minutos pedidos y, si sigue vencido, **no reabre**: devuelve `plazo_vencido`
-- junto con cuántos minutos faltan. Un mensaje que dice qué hacer vale más que
-- una reapertura que se deshace sola.
--
-- ── Cómo se concede el tiempo, y por qué en los DOS lugares ───────────
-- `exam_attempt_deadline` toma `GREATEST(submissions.extra_seconds, SUM(de los
-- controles 'add_time'))`. Se escribe:
--   · `submissions.extra_seconds` = el extra vigente + lo concedido, que es lo
--     que manda en el plazo y lo que lee el cron;
--   · una fila en `exam_timer_controls`, que es la tabla que SÍ está publicada
--     en realtime y por donde la pantalla del alumno se entera del tiempo nuevo
--     sin recargar.
-- Escribir solo una de las dos deja el plazo y lo que el alumno ve en desacuerdo.
--
-- ── Lo que NO hace: borrar la nota ────────────────────────────────────
-- Si el intento ya tenía nota, se conserva. Es exactamente lo que ya hace el
-- camino de reanudación del propio estudiante (`app.student.take.$examId.tsx`
-- hace `update({status:'en_progreso', submitted_at:null})` y no toca nada más),
-- y borrarla acá haría que reabrir «para que termine dos preguntas» le costara
-- al estudiante la calificación que ya tenía. La pantalla avisa cuando hay nota.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.teacher_reopen_exam_attempt(
  _submission_id uuid,
  _minutos integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_sub       record;
  v_ok        boolean;
  v_extra_act integer;
  v_conceder  integer;
  v_plazo     timestamptz;
  v_faltan    integer;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;

  -- Un número negativo QUITARÍA tiempo, que no es lo que este botón hace y
  -- sería una forma silenciosa de acortarle el examen a alguien.
  v_conceder := GREATEST(0, COALESCE(_minutos, 0)) * 60;

  SELECT s.id, s.exam_id, s.user_id, s.status, s.extra_seconds
    INTO v_sub
    FROM public.submissions s
   WHERE s.id = _submission_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  -- Misma autorización que cerrar: docente del curso, Admin de la institución o
  -- SuperAdmin (`is_admin_of_course_tenant` ya lo cubre). Siendo SECURITY
  -- DEFINER, la RLS no se aplica sola y esto es la única frontera.
  SELECT EXISTS (
    SELECT 1
      FROM public.exams e
     WHERE e.id = v_sub.exam_id
       AND e.deleted_at IS NULL
       -- Un examen EXTERNO no se retoma: no tiene pantalla donde retomarlo. Su
       -- entrega la crea `ExternalGradesEditor` ya en `completado` para colgarle
       -- una nota cargada a mano, y su `end_time` se fija igual al inicio, así
       -- que su plazo SIEMPRE figura vencido. Sin este filtro, «reabrir»
       -- aparecería en todas las filas de un examen externo y, si alguien lo
       -- pulsa, deja la entrega en `en_progreso` con `submitted_at` en NULL: la
       -- nota cargada desaparece del gradebook hasta que alguien lo note.
       AND COALESCE(e.is_external, false) = false
       AND (
         EXISTS (SELECT 1 FROM public.course_teachers ct
                  WHERE ct.course_id = e.course_id AND ct.user_id = v_uid)
         OR public.is_admin_of_course_tenant(e.course_id)
       )
  ) INTO v_ok;

  IF NOT v_ok THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  -- Idempotente, igual que cerrar: reabrir algo que ya está en curso es un
  -- no-op, no un error. Dos docentes pulsando a la vez convergen sin ruido.
  IF v_sub.status = 'en_progreso' THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'status', 'en_progreso');
  END IF;

  -- El extra vigente, con la misma regla que usa el plazo.
  SELECT GREATEST(
           COALESCE(v_sub.extra_seconds, 0),
           COALESCE((
             SELECT SUM(COALESCE(c.extra_seconds, 0))
               FROM public.exam_timer_controls c
              WHERE c.exam_id = v_sub.exam_id
                AND c.action = 'add_time'
                AND (c.target_user_id IS NULL OR c.target_user_id = v_sub.user_id)
           ), 0)
         )
    INTO v_extra_act;

  -- El plazo que QUEDARÍA, calculado sin escribir nada todavía.
  --
  -- Se puede sumar directo porque el extra solo CRECE: dejando
  -- `extra_seconds = GREATEST(actual, controles) + concedido`, ese valor pasa a
  -- ser el mayor de los dos y el plazo nuevo es exactamente el de ahora más lo
  -- concedido.
  --
  -- Calcular antes de escribir no es cosmético: si se concediera primero y el
  -- plazo igual no alcanzara, una llamada que devuelve error habría dejado
  -- tiempo regalado, y reintentar con más minutos lo iría acumulando.
  v_plazo := public.exam_attempt_deadline(_submission_id);
  IF v_plazo IS NOT NULL THEN
    v_plazo := v_plazo + make_interval(secs => v_conceder);
  END IF;

  -- Un examen sin plazo (sin `end_time` y sin duración) no lo cierra el cron, así
  -- que reabrirlo es seguro. El guard es solo para los que SÍ tienen plazo.
  IF v_plazo IS NOT NULL AND v_plazo <= now() THEN
    v_faltan := CEIL(EXTRACT(EPOCH FROM (now() - v_plazo)) / 60.0) + 1;
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'plazo_vencido',
      'deadline', v_plazo,
      'minutos_faltantes', v_faltan
    );
  END IF;

  -- Recién acá se escribe, con la reapertura ya asegurada.
  IF v_conceder > 0 THEN
    UPDATE public.submissions
       SET extra_seconds = COALESCE(v_extra_act, 0) + v_conceder,
           updated_at    = now()
     WHERE id = _submission_id;

    -- `exam_timer_controls` es la tabla publicada en realtime: es por donde la
    -- pantalla del alumno se entera del tiempo nuevo sin recargar.
    INSERT INTO public.exam_timer_controls (exam_id, action, extra_seconds, target_user_id, created_by)
    VALUES (v_sub.exam_id, 'add_time', v_conceder, v_sub.user_id, v_uid);
  END IF;

  -- Cerrar un intento ENCOLA su calificación por IA (mig 20262250000000) y el
  -- worker corre cada hora. Si todavía no drenó ese trabajo, el alumno retoma y
  -- sigue escribiendo sobre la MISMA fila mientras un job pendiente califica
  -- respuestas a medio terminar: el docente ve una nota que nadie pidió y que no
  -- corresponde a lo que el alumno va a entregar. Se cancela lo pendiente.
  IF to_regclass('public.ai_grading_queue') IS NOT NULL THEN
    UPDATE public.ai_grading_queue
       SET status = 'cancelled'
     WHERE target_table = 'submissions'
       AND target_row_id = _submission_id
       AND status = 'pending';
  END IF;

  -- Se limpian las marcas de cierre EN EL MISMO UPDATE que el estado: es lo que
  -- `tg_block_reopen_closed_attempt` exige para distinguir al staff —que puede
  -- reabrir— del estudiante, que no.
  UPDATE public.submissions
     SET status         = 'en_progreso',
         submitted_at   = NULL,
         closed_at      = NULL,
         closed_by      = NULL,
         close_reason   = NULL,
         close_deadline = NULL,
         updated_at     = now()
   WHERE id = _submission_id;

  RETURN jsonb_build_object(
    'ok', true,
    'changed', true,
    'status', 'en_progreso',
    'deadline', v_plazo,
    'minutos_concedidos', v_conceder / 60
  );
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_reopen_exam_attempt(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_reopen_exam_attempt(uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_reopen_exam_attempt(uuid, integer) TO authenticated;

COMMENT ON FUNCTION public.teacher_reopen_exam_attempt(uuid, integer) IS
  'Devuelve un intento terminado a en_progreso para que el estudiante lo retome, concediendo los minutos indicados. Docente del curso / Admin de la institucion / SuperAdmin. Se niega si tras conceder el tiempo el plazo sigue vencido, porque el cron volveria a cerrarlo en menos de un minuto. Idempotente. NO borra la nota.';


-- ── El candado sin el cual nada de esto es cierto ─────────────────────
-- `tg_block_reopen_closed_attempt` (mig 20261960000000) dice impedir que el
-- alumno reanude lo que se cerró, pero solo salta cuando `NEW.closed_at` sigue
-- puesto. Y el alumno PUEDE limpiarlo: la policy `submissions_update` lo deja
-- escribir su propia fila entera —no tiene `WITH CHECK` propio, así que hereda
-- el `USING`— y `tg_guard_exam_submission_grade` (mig 20261034000000), que es
-- el candado por COLUMNA, nunca listó las de cierre porque nacieron después.
--
-- O sea que hoy, con su propio JWT:
--
--   PATCH /rest/v1/submissions?id=eq.<la suya>
--   { "status":"en_progreso", "submitted_at":null, "closed_at":null,
--     "closed_by":null, "close_reason":null, "close_deadline":null }
--
-- reabre su examen terminado, todas las veces que quiera, sin docente. Es la
-- misma clase de agujero que este repo ya cerró dos veces (las notas, el perfil)
-- y sin cerrarlo la RPC de arriba es una comodidad, no un control.
--
-- Se suman las cuatro columnas a la lista protegida. El resto de la función
-- queda igual; se reproduce entera porque la 20261034000000 ya está aplicada.
CREATE OR REPLACE FUNCTION public.tg_guard_exam_submission_grade()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_touch boolean;
  v_is_staff boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;  -- service_role / sistema

  v_touch :=
       NEW.final_override_grade IS DISTINCT FROM OLD.final_override_grade
    OR NEW.ai_grade             IS DISTINCT FROM OLD.ai_grade
    OR NEW.ai_detected          IS DISTINCT FROM OLD.ai_detected
    OR NEW.ai_detected_score    IS DISTINCT FROM OLD.ai_detected_score
    OR NEW.ai_detected_reasons  IS DISTINCT FROM OLD.ai_detected_reasons
    OR NEW.ai_review_at         IS DISTINCT FROM OLD.ai_review_at
    OR NEW.ai_review_by         IS DISTINCT FROM OLD.ai_review_by
    OR NEW.teacher_feedback     IS DISTINCT FROM OLD.teacher_feedback
    OR NEW.extra_seconds        IS DISTINCT FROM OLD.extra_seconds
    -- Las marcas de cierre: quitarlas es reabrir el intento.
    OR NEW.closed_at            IS DISTINCT FROM OLD.closed_at
    OR NEW.closed_by            IS DISTINCT FROM OLD.closed_by
    OR NEW.close_reason         IS DISTINCT FROM OLD.close_reason
    OR NEW.close_deadline       IS DISTINCT FROM OLD.close_deadline
    OR NEW.status = 'calificado'
    OR (OLD.status = 'calificado' AND NEW.status IS DISTINCT FROM OLD.status);

  IF NOT v_touch THEN RETURN NEW; END IF;

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

-- El trigger existe desde la 20261034000000, así que reemplazar la función
-- «debería» alcanzar. Se re-crea igual: esa suposición ya falló antes en este
-- proyecto —Lovable marcó migraciones como aplicadas sin haberlas corrido— y en
-- ese entorno quedaría la función nueva sin nada que la llame, o sea el candado
-- apagado en silencio. Es idempotente.
DO $mig$ BEGIN
  IF to_regclass('public.submissions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_guard_exam_submission_grade ON public.submissions;
    CREATE TRIGGER trg_guard_exam_submission_grade
      BEFORE UPDATE ON public.submissions
      FOR EACH ROW EXECUTE FUNCTION public.tg_guard_exam_submission_grade();
  END IF;
END $mig$;
