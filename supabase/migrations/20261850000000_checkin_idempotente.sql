-- ══════════════════════════════════════════════════════════════════════
-- El check-in es IDEMPOTENTE: si ya hay asistencia registrada, no se vuelve a
-- marcar — se avisa que ya está.
--
-- ── Qué hacía antes ───────────────────────────────────────────────────
-- `INSERT … ON CONFLICT (session_id, user_id) DO UPDATE SET status = 'presente'`.
-- No duplicaba la fila, pero cada re-escaneo la PISABA con 'presente' y devolvía
-- `{ok:true}` como si fuera la primera vez. Dos problemas:
--
--   1. El alumno que volvía a escanear —porque no vio el mensaje, porque
--      recargó, porque el QR seguía proyectado— recibía otra vez "asistencia
--      registrada". No hay forma de distinguir "se registró" de "ya estaba", y
--      el que dudaba escaneaba una tercera vez.
--
--   2. Y el más serio: `status` tiene cuatro valores —presente, ausente,
--      tardanza, justificado— y el acta cuenta 'tardanza' como asistencia pero
--      la distingue en el reporte. Con el UPDATE, un alumno al que el docente
--      marcó 'tardanza' podía volver a escanear y quedar 'presente': el propio
--      interesado borrando la decisión del docente, sin dejar rastro.
--
-- ── Qué hace ahora ────────────────────────────────────────────────────
-- Se consulta primero. Si existe fila, se devuelve `{ok:true, already:true,
-- status:<el que estaba>}` SIN tocarla. La UI dice "ya estás marcado" y muestra
-- el estado. Si no existe, se inserta y se devuelve `{ok:true}` como siempre.
--
-- ── La decisión que no es obvia: 'ausente' ────────────────────────────
-- Se respeta TAMBIÉN el 'ausente'. Se podría argumentar lo contrario —el alumno
-- presentó un código válido dentro de la ventana, o sea que está—, pero
-- 'ausente' no aparece solo: lo pone el docente al cerrar el check-in, a
-- propósito. Dejar que el marcado del alumno lo revierta es exactamente el mismo
-- agujero que con 'tardanza', y quien tiene que corregir un ausente mal puesto
-- es el docente, desde su grilla, donde queda claro quién lo cambió.
--
-- El INSERT conserva su `ON CONFLICT DO NOTHING` como red: entre el SELECT y el
-- INSERT hay una ventana de carrera (dos pestañas escaneando a la vez) y sin eso
-- la segunda reventaría con violación de UNIQUE en vez de responder "ya estaba".
-- ══════════════════════════════════════════════════════════════════════

-- ── Alumno logueado ───────────────────────────────────────────────────
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

REVOKE ALL ON FUNCTION public.student_check_in_attendance(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.student_check_in_attendance(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.student_check_in_attendance(uuid, text) TO authenticated;

-- ── Enlace público (la llama el edge con service_role) ────────────────
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

REVOKE ALL ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) FROM authenticated;

NOTIFY pgrst, 'reload schema';
