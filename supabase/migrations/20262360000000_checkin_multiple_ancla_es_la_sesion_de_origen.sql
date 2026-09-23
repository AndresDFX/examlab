-- ═══════════════════════════════════════════════════════════════════════
-- El ancla del check-in múltiple es la sesión DESDE LA QUE se abrió
-- ═══════════════════════════════════════════════════════════════════════
-- El ancla es la sesión a la que apunta el enlace y el QR, y por lo tanto la
-- que da el encabezado de la pantalla pública. `teacher_open_attendance_check_in_multi`
-- la elegía como «la más antigua por fecha», con el argumento de que sería «la
-- de ahora». Ese argumento no se sostiene en el caso de uso REAL, que es el que
-- motivó toda la funcionalidad:
--
--   El docente está dando la Sesión 3 y abre un código que cubre también la 1 y
--   la 2, para que quien faltó las recupere. Con la regla anterior el ancla
--   quedaba en la Sesión 1 (8 de septiembre) y el estudiante, sentado en la
--   clase de hoy, abría el enlace y leía «Sesión 1 — Presentación del curso».
--
-- La sesión de origen es la que el docente tiene abierta y la que sus alumnos
-- reconocen como la de hoy. El cliente ya la manda PRIMERA en el arreglo
-- (`[sess.id, ...extras]` en `app.teacher.attendance.tsx`), así que el contrato
-- pasa a ser explícito: **el primer elemento es el origen y es el ancla**.
--
-- Nada más cambia. El ancla solo determina de dónde sale la semilla que el
-- grupo comparte y a qué sesión apunta el enlace; marcar, cerrar y propagar
-- funcionan desde cualquier miembro. El guard de «ninguna hermana puede tener
-- ya un check-in vivo» sigue exceptuando al ancla, que ahora es el origen: su
-- semilla es la que el grupo adopta, así que sus estudiantes conservan el
-- código que ya están mirando.
CREATE OR REPLACE FUNCTION public.teacher_open_attendance_check_in_multi(
  p_session_ids uuid[],
  p_opens_at timestamptz DEFAULT NULL,
  p_closes_at timestamptz DEFAULT NULL,
  p_rotation_seconds int DEFAULT NULL,
  p_email_only boolean DEFAULT NULL,
  p_requirements jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_ids     uuid[];
  v_id      uuid;
  v_curso   uuid;
  v_curso_i uuid;
  v_ancla   uuid;
  v_grupo   uuid := gen_random_uuid();
  v_res     jsonb;
  v_semilla text;
  v_abiertas int := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;
  IF NOT (public.has_role(v_uid, 'Admin') OR public.has_role(v_uid, 'Docente')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  -- Duplicados fuera, PRESERVANDO EL ORDEN: el primero es el origen y de ahí
  -- sale el ancla. Un `SELECT DISTINCT` sin orden lo perdería.
  SELECT array_agg(x ORDER BY orden) INTO v_ids
    FROM (
      SELECT x, MIN(orden) AS orden
        FROM unnest(p_session_ids) WITH ORDINALITY AS t(x, orden)
       WHERE x IS NOT NULL
       GROUP BY x
    ) s;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_sessions');
  END IF;
  IF array_length(v_ids, 1) > 20 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'too_many_sessions');
  END IF;

  -- TODAS del MISMO curso. Un código que cruza cursos es una puerta a marcar
  -- asistencia en una clase a la que el alumno no va.
  FOREACH v_id IN ARRAY v_ids
  LOOP
    SELECT course_id INTO v_curso_i
      FROM public.attendance_sessions
     WHERE id = v_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
    END IF;
    IF v_curso IS NULL THEN
      v_curso := v_curso_i;
    ELSIF v_curso <> v_curso_i THEN
      RETURN jsonb_build_object('ok', false, 'error', 'mixed_courses');
    END IF;
  END LOOP;

  -- El ANCLA: la sesión de ORIGEN, que el cliente manda primera.
  v_ancla := v_ids[1];

  -- ── Ninguna hermana puede tener YA un check-in vivo ────────────────────
  -- Si una hermana tiene su ventana abierta, `teacher_open_attendance_check_in`
  -- toma su rama de AJUSTE, que PRESERVA la semilla a propósito, y el UPDATE de
  -- más abajo la pisaría con la del ancla: invalidaría en silencio el código que
  -- esa clase está mirando en el proyector. Se RECHAZA en vez de saltear, para
  -- que el docente no termine con un código que cubre menos de lo que cree.
  -- El ancla SÍ puede estar viva: su semilla es la que el grupo adopta.
  SELECT s.id INTO v_id
    FROM public.attendance_check_in_state st
    JOIN public.attendance_sessions s ON s.id = st.session_id
   WHERE st.session_id = ANY(v_ids)
     AND st.session_id <> v_ancla
     AND st.closes_at > now()
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_already_open', 'session_id', v_id);
  END IF;

  -- Se abre el ancla PRIMERO y con la RPC existente: de ahí sale la semilla que
  -- van a compartir todas. Si el ancla falla se devuelve su error tal cual.
  v_res := public.teacher_open_attendance_check_in(
    v_ancla, p_opens_at, p_closes_at, p_rotation_seconds, p_email_only, p_requirements
  );
  IF COALESCE((v_res ->> 'ok')::boolean, false) IS NOT TRUE THEN
    RETURN v_res;
  END IF;
  v_abiertas := 1;

  SELECT seed INTO v_semilla
    FROM public.attendance_check_in_state WHERE session_id = v_ancla;

  -- Las hermanas: misma ventana y MISMA SEMILLA, que es lo que hace que un solo
  -- código valga para todas. Una que falla NO aborta el grupo.
  FOREACH v_id IN ARRAY v_ids
  LOOP
    CONTINUE WHEN v_id = v_ancla;
    v_res := public.teacher_open_attendance_check_in(
      v_id, p_opens_at, p_closes_at, p_rotation_seconds, p_email_only, p_requirements
    );
    IF COALESCE((v_res ->> 'ok')::boolean, false) IS TRUE THEN
      UPDATE public.attendance_check_in_state
         SET seed = v_semilla
       WHERE session_id = v_id;
      v_abiertas := v_abiertas + 1;
    END IF;
  END LOOP;

  -- El grupo se sella al final, y solo sobre las que quedaron abiertas: una
  -- sesión sin estado no puede ser parte del grupo.
  UPDATE public.attendance_check_in_state
     SET group_id = v_grupo
   WHERE session_id = ANY(v_ids);

  RETURN jsonb_build_object(
    'ok', true,
    'group_id', v_grupo,
    'anchor_session_id', v_ancla,
    'opened', v_abiertas,
    'requested', array_length(v_ids, 1),
    'seed', v_semilla,
    'rotation_seconds', (SELECT rotation_seconds FROM public.attendance_check_in_state WHERE session_id = v_ancla),
    'opened_at', (SELECT opened_at FROM public.attendance_check_in_state WHERE session_id = v_ancla),
    'closes_at', (SELECT closes_at FROM public.attendance_check_in_state WHERE session_id = v_ancla),
    'email_only', (SELECT email_only FROM public.attendance_check_in_state WHERE session_id = v_ancla)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_open_attendance_check_in_multi(uuid[], timestamptz, timestamptz, int, boolean, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_open_attendance_check_in_multi(uuid[], timestamptz, timestamptz, int, boolean, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_open_attendance_check_in_multi(uuid[], timestamptz, timestamptz, int, boolean, jsonb) TO authenticated;

COMMENT ON FUNCTION public.teacher_open_attendance_check_in_multi(uuid[], timestamptz, timestamptz, int, boolean, jsonb) IS
  'Abre un check-in que cubre varias sesiones del MISMO curso con un solo codigo. El PRIMER elemento del arreglo es la sesion de origen y queda como ancla: es a la que apuntan el enlace y el QR.';
