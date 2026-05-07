-- ============================================================
-- Self check-in de asistencia con código rotativo (TOTP-like)
--
-- Flujo:
--   1) Docente "abre check-in" en una sesión existente
--      → genera seed aleatoria + ventana temporal (closes_at)
--      → la fila check_in_open queda en true en attendance_sessions
--   2) Cliente del docente proyecta QR + código de 6 dígitos
--      derivado de la seed y el período actual (cambia cada N seg)
--   3) Estudiante escanea QR (deep-link a /app/student/attendance
--      con session+code) o escribe el código manual
--   4) RPC student_check_in_attendance valida el código (acepta el
--      período actual y el anterior por gracia) y upsertea el record
--      como 'presente'
--   5) Docente cierra manual o expira por closes_at
--
-- Decisión de seguridad:
--   La seed vive en una tabla separada con RLS Docente/Admin only.
--   attendance_sessions queda con SOLO el flag check_in_open visible
--   a estudiantes — así no pueden derivar códigos sin estar en clase.
--   La RPC SECURITY DEFINER es la única vía del estudiante.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) Flag de estado en la sesión (visible a todos los autenticados via RLS)
ALTER TABLE public.attendance_sessions
  ADD COLUMN IF NOT EXISTS check_in_open boolean NOT NULL DEFAULT false;

-- 2) Estado sensible del check-in. RLS Docente/Admin only.
CREATE TABLE IF NOT EXISTS public.attendance_check_in_state (
  session_id uuid PRIMARY KEY REFERENCES public.attendance_sessions(id) ON DELETE CASCADE,
  seed text NOT NULL,
  rotation_seconds int NOT NULL DEFAULT 60,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closes_at timestamptz NOT NULL
);

ALTER TABLE public.attendance_check_in_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "check_in_state_teacher_admin" ON public.attendance_check_in_state;
CREATE POLICY "check_in_state_teacher_admin"
  ON public.attendance_check_in_state FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));

-- 3) Función pura para derivar el código de 6 dígitos.
--    sha256(seed || ':' || period) → primeros 7 hex chars (28 bits, siempre positivo)
--    → módulo 1.000.000 → padding a 6 dígitos.
--    Cliente JS replica exactamente el mismo cálculo.
CREATE OR REPLACE FUNCTION public.compute_attendance_code(p_seed text, p_period bigint)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  h text;
  n int;
BEGIN
  h := encode(digest(p_seed || ':' || p_period::text, 'sha256'), 'hex');
  n := (('x' || substr(h, 1, 7))::bit(28))::int;
  RETURN lpad((n % 1000000)::text, 6, '0');
END;
$$;

-- 4) RPC del docente: abrir el check-in
CREATE OR REPLACE FUNCTION public.teacher_open_attendance_check_in(
  p_session_id uuid,
  p_duration_minutes int DEFAULT 10,
  p_rotation_seconds int DEFAULT 60
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
  SELECT * INTO v_session FROM public.attendance_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;
  IF p_duration_minutes < 1 OR p_duration_minutes > 240 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_duration');
  END IF;
  IF p_rotation_seconds < 15 OR p_rotation_seconds > 600 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_rotation');
  END IF;
  v_seed := encode(gen_random_bytes(16), 'hex');
  v_closes_at := now() + (p_duration_minutes || ' minutes')::interval;

  INSERT INTO public.attendance_check_in_state
    (session_id, seed, rotation_seconds, opened_at, closes_at)
  VALUES (p_session_id, v_seed, p_rotation_seconds, now(), v_closes_at)
  ON CONFLICT (session_id) DO UPDATE
    SET seed = EXCLUDED.seed,
        rotation_seconds = EXCLUDED.rotation_seconds,
        opened_at = EXCLUDED.opened_at,
        closes_at = EXCLUDED.closes_at;

  UPDATE public.attendance_sessions SET check_in_open = true WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'ok', true,
    'seed', v_seed,
    'rotation_seconds', p_rotation_seconds,
    'opened_at', now(),
    'closes_at', v_closes_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.teacher_open_attendance_check_in(uuid, int, int) TO authenticated;

-- 5) RPC del docente: cerrar el check-in (limpia la seed)
CREATE OR REPLACE FUNCTION public.teacher_close_attendance_check_in(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;
  IF NOT (public.has_role(v_uid, 'Admin') OR public.has_role(v_uid, 'Docente')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;
  UPDATE public.attendance_sessions SET check_in_open = false WHERE id = p_session_id;
  DELETE FROM public.attendance_check_in_state WHERE session_id = p_session_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.teacher_close_attendance_check_in(uuid) TO authenticated;

-- 6) RPC del estudiante: marcarse presente con código
CREATE OR REPLACE FUNCTION public.student_check_in_attendance(
  p_session_id uuid,
  p_code text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
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
  IF NOT v_session.check_in_open THEN
    RETURN jsonb_build_object('ok', false, 'error', 'check_in_closed');
  END IF;

  SELECT * INTO v_state FROM public.attendance_check_in_state WHERE session_id = p_session_id;
  IF NOT FOUND OR now() > v_state.closes_at THEN
    -- Auto-cierre si ya pasó la ventana (sin marcar restantes — eso lo hace el docente)
    UPDATE public.attendance_sessions SET check_in_open = false WHERE id = p_session_id;
    DELETE FROM public.attendance_check_in_state WHERE session_id = p_session_id;
    RETURN jsonb_build_object('ok', false, 'error', 'check_in_closed');
  END IF;

  -- Estudiante debe estar matriculado en el curso
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
$$;

GRANT EXECUTE ON FUNCTION public.student_check_in_attendance(uuid, text) TO authenticated;

-- 7) RPC: marcar a todos los pendientes como ausentes (post check-in)
--    Idempotente: solo inserta records que no existan; no toca los existentes.
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
  SELECT * INTO v_session FROM public.attendance_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
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

GRANT EXECUTE ON FUNCTION public.teacher_mark_pending_absent(uuid) TO authenticated;

-- 8) Habilita realtime para que el docente vea el contador live (presentes en vivo).
--    Idempotente — si la tabla ya está en la publicación se ignora.
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.attendance_records;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
