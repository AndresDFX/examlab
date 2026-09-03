-- ══════════════════════════════════════════════════════════════════════════
-- Requisito para marcar asistencia: haber COMPLETADO un ítem del curso.
--
-- El docente, al abrir el check-in de una sesión, puede exigir que el estudiante
-- haya llenado una encuesta / entregado un taller / un proyecto / un examen. Quien
-- no lo hizo no puede marcarse, y se le dice CUÁL le falta y por dónde hacerlo.
--
-- ── Dónde vive el requisito, y por qué ────────────────────────────────────
-- En `attendance_sessions` y NO en `attendance_check_in_state`: ese último se borra
-- al cerrar la ventana, así que el requisito habría que volver a elegirlo cada vez
-- que se reabre el check-in de la misma sesión. Y tampoco en una tabla aparte: el
-- pedido es UN ítem por sesión, y una tabla para un solo valor agrega una lectura y
-- una RLS nueva sin comprar nada.
--
-- ── LA PROPIEDAD QUE MANDA: nunca dejar a nadie sin asistencia ────────────
-- Este feature puede hacer un daño concreto: bloquear la asistencia de alguien que
-- SÍ fue a clase. Todo lo demás se subordina a eso.
--
--   1. `attendance_requirement_met` devuelve TRUE cuando el ítem ya NO está
--      disponible (borrado, en la papelera, despublicado, o cerrado después de
--      abrir el check-in). Falla ABIERTO. Un requisito imposible de cumplir no es
--      un requisito, es una clase perdida.
--   2. El guard va SOLO dentro de `student_check_in_attendance`. NO en un trigger
--      ni en una policy de `attendance_records`: el docente marca con un INSERT
--      directo (app.teacher.attendance.tsx), y esa es la salida de emergencia para
--      rescatar a alguien a mano. Ponerlo en la tabla se la quitaría.
--   3. El guard va DESPUÉS del "ya está marcado". A quien ya tiene su asistencia
--      puesta no se le puede quitar porque después se agregó un requisito.
--   4. El predicado usa `submitted_at IS NOT NULL` y no una lista de estados. Los
--      estados reales en producción son `completado`, `sospechoso` y `entregado`
--      para exámenes, y `calificado` / `ai_revisado` para talleres: una lista
--      blanca que olvide uno le dice "no entregaste" a alguien que sí entregó, y
--      ese es exactamente el error que no se puede cometer.
--   5. Entregas de GRUPO: la fila de `workshop_submissions` / `project_submissions`
--      lleva UN `user_id` (el último que editó), así que los demás integrantes
--      quedarían sin cumplir. Se acepta también ser miembro del grupo de la
--      entrega.
--
-- ── Encuestas: cuenta haber respondido ALGO ───────────────────────────────
-- La encuesta del caso real tiene 10 preguntas y CERO obligatorias, y su propio
-- texto dice "podés dejar en blanco lo que no quieras contestar". Exigir todas
-- contradiría lo que se le prometió al estudiante. Una respuesta cualquiera —
-- incluida la que entró por el enlace público, que escribe en la misma tabla—
-- cuenta como llenada.
-- ══════════════════════════════════════════════════════════════════════════

