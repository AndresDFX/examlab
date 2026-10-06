-- ----------------------------------------------------------------------
-- Check-in: +5 / +10 / +15 estiran TODAS las sesiones del mismo código, y
-- «marcar pendientes como ausentes» pide lo mismo que las demás funciones
-- del check-in.
--
-- 1) teacher_extend_attendance_check_in
--    Cuando un código cubre varias sesiones (asistencia múltiple, mig
--    20262310000000), todas se abren con el mismo `closes_at`. Estirar solo la
--    sesión proyectada dejaba a las demás cerrando a la hora vieja: el
--    proyector mostraba la ventana nueva, pero pasada la hora vieja el mismo
--    código marcaba una sola de las sesiones. Ahora el +5 llega al grupo entero,
--    sin ACORTAR nunca a ninguna (si una ya cerraba después, se queda como
--    está) y respetando el tope de cada una (un año desde que se abrió).
--    También toma la fila con FOR UPDATE, como al abrir: el cron
--    `close-expired-attendance-checkins` borra las vencidas cada minuto, y sin
--    el candado la extensión podía caer sobre una fila ya borrada y responder
--    «ok» sin haber estirado nada. Y rechaza una sesión en la papelera (ella o
--    su curso), como abrir y ajustar.
--
-- 2) teacher_mark_pending_absent
--    Exige lo mismo que abrir, ajustar y extender: que la sesión sea de la
--    institución de quien llama y que no esté en la papelera. Cerrar NO lo
--    exige, a propósito: es la forma de apagar un check-in que quedó abierto.
-- ----------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.teacher_extend_attendance_check_in(
  p_session_id uuid,
  p_extra_minutes int DEFAULT 5
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_state public.attendance_check_in_state%ROWTYPE;
  v_base timestamptz;
  v_nuevo timestamptz;
  v_tope timestamptz;
  v_otras int := 0;
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
  -- Hasta un día por llamada (los botones ofrecen +5/+10/+15).
  IF p_extra_minutes < 1 OR p_extra_minutes > 1440 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_extra');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.attendance_sessions s
     WHERE s.id = p_session_id
       AND (s.deleted_at IS NOT NULL OR public._course_in_papelera(s.course_id))
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;

  SELECT * INTO v_state
    FROM public.attendance_check_in_state
   WHERE session_id = p_session_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_open');
  END IF;

  v_base := GREATEST(now(), v_state.closes_at);
  v_nuevo := v_base + (p_extra_minutes || ' minutes')::interval;
  -- Mismo tope que al abrir: un año desde el inicio.
  v_tope := v_state.opened_at + interval '365 days';
  IF v_nuevo > v_tope THEN
    IF v_state.closes_at >= v_tope THEN
      RETURN jsonb_build_object('ok', false, 'error', 'max_window');
    END IF;
    v_nuevo := v_tope;
  END IF;

  UPDATE public.attendance_check_in_state SET closes_at = v_nuevo WHERE session_id = p_session_id;
  UPDATE public.attendance_sessions SET check_in_open = true WHERE id = p_session_id;

  IF v_state.group_id IS NOT NULL THEN
    WITH estiradas AS (
      UPDATE public.attendance_check_in_state st
         SET closes_at = GREATEST(st.closes_at, LEAST(v_nuevo, st.opened_at + interval '365 days'))
       WHERE st.group_id = v_state.group_id
         AND st.session_id <> p_session_id
      RETURNING st.session_id
    )
    UPDATE public.attendance_sessions s
       SET check_in_open = true
      FROM estiradas e
     WHERE s.id = e.session_id
       AND s.deleted_at IS NULL;
    GET DIAGNOSTICS v_otras = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'closes_at', v_nuevo,
    'added_minutes', EXTRACT(EPOCH FROM (v_nuevo - v_base)) / 60,
    'sesiones', 1 + v_otras
  );
END;
$$;
REVOKE ALL ON FUNCTION public.teacher_extend_attendance_check_in(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_extend_attendance_check_in(uuid, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_extend_attendance_check_in(uuid, int) TO authenticated;


CREATE OR REPLACE FUNCTION public.teacher_mark_pending_absent(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_session public.attendance_sessions%ROWTYPE;
  v_inserted int;
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
  IF NOT FOUND OR v_session.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;
  IF public._course_in_papelera(v_session.course_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;

  WITH inserted AS (
    INSERT INTO public.attendance_records (session_id, user_id, status)
    SELECT p_session_id, ce.user_id, 'ausente'
    FROM public.course_enrollments ce
    WHERE ce.course_id = v_session.course_id
      AND NOT EXISTS (
        SELECT 1 FROM public.attendance_records ar
        WHERE ar.session_id = p_session_id AND ar.user_id = ce.user_id
      )
    RETURNING 1
  )
  SELECT count(*)::int INTO v_inserted FROM inserted;

  RETURN jsonb_build_object('ok', true, 'marked_absent', v_inserted);
END;
$$;
REVOKE ALL ON FUNCTION public.teacher_mark_pending_absent(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_mark_pending_absent(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_mark_pending_absent(uuid) TO authenticated;
