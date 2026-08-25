-- ══════════════════════════════════════════════════════════════════════
-- Ventanas de check-in mucho más largas, y rotación de código más lenta.
--
-- ── Por qué ───────────────────────────────────────────────────────────
-- Los topes de 240 minutos y 600 segundos se estaban tocando: el docente los
-- pedía en el máximo y necesitaba más. Casos reales: una jornada completa (un
-- taller de día entero, una feria, una inducción) no cabe en 4 horas, y en un
-- grupo grande donde se pasa el teléfono de mano en mano un código que cambia
-- cada 10 minutos alcanza justo.
--
--   duración de la ventana:  1..240   →  1..1440   (hasta 24 horas)
--   rotación del código:    15..600   →  15..7200  (hasta 2 horas)
--   extensión por llamada:   1..60    →  1..480    (hasta 8 horas de un tirón)
--   techo total de la ventana: 240    →  1440
--
-- ── Lo que se pierde al alargar, dicho sin vueltas ────────────────────
-- El código rotativo es lo que prueba que el estudiante estaba MIRANDO la
-- pantalla proyectada. Cuanto más dura cada código, más tiempo sirve para
-- marcarse desde otro lado: con rotación de 2 horas, alguien puede mandarle el
-- código por chat a un compañero que no vino y ese compañero queda presente. Con
-- rotación de 60 segundos esa ventana es de un minuto.
--
-- Por eso se sube el TECHO y no el default: la ventana sigue abriendo en 10
-- minutos y el código sigue rotando cada 60 segundos. Quien necesita 24 horas lo
-- escribe; quien no, no se entera de que existe. Un default largo habría
-- debilitado el control de todas las clases para servir al caso raro.
--
-- ── Migración NUEVA, no un retoque de la anterior ─────────────────────
-- Los límites viven en `teacher_open_attendance_check_in` (mig 20261750000000) y
-- en `teacher_extend_attendance_check_in` (20261740000000), las dos YA
-- aplicadas. Editar esos archivos no cambia nada en la base y no se nota — pasó
-- con la plantilla del Acuerdo Pedagógico. Se reescriben acá con CREATE OR
-- REPLACE, que sí corre.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.teacher_open_attendance_check_in(
  p_session_id uuid,
  p_duration_minutes int DEFAULT 10,
  p_rotation_seconds int DEFAULT 60,
  p_email_only boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_session public.attendance_sessions%ROWTYPE;
  v_seed text;
  v_closes_at timestamptz;
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
  -- Hasta 24 horas. El tope existe para que un typo de cinco dígitos no deje
  -- una ventana abierta semanas; no para limitar al docente.
  IF p_duration_minutes < 1 OR p_duration_minutes > 1440 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_duration');
  END IF;
  -- Hasta 2 horas por código. El piso de 15s se queda: por debajo, el código
  -- cambia mientras el alumno lo teclea y la gracia de rotación no alcanza.
  IF p_rotation_seconds < 15 OR p_rotation_seconds > 7200 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_rotation');
  END IF;
  v_seed := encode(gen_random_bytes(16), 'hex');
  v_closes_at := now() + (p_duration_minutes || ' minutes')::interval;

  INSERT INTO public.attendance_check_in_state
    (session_id, seed, rotation_seconds, opened_at, closes_at, email_only)
  VALUES (p_session_id, v_seed, p_rotation_seconds, now(), v_closes_at, coalesce(p_email_only, false))
  ON CONFLICT (session_id) DO UPDATE
    SET seed = EXCLUDED.seed,
        rotation_seconds = EXCLUDED.rotation_seconds,
        opened_at = EXCLUDED.opened_at,
        closes_at = EXCLUDED.closes_at,
        email_only = EXCLUDED.email_only;

  UPDATE public.attendance_sessions SET check_in_open = true WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'ok', true,
    'seed', v_seed,
    'rotation_seconds', p_rotation_seconds,
    'opened_at', now(),
    'closes_at', v_closes_at,
    'email_only', coalesce(p_email_only, false)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_open_attendance_check_in(uuid, int, int, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_open_attendance_check_in(uuid, int, int, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_open_attendance_check_in(uuid, int, int, boolean) TO authenticated;

-- ── La extensión, con el mismo techo nuevo ────────────────────────────
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

  -- Hasta 8 horas de un tirón: los botones ofrecen +5/+10/+15, pero con
  -- ventanas de jornada completa tiene sentido poder estirar de a bloques
  -- grandes desde una llamada.
  IF p_extra_minutes < 1 OR p_extra_minutes > 480 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_extra');
  END IF;

  SELECT * INTO v_state
    FROM public.attendance_check_in_state
   WHERE session_id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_open');
  END IF;

  -- Si la ventana YA venció, se extiende desde ahora: sumarle minutos a algo que
  -- expiró hace horas daría una ventana que nace cerrada.
  v_base := GREATEST(now(), v_state.closes_at);
  v_nuevo := v_base + (p_extra_minutes || ' minutes')::interval;

  -- Mismo techo total que al abrir (24 h desde que se abrió), para que extender
  -- no sea la forma de saltarse el límite de la otra función.
  v_tope := v_state.opened_at + interval '1440 minutes';
  IF v_nuevo > v_tope THEN
    IF v_state.closes_at >= v_tope THEN
      RETURN jsonb_build_object('ok', false, 'error', 'max_window');
    END IF;
    v_nuevo := v_tope;
  END IF;

  UPDATE public.attendance_check_in_state
     SET closes_at = v_nuevo
   WHERE session_id = p_session_id;

  UPDATE public.attendance_sessions
     SET check_in_open = true
   WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'ok', true,
    'closes_at', v_nuevo,
    'added_minutes', EXTRACT(EPOCH FROM (v_nuevo - v_base)) / 60
  );
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_extend_attendance_check_in(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_extend_attendance_check_in(uuid, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_extend_attendance_check_in(uuid, int) TO authenticated;
