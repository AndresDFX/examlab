-- ══════════════════════════════════════════════════════════════════════
-- Enlace público de asistencia que pide SOLO el correo (opcional, por sesión).
--
-- ── Qué había ─────────────────────────────────────────────────────────
-- El check-in público (`/asistencia?session=…&code=…`, mig 20261430000000) ya
-- existe y funciona sin login, pero pide correo **y contraseña**. Eso NO fue un
-- descuido: la asistencia se ata a la identidad real del alumno, y la
-- contraseña es lo que impide que alguien marque presente a un compañero que no
-- vino. Un identificador adivinable —el correo institucional lo es, sigue un
-- patrón— no prueba nada por sí solo.
--
-- ── Por qué entonces se agrega el modo "solo correo" ──────────────────
-- Porque el pedido es real: en una clase con 40 personas, hacer que cada una
-- teclee su contraseña en el teléfono alarga el check-in más que pasar lista, y
-- quien no la recuerda queda afuera. Pero como el modo DEBILITA un control de
-- fraude, no se activa solo: es **opt-in por check-in**, apagado por defecto, y
-- el docente lo elige al abrir la ventana sabiendo qué cambia.
--
-- Lo que sigue protegiendo en modo "solo correo":
--   · el CÓDIGO ROTATIVO de 6 dígitos, que solo está en la pantalla proyectada
--     y cambia cada `rotation_seconds` — hay que estar mirando la proyección;
--   · la MATRÍCULA en el curso exacto de la sesión (candado cross-curso y
--     cross-institución);
--   · la ventana temporal.
-- Lo que deja de proteger: que un alumno presente marque a un ausente. Ese
-- riesgo es del modo, y por eso el modo se elige a conciencia y no es el
-- default. Para una sesión donde la asistencia tenga peso en la nota, conviene
-- dejarlo apagado.
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.attendance_check_in_state') IS NULL THEN
    RAISE NOTICE 'attendance_check_in_state ausente — se omite el modo solo-correo';
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'attendance_check_in_state'
       AND column_name = 'email_only'
  ) THEN
    ALTER TABLE public.attendance_check_in_state
      ADD COLUMN email_only boolean NOT NULL DEFAULT false;
  END IF;

  -- Dentro del guard a propósito: un COMMENT sobre una columna inexistente
  -- ABORTA la migración, y con ella el deploy entero.
  EXECUTE $c$COMMENT ON COLUMN public.attendance_check_in_state.email_only IS
    'Si true, el check-in publico acepta solo correo + codigo rotativo (sin contrasena). Opt-in por check-in; debilita el control contra marcar a un companero ausente.'$c$;
END $$;

-- ── Abrir el check-in, ahora con el modo ──────────────────────────────
-- Se DROPEA la firma vieja a propósito: agregar un parámetro con DEFAULT crea
-- un OVERLOAD y PostgREST no sabe cuál invocar ("could not choose the best
-- candidate function"). Es la misma trampa que documentó la migración de
-- clone_exam/clone_workshop/clone_project.
DROP FUNCTION IF EXISTS public.teacher_open_attendance_check_in(uuid, int, int);

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
  -- Acotación por institución que la versión anterior no tenía: `has_role` es
  -- GLOBAL, así que sin esto un docente de CUALQUIER institución podía abrir el
  -- check-in de una sesión ajena. Se corrige acá porque la función se reescribe
  -- de todos modos.
  IF NOT public.attendance_session_in_my_tenant(p_session_id) THEN
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

-- ── Lo que la página pública necesita saber ANTES de pedir nada ───────
-- La página no tiene sesión, y `attendance_check_in_state` es solo del docente,
-- así que no puede leer el modo por su cuenta. Esta función expone lo MÍNIMO
-- —¿está abierto? ¿pide contraseña?— para un id de sesión que quien abre el
-- enlace ya tiene. No devuelve curso, institución, título ni nada del alumno.
-- Va dentro de un DO porque una función `LANGUAGE sql` SÍ resuelve su cuerpo
-- al crearse (a diferencia de plpgsql, que solo hace un chequeo sintáctico):
-- sin la tabla, el CREATE falla y aborta el deploy.
DO $wrap$
BEGIN
  IF to_regclass('public.attendance_check_in_state') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.attendance_check_in_mode(p_session_id uuid)
    RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public AS $body$
      SELECT jsonb_build_object(
        'open', COALESCE((SELECT s.check_in_open AND st.closes_at > now()
                            FROM public.attendance_sessions s
                            JOIN public.attendance_check_in_state st ON st.session_id = s.id
                           WHERE s.id = p_session_id AND s.deleted_at IS NULL), false),
        'email_only', COALESCE((SELECT st.email_only
                                  FROM public.attendance_check_in_state st
                                 WHERE st.session_id = p_session_id), false)
      );
    $body$
  $fn$;
  EXECUTE 'REVOKE ALL ON FUNCTION public.attendance_check_in_mode(uuid) FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.attendance_check_in_mode(uuid) TO anon, authenticated';
END $wrap$;

-- ── Marcar presente con SOLO el correo ────────────────────────────────
-- Exige `email_only = true` en el propio cuerpo: si el docente no habilitó el
-- modo, esta puerta no existe, aunque alguien la invoque directamente.
CREATE OR REPLACE FUNCTION public.public_check_in_attendance_by_email(
  p_email text,
  p_session_id uuid,
  p_code text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_session public.attendance_sessions%ROWTYPE;
  v_state public.attendance_check_in_state%ROWTYPE;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_user_id uuid;
BEGIN
  IF v_email = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_email');
  END IF;
  SELECT * INTO v_session FROM public.attendance_sessions WHERE id = p_session_id;
  IF NOT FOUND OR v_session.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;
  SELECT * INTO v_state FROM public.attendance_check_in_state WHERE session_id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'check_in_closed');
  END IF;
  IF NOT v_state.email_only THEN
    -- El modo no está habilitado para este check-in: se exige contraseña.
    RETURN jsonb_build_object('ok', false, 'error', 'password_required');
  END IF;

  -- El correo se resuelve SOLO entre los matriculados del curso de la sesión.
  -- Buscar primero en todo `profiles` y validar matrícula después convertiría
  -- esto en un oráculo de correos de otras instituciones.
  SELECT p.id INTO v_user_id
    FROM public.profiles p
    JOIN public.course_enrollments ce
      ON ce.user_id = p.id AND ce.course_id = v_session.course_id
   WHERE lower(p.institutional_email) = v_email
      OR lower(coalesce(p.personal_email, '')) = v_email
   LIMIT 1;

  IF v_user_id IS NULL THEN
    -- Mismo error que "no matriculado": no se distingue entre "ese correo no
    -- existe" y "existe pero no está en el curso" — eso sería enumeración.
    RETURN jsonb_build_object('ok', false, 'error', 'not_enrolled');
  END IF;

  -- La validación de ventana, código rotativo y matrícula la hace la función
  -- que ya existe. Duplicarla acá sería una segunda copia del candado que se
  -- desincronizaría en la próxima corrección.
  RETURN public.public_check_in_attendance(v_user_id, p_session_id, p_code);
END;
$$;

-- Solo el edge (service_role) la llama, igual que su hermana.
REVOKE ALL ON FUNCTION public.public_check_in_attendance_by_email(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_check_in_attendance_by_email(text, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.public_check_in_attendance_by_email(text, uuid, text) FROM authenticated;
