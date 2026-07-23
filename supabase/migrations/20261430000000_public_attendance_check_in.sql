-- ══════════════════════════════════════════════════════════════════════
-- Check-in de asistencia PÚBLICO (sin login) — RPC que recibe el user_id ya
-- verificado por el edge `public-attendance-check-in` (que valida email+
-- contraseña server-side). Espeja `student_check_in_attendance`
-- (20261058000000) pero recibe `p_user_id` como parámetro en vez de
-- `auth.uid()`, porque en el flujo público NO hay sesión.
--
-- CANDADO DE SEGURIDAD (requisito): el `p_session_id` identifica UNA sola
-- sesión → un solo `course_id` → un solo tenant. La asistencia se marca
-- EXACTAMENTE para esa sesión, y SOLO si el alumno está matriculado en el
-- curso de ESA sesión. No hay forma de marcar asistencia de otro curso/tenant
-- (ni aunque el alumno esté en varios cursos): la sesión fija el curso, la
-- matrícula lo verifica, y el código valida contra la seed de ESA sesión.
--
-- Gracia simétrica ±1 ventana idéntica a 20261058000000.
--
-- SEGURIDAD DE ACCESO: solo el edge (service_role) puede ejecutarla. Se
-- REVOCA de PUBLIC/anon/authenticated — llamarla directo saltaría la
-- verificación de contraseña del edge.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.public_check_in_attendance(
  p_user_id uuid,
  p_session_id uuid,
  p_code text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_session public.attendance_sessions%ROWTYPE;
  v_state public.attendance_check_in_state%ROWTYPE;
  v_period bigint;
  v_code_now text;
  v_code_prev text;
  v_code_next text;
  v_normalized text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;
  SELECT * INTO v_session FROM public.attendance_sessions WHERE id = p_session_id;
  IF NOT FOUND OR v_session.deleted_at IS NOT NULL THEN
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
  -- Matrícula en el curso EXACTO de la sesión — el candado cross-curso/tenant.
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
  v_period := floor(extract(epoch from now()) / v_state.rotation_seconds)::bigint;
  v_code_now := public.compute_attendance_code(v_state.seed, v_period);
  v_code_prev := public.compute_attendance_code(v_state.seed, v_period - 1);
  v_code_next := public.compute_attendance_code(v_state.seed, v_period + 1);
  IF v_normalized <> v_code_now AND v_normalized <> v_code_prev AND v_normalized <> v_code_next THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;
  INSERT INTO public.attendance_records (session_id, user_id, status)
  VALUES (p_session_id, p_user_id, 'presente')
  ON CONFLICT (session_id, user_id) DO UPDATE SET status = 'presente';
  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- Solo el edge (service_role) la llama. NUNCA anon/authenticated directo.
REVOKE ALL ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
