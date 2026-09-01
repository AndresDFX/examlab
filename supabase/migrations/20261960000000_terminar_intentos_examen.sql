-- ══════════════════════════════════════════════════════════════════════════
-- Terminar un intento de examen que quedó en curso.
--
-- ── El problema ───────────────────────────────────────────────────────────
-- Un intento que quedó `en_progreso` NO se puede calificar: el ojo de "ver y
-- calificar" del monitor solo se renderiza para intentos finalizados, así que el
-- docente ve la fila, ve las respuestas contadas (10/10) y no tiene ninguna
-- forma de darla por terminada — aunque el estudiante se haya desconectado hace
-- días. Las únicas órdenes que el monitor sabe mandar (pausar, reanudar, +5m)
-- viajan por realtime a la pantalla del alumno, así que son inútiles justamente
-- cuando el alumno ya no está.
--
-- ── Dos caminos, un solo efecto ───────────────────────────────────────────
--   1. MANUAL: `teacher_close_exam_attempt(_submission_id)` — el docente del
--      curso, el Admin de la institución o el SuperAdmin.
--   2. AUTOMÁTICO: `close_expired_exam_attempts()`, por pg_cron CADA MINUTO,
--      cierra los intentos cuyo plazo ya venció. Es lo que pidió el usuario:
--      "justo en la fecha fin debería lanzar un evento que las termine".
--
-- ── Por qué columnas y no un marcador implícito ───────────────────────────
-- Hoy "el docente cerró este intento" y "el alumno entregó limpio y todavía no
-- hay nota" son la MISMA fila byte a byte (`status='completado'`,
-- `submitted_at` puesto, `ai_grade` nulo). Y esa segunda forma es REANUDABLE por
-- el alumno: `app.student.take.$examId.tsx` la detecta y hace
-- `update({status:'en_progreso', submitted_at:null})`, o sea que el alumno
-- deshace el cierre Y cancela la calificación que el cierre existía para
-- habilitar. Sin un dato explícito no hay forma de distinguirlos, y la
-- alternativa evaluada —correlacionar por tiempo una fila de
-- `exam_timer_controls` con `submitted_at`— es una heurística de ±2 s: la clase
-- de invariante frágil que este repo ya pagó caro.
--
-- Además hace falta poder responder "¿quién me cerró el examen y por qué?"
-- cuando el estudiante reclame. `close_deadline` guarda el plazo que se calculó
-- en ese momento, que es lo que hace auditable el camino automático.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1 · Las columnas ──────────────────────────────────────────────────────
DO $mig$
BEGIN
  IF to_regclass('public.submissions') IS NULL THEN
    RAISE NOTICE 'Sin submissions: nada que hacer.';
    RETURN;
  END IF;

  ALTER TABLE public.submissions
    ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS closed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS close_reason TEXT,
    ADD COLUMN IF NOT EXISTS close_deadline TIMESTAMPTZ;

  -- El CHECK va por separado y con guard: `ADD CONSTRAINT IF NOT EXISTS` no
  -- existe en Postgres.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'submissions_close_reason_check'
  ) THEN
    ALTER TABLE public.submissions
      ADD CONSTRAINT submissions_close_reason_check
      CHECK (close_reason IS NULL OR close_reason IN ('manual', 'vencimiento'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'submissions_close_coherente_check'
  ) THEN
    -- O está cerrado con motivo, o no está cerrado. Un `closed_at` sin motivo
    -- sería un cierre que no se puede explicar en pantalla.
    ALTER TABLE public.submissions
      ADD CONSTRAINT submissions_close_coherente_check
      CHECK ((closed_at IS NULL) = (close_reason IS NULL));
  END IF;

  COMMENT ON COLUMN public.submissions.closed_at IS
    'Cuando el intento se dio por terminado sin que el estudiante lo entregara. NULL = entrega normal del estudiante.';
  COMMENT ON COLUMN public.submissions.closed_by IS
    'Quien lo termino. NULL con close_reason=''vencimiento'' significa que lo cerro el sistema.';
  COMMENT ON COLUMN public.submissions.close_reason IS
    'manual = lo termino el docente/Admin desde el monitor; vencimiento = se le acabo el plazo.';
  COMMENT ON COLUMN public.submissions.close_deadline IS
    'El plazo efectivo que se calculo al cerrar. Deja auditable POR QUE se cerro en ese momento.';
END $mig$;

-- Índice para el barrido de cada minuto: solo mira los que siguen en curso.
CREATE INDEX IF NOT EXISTS idx_submissions_en_curso
  ON public.submissions (exam_id)
  WHERE status = 'en_progreso';

-- ── 2 · El plazo efectivo de un intento ───────────────────────────────────
-- Tres cosas que un cálculo ingenuo se lleva por delante, las tres verificadas
-- contra el código del alumno y contra los datos de producción:
--
--   * `exams.schedule_type` vale 'normal' | 'relativo'. En 'relativo' el plazo
--     es `started_at + time_limit_minutes`; en 'normal' es `end_time` a secas.
--     El "Fin previsto" que muestra hoy el monitor aplica el mínimo de los dos
--     SIEMPRE, y en producción hay parciales 'normal' con `time_limit_minutes`
--     de 90: copiar esa fórmula acá cerraría intentos HORAS antes de tiempo.
--   * El tiempo extra autoritativo para el alumno sale de `exam_timer_controls`,
--     no de `submissions.extra_seconds`. El monitor escribe los dos cuando el
--     +5m es individual, pero el +5m GLOBAL solo toca los intentos que ya
--     estaban en curso en ese instante: quien arrancó después tiene el extra en
--     los controles y 0 en la columna. Se toma el MAYOR de los dos, que cubre
--     los dos caminos sin contar dos veces el mismo minuto.
--   * Un intento PAUSADO no vence. Si el docente lo pausó, el reloj del alumno
--     está detenido y cerrarlo por plazo sería castigar una decisión del propio
--     docente.
CREATE OR REPLACE FUNCTION public.exam_attempt_deadline(_submission_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_sub    record;
  v_exam   record;
  v_base   timestamptz;
  v_extra  integer;
BEGIN
  SELECT s.id, s.user_id, s.exam_id, s.started_at, s.extra_seconds
    INTO v_sub
    FROM public.submissions s
   WHERE s.id = _submission_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT e.end_time, e.time_limit_minutes, e.schedule_type
    INTO v_exam
    FROM public.exams e
   WHERE e.id = v_sub.exam_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF COALESCE(v_exam.schedule_type, 'normal') = 'relativo' THEN
    -- Sin duración no hay plazo relativo que calcular.
    IF COALESCE(v_exam.time_limit_minutes, 0) <= 0 THEN RETURN NULL; END IF;
    v_base := v_sub.started_at + make_interval(mins => v_exam.time_limit_minutes);
  ELSE
    v_base := v_exam.end_time;
  END IF;

  IF v_base IS NULL THEN RETURN NULL; END IF;

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
    INTO v_extra;

  RETURN v_base + make_interval(secs => COALESCE(v_extra, 0));
END;
$$;

-- Sin GRANT a nadie: las dos funciones que la usan son SECURITY DEFINER y
-- corren como el dueño. Exponerla a `authenticated` filtraría el plazo de
-- CUALQUIER intento por su id, que no es dato que nadie necesite pedir suelto.
-- (El REVOKE FROM PUBLIC no borra el EXECUTE que Supabase le otorga a `anon`
-- por default, así que ese va explícito.)
REVOKE ALL ON FUNCTION public.exam_attempt_deadline(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.exam_attempt_deadline(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.exam_attempt_deadline(uuid) FROM authenticated;

COMMENT ON FUNCTION public.exam_attempt_deadline(uuid) IS
  'Plazo efectivo de un intento: respeta schedule_type (relativo vs normal), el tiempo extra de exam_timer_controls y el de submissions.extra_seconds. NULL = sin plazo.';

-- ── 3 · ¿Está pausado? ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.exam_attempt_paused(_exam_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  -- La última orden que le aplica al alumno: individual o global, la más
  -- reciente gana. Es el mismo criterio que usa el monitor para pintar el botón.
  SELECT COALESCE((
    SELECT c.action = 'pause'
      FROM public.exam_timer_controls c
     WHERE c.exam_id = _exam_id
       AND (c.target_user_id IS NULL OR c.target_user_id = _user_id)
       AND c.action IN ('pause', 'resume')
     ORDER BY c.created_at DESC
     LIMIT 1
  ), false);
$$;

REVOKE ALL ON FUNCTION public.exam_attempt_paused(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.exam_attempt_paused(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.exam_attempt_paused(uuid, uuid) FROM authenticated;

-- ── 4 · Terminar a mano ───────────────────────────────────────────────────
-- Autorización: docente del curso del examen, Admin de la institución de ese
-- curso, o SuperAdmin. Se replica la policy `submissions_update` (mig
-- 20260820000000) porque la función es SECURITY DEFINER y por lo tanto la RLS no
-- se aplica sola. `is_admin_of_course_tenant` ya trae dentro `is_super_admin()`
-- y el scope de institución — una rama `has_role('Admin')` suelta sería un leak
-- cross-tenant, que es el anti-patrón que este repo ya documentó.
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

  RETURN jsonb_build_object('ok', true, 'changed', true, 'status', 'completado');
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_close_exam_attempt(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_close_exam_attempt(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_close_exam_attempt(uuid) TO authenticated;

COMMENT ON FUNCTION public.teacher_close_exam_attempt(uuid) IS
  'Da por terminado un intento en curso para poder calificarlo. Docente del curso / Admin de la institucion / SuperAdmin. Idempotente.';

-- ── 5 · El evento automático ──────────────────────────────────────────────
-- Margen de gracia: se cierra un minuto DESPUÉS del plazo, no en el segundo
-- exacto. Quien está entregando justo al vencer tiene su autosave cada 1,5 s y
-- su `performSubmit` en vuelo; cortarlo en el mismo instante convertiría una
-- entrega válida en un cierre por vencimiento.
CREATE OR REPLACE FUNCTION public.close_expired_exam_attempts()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_n integer := 0;
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
  )
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
     AND s.status = 'en_progreso';

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- Solo el sistema (cron / service_role) lo invoca.
REVOKE ALL ON FUNCTION public.close_expired_exam_attempts() FROM PUBLIC;

COMMENT ON FUNCTION public.close_expired_exam_attempts() IS
  'Cada minuto: da por terminados los intentos de examen cuyo plazo efectivo ya vencio (con un minuto de gracia). Respeta pausas, tiempo extra, schedule_type y papelera.';

DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    RAISE NOTICE 'pg_cron no instalado, salida limpia.';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'close-expired-exam-attempts') THEN
    PERFORM cron.schedule(
      'close-expired-exam-attempts',
      '* * * * *',
      $$ SELECT public.close_expired_exam_attempts(); $$
    );
  END IF;
END
$cron$;

INSERT INTO public.cron_job_descriptions (jobname, description)
VALUES (
  'close-expired-exam-attempts',
  'Cada minuto: da por terminados los intentos de examen cuyo plazo ya vencio, para que el docente pueda calificarlos sin tener que acordarse. Respeta el tiempo extra concedido, las pausas, los examenes con horario relativo y los que estan en la papelera. Deja un minuto de gracia para no cortar una entrega en vuelo.'
)
ON CONFLICT (jobname) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at = now();

-- ── 6 · Que el alumno no reabra lo que se cerró ───────────────────────────
-- La pantalla del alumno reabre un intento `completado` sin nota (es el caso
-- legítimo "entregué limpio y todavía no hay feedback"). Un intento TERMINADO
-- por el docente o por vencimiento es, byte a byte, esa misma fila — por eso
-- hace falta el dato explícito, y por eso el bloqueo vive acá y no solo en el
-- cliente: la pantalla se puede saltar, el trigger no.
CREATE OR REPLACE FUNCTION public.tg_block_reopen_closed_attempt()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL
     AND NEW.status = 'en_progreso'
     AND OLD.status <> 'en_progreso' THEN
    -- El staff SÍ puede reabrirlo (es una decisión suya, y para eso limpia las
    -- marcas de cierre); el estudiante no.
    IF NEW.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Este intento ya fue terminado y no se puede reanudar. Pedile al docente que lo reabra.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_reopen_closed_attempt ON public.submissions;
CREATE TRIGGER trg_block_reopen_closed_attempt
  BEFORE UPDATE ON public.submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_block_reopen_closed_attempt();

NOTIFY pgrst, 'reload schema';
