-- ══════════════════════════════════════════════════════════════════════
-- 1) Restaura el guard de PAPELERA que perdí al reescribir la función de abrir.
-- 2) Agrega el guard de papelera del CURSO, que nunca existió en este camino.
-- 3) El enlace público puede decir de qué curso y de qué sesión es.
--
-- ── 1. La regresión ───────────────────────────────────────────────────
-- `20261016000000` (auditoría de papelera) le puso a
-- `teacher_open_attendance_check_in` un guard explícito: "no abrir check-in
-- sobre una sesión en la papelera". Al reescribir la función para el modo de
-- fechas (20261820000000) partí de otra versión y ese guard se perdió: hoy se
-- puede abrir un check-in sobre una sesión borrada.
--
-- Es EXACTAMENTE el modo de falla que el encabezado de 20261810000000 documenta
-- ("copiar la vieja revierte ese arreglo en silencio — no falla al aplicar,
-- falla cuando alguien usa la función"), reincidiendo en la misma familia de
-- funciones y un día después. La conclusión operativa: antes de reescribir una
-- función de este proyecto hay que leer TODAS las migraciones que la tocaron, no
-- la primera que aparece.
--
-- ── 2. El curso en papelera ───────────────────────────────────────────
-- Ninguna función del check-in miraba si el CURSO está en la papelera, solo la
-- sesión. Y el soft-delete NO resetea `attendance_sessions.check_in_open` (está
-- documentado en 20261018000000): entonces un curso borrado con una sesión viva
-- y su flag en true seguía teniendo un check-in "abierto". Eso contradice la
-- regla universal de CLAUDE.md —lo que está en la papelera no se ve ni se usa en
-- NINGÚN flujo— y es lo que haría que el punto 3 publicara el nombre de un curso
-- borrado en una página sin login.
--
-- ── 3. Contexto en el enlace público ──────────────────────────────────
-- La página `/asistencia?session=…&code=…` mostraba un formulario pelado: el
-- estudiante no sabía de qué curso ni de qué sesión era el check-in que estaba a
-- punto de marcar. Con varias materias el mismo día, eso es pedirle que firme a
-- ciegas.
--
-- `attendance_check_in_mode` decía "no devuelve curso, institución, título ni
-- nada del alumno". Se revierte esa decisión A PROPÓSITO, y vale decir con qué
-- criterio:
--
--   · lo que se expone es el NOMBRE del curso y el TÍTULO y FECHA de la sesión.
--     Nada de la institución, nada de ningún alumno, ningún conteo, ninguna
--     lista. El precedente más cercano del repo es el ICS del calendario
--     (`resolve_calendar_token` + su edge), que ya expone nombre de curso y
--     título de sesión a un anónimo con un token;
--   · solo cuando el check-in está EFECTIVAMENTE abierto —flag, ventana y ahora
--     también las dos papeleras—. Cerrado o borrado devuelve `open:false` y
--     ningún nombre;
--   · sigue sin ser un oráculo: un id que no existe, de otra institución, en
--     papelera o cerrado devuelven todos exactamente lo mismo. No se puede
--     distinguir "no existe" de "existe y está cerrado".
--
-- Quien abre el enlace ya tiene el id de la sesión y el código. Lo que gana
-- sabiendo el nombre del curso es entender qué está marcando; lo que gana un
-- tercero que interceptó el enlace es saber el nombre de un curso, teniendo ya
-- lo que necesita para marcar. El cambio no le da acceso a nada nuevo.
-- ══════════════════════════════════════════════════════════════════════

-- ── Abrir: con los dos guards de papelera ─────────────────────────────
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
  -- Papelera de la SESIÓN. Este guard existía desde 20261016000000 y se perdió
  -- al reescribir la función; sin él se puede abrir un check-in sobre una sesión
  -- borrada, que la regla universal de papelera prohíbe.
  IF v_session.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;
  -- Papelera del CURSO. Nunca estuvo en este camino: `attendance_session_in_my_tenant`
  -- valida institución, no papelera, y el soft-delete del curso no baja
  -- `check_in_open` de sus sesiones.
  IF public._course_in_papelera(v_session.course_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
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
  -- 0 = código FIJO toda la ventana; con rotación, el piso de 15s se queda.
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

-- ── El modo, ahora con contexto y con los guards completos ────────────
-- Reemplaza a `attendance_check_in_mode`, que además tenía dos huecos: su `open`
-- no miraba `opened_at` (así que una ventana que empieza mañana se reportaba
-- abierta) ni las papeleras.
CREATE OR REPLACE FUNCTION public.attendance_check_in_public_info(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_r record;
  v_abierto boolean := false;
BEGIN
  SELECT s.title, s.session_date, s.session_type, c.name AS curso, c.grupo,
         st.email_only, st.opened_at, st.closes_at, s.check_in_open,
         s.deleted_at AS s_del, c.deleted_at AS c_del
    INTO v_r
    FROM public.attendance_sessions s
    JOIN public.courses c ON c.id = s.course_id
    LEFT JOIN public.attendance_check_in_state st ON st.session_id = s.id
   WHERE s.id = p_session_id;

  -- Un id inexistente, de otra institución, en papelera o con el check-in
  -- cerrado devuelven TODOS lo mismo. Sin esto la función sería un oráculo:
  -- probando ids se podría averiguar cuáles existen.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('open', false, 'email_only', false);
  END IF;

  v_abierto := COALESCE(v_r.check_in_open, false)
    AND v_r.s_del IS NULL
    AND v_r.c_del IS NULL
    AND v_r.opened_at IS NOT NULL
    AND v_r.closes_at IS NOT NULL
    AND now() >= v_r.opened_at
    AND now() <= v_r.closes_at;

  IF NOT v_abierto THEN
    -- `not_started` se distingue de "cerrado" SOLO cuando la ventana existe y
    -- todavía no empezó: al estudiante que llegó temprano hay que decirle a qué
    -- hora vuelva, no "está cerrado". No se filtra nada más.
    IF v_r.s_del IS NULL AND v_r.c_del IS NULL AND v_r.opened_at IS NOT NULL
       AND now() < v_r.opened_at THEN
      RETURN jsonb_build_object(
        'open', false, 'email_only', COALESCE(v_r.email_only, false),
        'not_started', true, 'opens_at', v_r.opened_at
      );
    END IF;
    RETURN jsonb_build_object('open', false, 'email_only', false);
  END IF;

  -- Abierto de verdad: recién acá se dice de qué es. Nombre del curso, título y
  -- fecha de la sesión. Nada de la institución, nada de ningún alumno.
  RETURN jsonb_build_object(
    'open', true,
    'email_only', COALESCE(v_r.email_only, false),
    'course_name', v_r.curso,
    'course_group', v_r.grupo,
    'session_title', v_r.title,
    'session_date', v_r.session_date,
    'session_type', v_r.session_type,
    'closes_at', v_r.closes_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.attendance_check_in_public_info(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attendance_check_in_public_info(uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.attendance_check_in_public_info(uuid) IS
  'Contexto minimo para la pagina publica de asistencia: si esta abierto, si pide solo correo, y de que curso y sesion es. Solo con el check-in efectivamente abierto (flag + ventana + papelera de sesion y de curso). Un id inexistente, ajeno, en papelera o cerrado devuelven lo mismo.';

NOTIFY pgrst, 'reload schema';