DO $cols$
BEGIN
  IF to_regclass('public.attendance_sessions') IS NULL THEN
    RAISE NOTICE 'Sin attendance_sessions: nada que hacer.';
    RETURN;
  END IF;

  ALTER TABLE public.attendance_sessions
    ADD COLUMN IF NOT EXISTS requirement_kind text,
    ADD COLUMN IF NOT EXISTS requirement_id uuid;

  -- Los dos van juntos o ninguno: un `kind` sin `id` no se puede evaluar y un `id`
  -- sin `kind` no se sabe en qué tabla buscarlo.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_attendance_requirement_pair'
  ) THEN
    ALTER TABLE public.attendance_sessions
      ADD CONSTRAINT chk_attendance_requirement_pair CHECK (
        (requirement_kind IS NULL AND requirement_id IS NULL)
        OR (requirement_kind IS NOT NULL AND requirement_id IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_attendance_requirement_kind'
  ) THEN
    ALTER TABLE public.attendance_sessions
      ADD CONSTRAINT chk_attendance_requirement_kind CHECK (
        requirement_kind IS NULL
        OR requirement_kind IN ('poll', 'workshop', 'project', 'exam')
      );
  END IF;
END $cols$;

-- ── ¿El ítem sigue estando disponible para el estudiante? ─────────────────
-- Un ítem borrado, en la papelera, en borrador o cerrado NO se puede completar. Se
-- usa para FALLAR ABIERTO en el predicado, y para que el docente no pueda elegir
-- algo inservible al abrir el check-in.
CREATE OR REPLACE FUNCTION public.attendance_requirement_available(
  _kind text,
  _id uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF _kind IS NULL OR _id IS NULL THEN
    RETURN false;
  END IF;

  IF _kind = 'poll' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.polls p
       WHERE p.id = _id
         AND p.deleted_at IS NULL
         AND p.is_published
         -- Un "Reto en vivo" no es algo que alguien complete por su cuenta: se
         -- juega en clase, en vivo. Exigirlo bloquearía a quien no estuvo en ESA
         -- partida, que es justo la clase a la que sí vino.
         AND p.poll_type <> 'kahoot'
         AND (p.closes_at IS NULL OR p.closes_at > now())
    );
  ELSIF _kind = 'workshop' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.workshops w
       WHERE w.id = _id AND w.deleted_at IS NULL AND w.status = 'published'
    );
  ELSIF _kind = 'project' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.projects pr
       WHERE pr.id = _id AND pr.deleted_at IS NULL AND pr.status = 'published'
    );
  ELSIF _kind = 'exam' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.exams e
       WHERE e.id = _id AND e.deleted_at IS NULL AND e.status = 'published'
    );
  END IF;
  RETURN false;
END;
$$;

-- ── ¿ESTE estudiante ya lo completó? ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.attendance_requirement_met(
  _kind text,
  _id uuid,
  _uid uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  -- Sin requisito, cumplido por definición.
  IF _kind IS NULL OR _id IS NULL THEN
    RETURN true;
  END IF;
  -- FALLA ABIERTO: el ítem ya no se puede completar, así que el requisito deja de
  -- aplicar. Sin esto, borrar o cerrar el ítem dejaría la asistencia bloqueada para
  -- siempre y sin forma de que el estudiante lo resuelva.
  IF NOT public.attendance_requirement_available(_kind, _id) THEN
    RETURN true;
  END IF;

  IF _kind = 'poll' THEN
    -- Las `mixed` guardan por pregunta; las de opción, un voto por persona. Se
    -- acepta cualquiera de las dos formas: la encuesta puede ser de cualquier tipo.
    RETURN EXISTS (
      SELECT 1 FROM public.poll_question_responses r
       WHERE r.poll_id = _id AND r.user_id = _uid
    ) OR EXISTS (
      SELECT 1 FROM public.poll_responses pr
       WHERE pr.poll_id = _id AND pr.user_id = _uid
    );
  ELSIF _kind = 'workshop' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.workshop_submissions s
       WHERE s.workshop_id = _id
         AND s.submitted_at IS NOT NULL
         AND (
           s.user_id = _uid
           -- Entrega de GRUPO: la fila lleva al último que editó, no a todos.
           OR (s.group_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.workshop_group_members m
                 WHERE m.group_id = s.group_id AND m.user_id = _uid))
         )
    );
  ELSIF _kind = 'project' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.project_submissions s
       WHERE s.project_id = _id
         AND s.submitted_at IS NOT NULL
         AND (
           s.user_id = _uid
           OR (s.group_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.project_group_members m
                 WHERE m.group_id = s.group_id AND m.user_id = _uid))
         )
    );
  ELSIF _kind = 'exam' THEN
    -- `submitted_at` y no una lista de estados: ver el punto 4 del encabezado.
    RETURN EXISTS (
      SELECT 1 FROM public.submissions s
       WHERE s.exam_id = _id AND s.user_id = _uid AND s.submitted_at IS NOT NULL
    );
  END IF;
  RETURN true;
END;
$$;

