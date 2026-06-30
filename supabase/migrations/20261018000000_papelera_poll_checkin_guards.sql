-- ══════════════════════════════════════════════════════════════════════
-- Auditoría papelera (2º pase) — interacción del alumno con poll/sesión en papelera.
--
-- 1) poll_is_open(_poll): no consideraba `deleted_at` → una encuesta en papelera
--    pero dentro de su ventana seguía contando como "abierta". Las 5 funciones
--    que la consumen (vote_poll_option, clear_poll_response,
--    teacher_assign_remaining_to_slots, submit_poll_question_response,
--    clear_poll_question_responses) heredaban el agujero: un alumno con el
--    deep-link `?poll=` podía VOTAR una encuesta borrada. Se añade
--    `AND _poll.deleted_at IS NULL` en un solo lugar (la función sigue IMMUTABLE:
--    solo lee la fila recibida). No la usa ninguna policy RLS — cambio seguro.
--
-- 2) student_check_in_attendance: marcaba asistencia por QR/deep-link sobre una
--    sesión en papelera si `check_in_open` quedó en true al borrarla (el
--    soft-delete no cierra el check-in). El guard de OPEN
--    (teacher_open_attendance_check_in, mig 20261016) no cubre este camino. Se
--    añade el guard `deleted_at` tras resolver la sesión.
--
-- NO se toca kahoot_submit_answer: el JOIN (kahoot_join_game/by_id) ya filtra
-- papelera, así que un alumno no puede ENTRAR a un juego de una encuesta
-- borrada; el único hueco sería borrar la encuesta EN MEDIO de un juego en vivo
-- con alumnos respondiendo (caso extremo, sin daño real — las respuestas se
-- purgan con la encuesta). Reproducir esa función (90 líneas de scoring/anti-
-- cheat) por un guard de bajísimo valor es más riesgoso que el beneficio.
-- Funciones teacher-only (teacher_reassign_poll_response,
-- teacher_clear_poll_response_for_user, teacher_clear_poll_question_response_for_user):
-- gestión del docente sobre SU propia encuesta borrada — sin exposición a
-- alumnos ni cross-tenant; aceptado de bajo riesgo.
-- ══════════════════════════════════════════════════════════════════════

-- ── 1) poll_is_open ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.poll_is_open(_poll polls)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT NOT _poll.closed_manually
     AND _poll.opens_at <= now()
     AND (_poll.closes_at IS NULL OR _poll.closes_at > now())
     AND _poll.deleted_at IS NULL;
$function$;

-- ── 2) student_check_in_attendance ─────────────────────────────────────
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
  v_normalized text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;
  SELECT * INTO v_session FROM public.attendance_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;
  -- Papelera: una sesión borrada no admite check-in aunque check_in_open siga
  -- en true (el soft-delete no lo resetea). Se trata como inexistente.
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
  IF v_normalized <> v_code_now AND v_normalized <> v_code_prev THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;

  INSERT INTO public.attendance_records (session_id, user_id, status)
  VALUES (p_session_id, v_uid, 'presente')
  ON CONFLICT (session_id, user_id) DO UPDATE SET status = 'presente';

  RETURN jsonb_build_object('ok', true);
END;
$function$;

NOTIFY pgrst, 'reload schema';
