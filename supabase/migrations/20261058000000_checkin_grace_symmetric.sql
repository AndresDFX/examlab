-- ══════════════════════════════════════════════════════════════════════
-- student_check_in_attendance: la gracia de rotación era UNILATERAL (solo aceptaba
-- el período actual y el anterior del reloj del SERVIDOR). El código QR lo genera
-- el navegador del DOCENTE con SU reloj; si ese reloj ADELANTA al del servidor
-- (más de rotation_seconds), el código proyectado corresponde a period+1 y el
-- servidor lo rechaza (invalid_code) para TODOS los alumnos. Fix: gracia simétrica
-- ±1 ventana (patrón TOTP estándar) — aceptar también period+1. Migración forward
-- (reemplaza la definición viva; cubre 20260507100000 + 20261018000000).
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.student_check_in_attendance(p_session_id uuid, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_session public.attendance_sessions%ROWTYPE;
  v_state public.attendance_check_in_state%ROWTYPE;
  v_period bigint;
  v_code_now text;
  v_code_prev text;
  v_code_next text;
  v_normalized text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;
  SELECT * INTO v_session FROM public.attendance_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;
  IF v_session.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
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
  v_period := floor(extract(epoch from now()) / v_state.rotation_seconds)::bigint;
  v_code_now := public.compute_attendance_code(v_state.seed, v_period);
  v_code_prev := public.compute_attendance_code(v_state.seed, v_period - 1);
  -- Gracia SIMÉTRICA ±1: también period+1, por si el reloj del docente (que genera
  -- el QR) adelanta al del servidor. Estándar TOTP (una ventana a cada lado).
  v_code_next := public.compute_attendance_code(v_state.seed, v_period + 1);
  IF v_normalized <> v_code_now AND v_normalized <> v_code_prev AND v_normalized <> v_code_next THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;
  INSERT INTO public.attendance_records (session_id, user_id, status)
  VALUES (p_session_id, v_uid, 'presente')
  ON CONFLICT (session_id, user_id) DO UPDATE SET status = 'presente';
  RETURN jsonb_build_object('ok', true);
END;
$function$;

NOTIFY pgrst, 'reload schema';
