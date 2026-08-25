-- ══════════════════════════════════════════════════════════════════════
-- El check-in se define por FECHAS (inicio y fin) y el código puede quedar
-- FIJO durante toda la ventana.
--
-- ── De dónde viene ────────────────────────────────────────────────────
-- El modelo anterior era "duración en minutos desde ahora" + "rotación en
-- segundos", con topes. Se subieron dos veces y se siguieron tocando, porque el
-- modelo no era el correcto: para una jornada, una semana de inducción o una
-- sesión asincrónica, lo que el docente tiene en la cabeza es "del martes a las
-- 8 al jueves a las 18", no "2760 minutos a partir de ahora".
--
--   antes:  p_duration_minutes int  (1..1440)  → closes_at = now() + duración
--   ahora:  p_opens_at, p_closes_at timestamptz
--
-- El único tope que queda es un año, y no está para limitar al docente: está
-- para que un año mal tecleado no deje una ventana abierta hasta 2126.
--
-- ── Código FIJO: `rotation_seconds = 0` ───────────────────────────────
-- El código se deriva de la semilla y de un "período" (`floor(epoch/rotación)`),
-- así que con cualquier rotación finita el código CAMBIA en los múltiplos de esa
-- rotación — incluso con rotación de un día, cambiaría a la medianoche UTC, en
-- mitad de la ventana. Para que valga "durante todo ese tiempo" hace falta un
-- período constante, no una rotación grande.
--
-- `rotation_seconds = 0` es ese modo: el período queda en 0 y el código es el
-- mismo desde que abre hasta que cierra. La derivación (sha256 de
-- `semilla:período`) no cambia, así que el cliente y el servidor siguen
-- coincidiendo bit a bit — lo único que cambia es de dónde sale el período.
--
-- ── Lo que se pierde con el código fijo, sin adornos ──────────────────
-- La rotación es lo que ataba la marcación al MOMENTO: un código que vive 60
-- segundos hay que estar viéndolo. Un código fijo de tres días se puede mandar
-- por WhatsApp el primer día y usarlo el tercero desde cualquier lado. Sigue
-- exigiendo estar matriculado en el curso y que la ventana esté abierta, pero
-- deja de probar presencia.
--
-- Por eso el default NO cambia: quien abre un check-in normal sigue con rotación
-- de 60 segundos. El código fijo es para el caso en que la asistencia es un
-- registro de participación y no una prueba de estar en el salón.
--
-- ── Fecha de INICIO futura ────────────────────────────────────────────
-- `opened_at` pasa a significar "desde cuándo vale", no "cuándo se creó". Las
-- dos funciones que validan el código (la del alumno logueado y la del enlace
-- público) tenían que aprender a rechazar ANTES del inicio: sin eso, poner
-- fecha de inicio futura no habría hecho nada y el check-in habría aceptado
-- marcaciones desde el momento de crearlo.
-- ══════════════════════════════════════════════════════════════════════

-- ── Abrir ─────────────────────────────────────────────────────────────
-- Se dropea la firma vieja: cambiar `p_duration_minutes int` por
-- `p_closes_at timestamptz` crea un OVERLOAD que PostgREST no sabe resolver.
DROP FUNCTION IF EXISTS public.teacher_open_attendance_check_in(uuid, int, int, boolean);
DROP FUNCTION IF EXISTS public.teacher_open_attendance_check_in(uuid, int, int);

CREATE OR REPLACE FUNCTION public.teacher_open_attendance_check_in(
  p_session_id uuid,
  p_opens_at timestamptz DEFAULT NULL,
  p_closes_at timestamptz DEFAULT NULL,
  p_rotation_seconds int DEFAULT 60,
  p_email_only boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_session public.attendance_sessions%ROWTYPE;
  v_seed text;
  v_abre timestamptz;
  v_cierra timestamptz;
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

  -- Sin fechas, se comporta como antes: abre ahora y cierra en 10 minutos. Así
  -- un caller viejo (o el default del formulario) sigue funcionando.
  v_abre  := COALESCE(p_opens_at, now());
  v_cierra := COALESCE(p_closes_at, v_abre + interval '10 minutes');

  IF v_cierra <= v_abre THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_range');
  END IF;
  -- Un año. No es un límite de producto: es la red para un año mal tecleado.
  IF v_cierra > v_abre + interval '365 days' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'range_too_long');
  END IF;
  IF v_cierra <= now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'closes_in_past');
  END IF;

  -- 0 = código FIJO toda la ventana. Con rotación, el piso de 15s se queda: por
  -- debajo, el código cambia mientras el alumno lo teclea.
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

  UPDATE public.attendance_sessions SET check_in_open = true WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'ok', true,
    'seed', v_seed,
    'rotation_seconds', p_rotation_seconds,
    'opened_at', v_abre,
    'closes_at', v_cierra,
    'email_only', coalesce(p_email_only, false)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_open_attendance_check_in(uuid, timestamptz, timestamptz, int, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_open_attendance_check_in(uuid, timestamptz, timestamptz, int, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_open_attendance_check_in(uuid, timestamptz, timestamptz, int, boolean) TO authenticated;

-- ── El período, en un solo lugar ──────────────────────────────────────
-- Antes cada función que validaba un código repetía
-- `floor(extract(epoch from now()) / rotation_seconds)`. Con el modo fijo eso
-- pasa a tener dos casos, y repetir dos casos en cuatro lugares es cómo se
-- desincronizan. Acá vive una vez.
CREATE OR REPLACE FUNCTION public.attendance_code_period(p_rotation_seconds int)
RETURNS bigint
LANGUAGE sql STABLE
SET search_path = public AS $$
  SELECT CASE
    WHEN COALESCE(p_rotation_seconds, 0) <= 0 THEN 0::bigint
    ELSE floor(extract(epoch from now()) / p_rotation_seconds)::bigint
  END;
$$;

REVOKE ALL ON FUNCTION public.attendance_code_period(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attendance_code_period(int) FROM anon;
GRANT EXECUTE ON FUNCTION public.attendance_code_period(int) TO authenticated;

-- ── Validación: alumno logueado ───────────────────────────────────────
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
BEGIN
  IF v_uid IS NULL THEN
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
  -- Ventana con fecha de inicio futura: todavía no vale. NO se cierra ni se
  -- borra el estado —no venció, aún no empezó—, que es la diferencia con el
  -- bloque de arriba.
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
    -- Código fijo: no hay períodos vecinos que perdonar.
    v_ok := v_normalized = public.compute_attendance_code(v_state.seed, 0);
  ELSE
    -- Gracia SIMÉTRICA ±1 (estándar TOTP): cubre el reloj del docente adelantado
    -- y el del alumno atrasado.
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
  VALUES (p_session_id, v_uid, 'presente')
  ON CONFLICT (session_id, user_id) DO UPDATE SET status = 'presente';
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.student_check_in_attendance(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.student_check_in_attendance(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.student_check_in_attendance(uuid, text) TO authenticated;

-- ── Validación: enlace público (la llama el edge con service_role) ────
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
  ON CONFLICT (session_id, user_id) DO UPDATE SET status = 'presente';
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Solo el edge (service_role). NUNCA anon/authenticated directo.
REVOKE ALL ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) FROM authenticated;

-- ── Extender: el tope pasa a ser el mismo año ─────────────────────────
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
  -- Hasta un día por llamada (los botones ofrecen +5/+10/+15).
  IF p_extra_minutes < 1 OR p_extra_minutes > 1440 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_extra');
  END IF;

  SELECT * INTO v_state FROM public.attendance_check_in_state WHERE session_id = p_session_id;
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

NOTIFY pgrst, 'reload schema';