-- ── Qué mostrarle al estudiante que le falta ──────────────────────────────
-- Devuelve el título y, si lo tiene, el enlace público. Solo lo llama la RPC del
-- check-in, con el requisito de una sesión en la que la persona está matriculada,
-- así que no expone nada que no vaya a ver de todos modos.
--
-- El token público SOLO se devuelve cuando `public_enabled` está en true: es el
-- mismo criterio con el que el docente decidió publicarlo.
CREATE OR REPLACE FUNCTION public.attendance_requirement_info(
  _kind text,
  _id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_titulo text;
  v_token text;
BEGIN
  IF _kind IS NULL OR _id IS NULL THEN
    RETURN NULL;
  END IF;

  IF _kind = 'poll' THEN
    SELECT p.title, CASE WHEN p.public_enabled THEN p.public_token ELSE NULL END
      INTO v_titulo, v_token
      FROM public.polls p WHERE p.id = _id;
  ELSIF _kind = 'workshop' THEN
    SELECT w.title INTO v_titulo FROM public.workshops w WHERE w.id = _id;
  ELSIF _kind = 'project' THEN
    SELECT pr.title INTO v_titulo FROM public.projects pr WHERE pr.id = _id;
  ELSIF _kind = 'exam' THEN
    SELECT e.title INTO v_titulo FROM public.exams e WHERE e.id = _id;
  END IF;

  RETURN jsonb_build_object(
    'kind', _kind,
    'id', _id,
    'title', COALESCE(v_titulo, ''),
    'public_token', v_token
  );
END;
$$;

REVOKE ALL ON FUNCTION public.attendance_requirement_available(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attendance_requirement_available(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.attendance_requirement_met(text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attendance_requirement_met(text, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.attendance_requirement_info(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attendance_requirement_info(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.attendance_requirement_available(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_requirement_met(text, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_requirement_info(text, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ══════════════════════════════════════════════════════════════════════════
-- Abrir el check-in, ahora con el requisito.
--
-- ── DROP antes del CREATE, a propósito ────────────────────────────────────
-- Agregar parámetros con DEFAULT sin borrar la firma de 5 argumentos deja DOS
-- funciones con el mismo nombre, y PostgREST no puede resolver la llamada del
-- cliente entre ambas: responde PGRST203 y el check-in queda roto entero. Es la
-- misma trampa que ya documentó la migración de `clone_exam`.
--
-- ── El requisito se ESCRIBE siempre con lo que llega ──────────────────────
-- Pasar NULL lo quita. Es predecible, y obliga a que el diálogo lo pre-cargue desde
-- la sesión — que es lo que el docente espera al reabrir un check-in que ya tenía
-- requisito. La alternativa (ignorar el NULL) haría imposible quitarlo.
-- ══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.teacher_open_attendance_check_in(uuid, timestamptz, timestamptz, int, boolean);

CREATE OR REPLACE FUNCTION public.teacher_open_attendance_check_in(
  p_session_id uuid,
  p_opens_at timestamptz DEFAULT NULL,
  p_closes_at timestamptz DEFAULT NULL,
  p_rotation_seconds int DEFAULT 60,
  p_email_only boolean DEFAULT false,
  p_requirement_kind text DEFAULT NULL,
  p_requirement_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_session public.attendance_sessions%ROWTYPE;
  v_seed text;
  v_abre timestamptz;
  v_cierra timestamptz;
  v_del_curso boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;
  IF NOT (public.has_role(v_uid, 'Admin') OR public.has_role(v_uid, 'Docente')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;
  IF NOT public.attendance_session_in_my_tenant(p_session_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  SELECT * INTO v_session FROM public.attendance_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;
  IF v_session.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;
  IF public._course_in_papelera(v_session.course_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;

  -- ── Validación del requisito ────────────────────────────────────────────
  IF p_requirement_kind IS NOT NULL OR p_requirement_id IS NOT NULL THEN
    IF p_requirement_kind IS NULL OR p_requirement_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_requirement');
    END IF;
    -- Que el ítem sea DE ESTE CURSO. Sin esto un docente podría exigir el taller de
    -- otro curso —o de otra institución—, que el estudiante no puede ni ver.
    -- Talleres y proyectos son M:N: el vínculo real está en su tabla puente, y
    -- `course_id` es solo el ancla, así que se acepta cualquiera de los dos.
    v_del_curso := CASE p_requirement_kind
      WHEN 'poll' THEN EXISTS (
        SELECT 1 FROM public.poll_courses pc
         WHERE pc.poll_id = p_requirement_id AND pc.course_id = v_session.course_id)
      WHEN 'workshop' THEN EXISTS (
        SELECT 1 FROM public.workshop_courses wc
         WHERE wc.workshop_id = p_requirement_id AND wc.course_id = v_session.course_id)
        OR EXISTS (
        SELECT 1 FROM public.workshops w
         WHERE w.id = p_requirement_id AND w.course_id = v_session.course_id)
      WHEN 'project' THEN EXISTS (
        SELECT 1 FROM public.project_courses pjc
         WHERE pjc.project_id = p_requirement_id AND pjc.course_id = v_session.course_id)
        OR EXISTS (
        SELECT 1 FROM public.projects pr
         WHERE pr.id = p_requirement_id AND pr.course_id = v_session.course_id)
      WHEN 'exam' THEN EXISTS (
        SELECT 1 FROM public.exams e
         WHERE e.id = p_requirement_id AND e.course_id = v_session.course_id)
      ELSE false
    END;
    IF NOT v_del_curso THEN
      RETURN jsonb_build_object('ok', false, 'error', 'requirement_not_in_course');
    END IF;
    -- Y que se PUEDA completar. Exigir un borrador o algo cerrado sería un bloqueo
    -- que el estudiante no tiene forma de resolver.
    IF NOT public.attendance_requirement_available(p_requirement_kind, p_requirement_id) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'requirement_unavailable');
    END IF;
  END IF;

  v_abre  := COALESCE(p_opens_at, now());
  v_cierra := COALESCE(p_closes_at, v_abre + interval '10 minutes');

  IF v_cierra <= v_abre THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_range');
  END IF;
  IF v_cierra > v_abre + interval '365 days' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'range_too_long');
  END IF;
  IF v_cierra <= now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'closes_in_past');
  END IF;
  IF p_rotation_seconds <> 0 AND (p_rotation_seconds < 15 OR p_rotation_seconds > 86400) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_rotation');
  END IF;

  v_seed := encode(extensions.gen_random_bytes(16), 'hex');

  INSERT INTO public.attendance_check_in_state
    (session_id, seed, rotation_seconds, opened_at, closes_at, email_only)
  VALUES (p_session_id, v_seed, p_rotation_seconds, v_abre, v_cierra, coalesce(p_email_only, false))
  ON CONFLICT (session_id) DO UPDATE
    SET seed = EXCLUDED.seed,
        rotation_seconds = EXCLUDED.rotation_seconds,
        opened_at = EXCLUDED.opened_at,
        closes_at = EXCLUDED.closes_at,
        email_only = EXCLUDED.email_only;

  UPDATE public.attendance_sessions
     SET check_in_open = true,
         requirement_kind = p_requirement_kind,
         requirement_id = p_requirement_id
   WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'ok', true,
    'seed', v_seed,
    'rotation_seconds', p_rotation_seconds,
    'opened_at', v_abre,
    'closes_at', v_cierra,
    'email_only', coalesce(p_email_only, false),
    'requirement', public.attendance_requirement_info(p_requirement_kind, p_requirement_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_open_attendance_check_in(uuid, timestamptz, timestamptz, int, boolean, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_open_attendance_check_in(uuid, timestamptz, timestamptz, int, boolean, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_open_attendance_check_in(uuid, timestamptz, timestamptz, int, boolean, text, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ══════════════════════════════════════════════════════════════════════════
-- Marcar asistencia, ahora con el requisito.
--
-- El guard va DESPUÉS de "no matriculado" y ANTES de validar el código:
--
--   · Después del "ya está marcado" (que responde ok mucho antes): a quien ya tiene
--     su asistencia puesta NO se le quita porque el docente agregó un requisito
--     después. Ese guard ya estaba primero a propósito y no se mueve.
--   · Después de "no matriculado": el mensaje del requisito nombra un ítem del
--     curso, así que primero hay que saber que la persona es del curso.
--   · ANTES del código: el aviso del requisito es el ACCIONABLE. Decirle "código
--     inválido" a alguien cuyo problema real es que no llenó la encuesta lo manda a
--     pedirle el código al profesor otra vez, en clase, para volver a fallar.
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.student_check_in_attendance(
  p_session_id uuid,
  p_code text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_session public.attendance_sessions%ROWTYPE;
  v_state public.attendance_check_in_state%ROWTYPE;
  v_period bigint;
  v_normalized text;
  v_ok boolean;
  v_previo text;
  v_filas int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;
  SELECT * INTO v_session FROM public.attendance_sessions WHERE id = p_session_id;
  IF NOT FOUND OR v_session.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;
  IF public._course_in_papelera(v_session.course_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;

  -- ANTES de mirar el código: si ya está marcado, la respuesta no depende de
  -- que el código siga vigente. Con rotación, el alumno que vuelve a entrar
  -- diez minutos después tiene un código viejo, y decirle "código inválido"
  -- cuando su asistencia ya está puesta es alarmarlo por nada.
  SELECT status INTO v_previo
    FROM public.attendance_records
   WHERE session_id = p_session_id AND user_id = v_uid;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', v_previo);
  END IF;

  IF NOT v_session.check_in_open THEN
    RETURN jsonb_build_object('ok', false, 'error', 'check_in_closed');
  END IF;
  SELECT * INTO v_state FROM public.attendance_check_in_state WHERE session_id = p_session_id;
  IF NOT FOUND OR now() > v_state.closes_at THEN
    UPDATE public.attendance_sessions SET check_in_open = false WHERE id = p_session_id;
    DELETE FROM public.attendance_check_in_state WHERE session_id = p_session_id;
    RETURN jsonb_build_object('ok', false, 'error', 'check_in_closed');
  END IF;
  IF now() < v_state.opened_at THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_started');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.course_enrollments ce
    WHERE ce.course_id = v_session.course_id AND ce.user_id = v_uid
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_enrolled');
  END IF;

  v_normalized := regexp_replace(coalesce(p_code, ''), '\s+', '', 'g');
  IF v_normalized !~ '^\d{6}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;

  v_period := public.attendance_code_period(v_state.rotation_seconds);
  IF COALESCE(v_state.rotation_seconds, 0) <= 0 THEN
    v_ok := v_normalized = public.compute_attendance_code(v_state.seed, 0);
  ELSE
    v_ok := v_normalized IN (
      public.compute_attendance_code(v_state.seed, v_period),
      public.compute_attendance_code(v_state.seed, v_period - 1),
      public.compute_attendance_code(v_state.seed, v_period + 1)
    );
  END IF;
  IF NOT v_ok THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;

  -- ── El requisito, el ÚLTIMO guard ───────────────────────────────────────
  -- Va DESPUÉS del código, y las dos razones son de peso:
  --
  --  · El código es la prueba de presencia. Chequear el requisito antes
  --    convertiría esta función en un oráculo: cualquier matriculado, desde su
  --    casa y sin código, podría averiguar qué pide cada sesión y llevarse el
  --    enlace del ítem.
  --  · Un mensaje accionable POR VEZ. A alguien con el código equivocado que le
  --    decimos "completá la encuesta", la completa, reintenta con el mismo código
  --    malo y vuelve a fallar sin saber cuál de las dos cosas estaba mal.
  --
  -- Y devuelve QUÉ falta con su enlace: un "no podés marcar asistencia" a secas,
  -- en clase y con el profesor esperando, es el peor resultado posible.
  IF NOT public.attendance_requirement_met(
        v_session.requirement_kind, v_session.requirement_id, v_uid) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'requirement_pending',
      'requirement', public.attendance_requirement_info(
        v_session.requirement_kind, v_session.requirement_id)
    );
  END IF;

  -- DO NOTHING, no DO UPDATE: si otra pestaña insertó entre el SELECT de arriba
  -- y esta línea, no se pisa nada y se responde "ya estaba".
  INSERT INTO public.attendance_records (session_id, user_id, status)
  VALUES (p_session_id, v_uid, 'presente')
  ON CONFLICT (session_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;

  IF v_filas = 0 THEN
    SELECT status INTO v_previo
      FROM public.attendance_records
     WHERE session_id = p_session_id AND user_id = v_uid;
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', v_previo);
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', 'presente');
END;
$$;

NOTIFY pgrst, 'reload schema';

-- ══════════════════════════════════════════════════════════════════════════
-- Y el MISMO requisito en el camino PÚBLICO.
--
-- ── Sin esto el candado no existe ─────────────────────────────────────────
-- Hay TRES formas de marcar asistencia, no una:
--   1. `student_check_in_attendance` — la app, con sesión.
--   2. `public_check_in_attendance` — la página /asistencia, por user_id.
--   3. `public_check_in_attendance_by_email` — la misma página en modo "solo
--      correo", que DELEGA en la 2 (por eso alcanza con parchear la 2).
--
-- Poner el guard solo en la 1 lo dejaría trivialmente evitable: se abre la página
-- pública y listo. Y en modo `email_only` la 1 no se usa NUNCA, así que el
-- requisito no habría aplicado justo en las sesiones donde el docente eligió ese
-- modo.
--
-- Misma posición que en la otra: el último guard, después del código.
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.public_check_in_attendance(
  p_user_id uuid,
  p_session_id uuid,
  p_code text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  v_session public.attendance_sessions%ROWTYPE;
  v_state public.attendance_check_in_state%ROWTYPE;
  v_period bigint;
  v_normalized text;
  v_ok boolean;
  v_previo text;
  v_filas int;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;
  SELECT * INTO v_session FROM public.attendance_sessions WHERE id = p_session_id;
  IF NOT FOUND OR v_session.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;
  IF public._course_in_papelera(v_session.course_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;

  SELECT status INTO v_previo
    FROM public.attendance_records
   WHERE session_id = p_session_id AND user_id = p_user_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', v_previo);
  END IF;

  IF NOT v_session.check_in_open THEN
    RETURN jsonb_build_object('ok', false, 'error', 'check_in_closed');
  END IF;
  SELECT * INTO v_state FROM public.attendance_check_in_state WHERE session_id = p_session_id;
  IF NOT FOUND OR now() > v_state.closes_at THEN
    UPDATE public.attendance_sessions SET check_in_open = false WHERE id = p_session_id;
    DELETE FROM public.attendance_check_in_state WHERE session_id = p_session_id;
    RETURN jsonb_build_object('ok', false, 'error', 'check_in_closed');
  END IF;
  IF now() < v_state.opened_at THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_started');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.course_enrollments ce
    WHERE ce.course_id = v_session.course_id AND ce.user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_enrolled');
  END IF;
  v_normalized := regexp_replace(coalesce(p_code, ''), '\s+', '', 'g');
  IF v_normalized !~ '^\d{6}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;

  v_period := public.attendance_code_period(v_state.rotation_seconds);
  IF COALESCE(v_state.rotation_seconds, 0) <= 0 THEN
    v_ok := v_normalized = public.compute_attendance_code(v_state.seed, 0);
  ELSE
    v_ok := v_normalized IN (
      public.compute_attendance_code(v_state.seed, v_period),
      public.compute_attendance_code(v_state.seed, v_period - 1),
      public.compute_attendance_code(v_state.seed, v_period + 1)
    );
  END IF;
  IF NOT v_ok THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;

  -- El requisito, igual que en el camino con sesión y en la misma posición.
  IF NOT public.attendance_requirement_met(
        v_session.requirement_kind, v_session.requirement_id, p_user_id) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'requirement_pending',
      'requirement', public.attendance_requirement_info(
        v_session.requirement_kind, v_session.requirement_id)
    );
  END IF;

  INSERT INTO public.attendance_records (session_id, user_id, status)
  VALUES (p_session_id, p_user_id, 'presente')
  ON CONFLICT (session_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;

  IF v_filas = 0 THEN
    SELECT status INTO v_previo
      FROM public.attendance_records
     WHERE session_id = p_session_id AND user_id = p_user_id;
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', v_previo);
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', 'presente');
END;
$$;

-- Solo el edge (service_role) la llama, igual que antes de este cambio.
REVOKE ALL ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) FROM authenticated;

NOTIFY pgrst, 'reload schema';
