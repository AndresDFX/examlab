-- ══════════════════════════════════════════════════════════════════════════
-- Dos arreglos de lo de ayer, los dos vistos en producción con estudiantes en
-- clase.
--
-- ── 1. Abrir el check-in BORRABA los requisitos ───────────────────────────
-- `teacher_open_attendance_check_in` reemplazaba el set por lo que recibía, y con
-- `NULL` eso significaba "dejar la sesión sin requisitos". Medido: de las 45
-- sesiones configuradas, la ÚNICA que perdió los suyos fue la única a la que se le
-- abrió el check-in.
--
-- El camino es fácil de pisar y no avisa: el diálogo pre-carga los requisitos con
-- una consulta ASÍNCRONA y no bloquea el botón, así que abrir el check-in apurado
-- —que es como se abre, con la clase esperando— envía una lista vacía y borra la
-- configuración de todo el semestre.
--
-- Ahora `NULL` significa **no tocar** y solo un arreglo explícito reemplaza. `[]`
-- sigue siendo "quitar todos", que es la forma de quitarlos a propósito. La
-- diferencia importa: cualquier cliente que no mande el campo —uno en caché, un
-- script, una versión vieja— ya no puede destruir nada.
--
-- ── 2. El estudiante veía el texto crudo `requirement_pending` ────────────
-- La respuesta pasó de `requirement` (uno) a `requirements` (arreglo) en la misma
-- tanda. La aplicación es una SPA estática: el navegador del estudiante tenía la
-- versión ANTERIOR en caché, que leía `requirement`, no lo encontró, y cayó al
-- mensaje genérico — que imprime el código de error tal cual. En pantalla, en
-- clase, decía "requirement_pending".
--
-- Se devuelven LOS DOS campos: `requirements` con todas y `requirement` con la
-- primera. Un cliente viejo vuelve a mostrar un mensaje entendible sin que nadie
-- recargue nada. Cambiar el nombre de un campo de respuesta sin dejar el anterior
-- es una ruptura para los clientes que ya están servidos.
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.teacher_open_attendance_check_in(
  p_session_id uuid,
  p_opens_at timestamptz DEFAULT NULL,
  p_closes_at timestamptz DEFAULT NULL,
  p_rotation_seconds int DEFAULT 60,
  p_email_only boolean DEFAULT false,
  p_requirements jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_session public.attendance_sessions%ROWTYPE;
  v_seed text;
  v_abre timestamptz;
  v_cierra timestamptz;
  v_req jsonb;
  v_kind text;
  v_id uuid;
  v_del_curso boolean;
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
  IF v_session.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;
  IF public._course_in_papelera(v_session.course_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;

  -- Validación de CADA requisito, antes de tocar nada: aceptar tres y rechazar el
  -- cuarto dejaría la sesión a medio configurar sin que el docente lo sepa.
  IF jsonb_typeof(p_requirements) = 'array' THEN
    FOR v_req IN SELECT * FROM jsonb_array_elements(p_requirements)
    LOOP
      v_kind := v_req->>'kind';
      BEGIN
        v_id := (v_req->>'id')::uuid;
      EXCEPTION WHEN others THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_requirement');
      END;
      IF v_kind IS NULL OR v_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_requirement');
      END IF;

      v_del_curso := CASE v_kind
        WHEN 'poll' THEN EXISTS (
          SELECT 1 FROM public.poll_courses pc
           WHERE pc.poll_id = v_id AND pc.course_id = v_session.course_id)
        WHEN 'workshop' THEN EXISTS (
          SELECT 1 FROM public.workshop_courses wc
           WHERE wc.workshop_id = v_id AND wc.course_id = v_session.course_id)
          OR EXISTS (
          SELECT 1 FROM public.workshops w
           WHERE w.id = v_id AND w.course_id = v_session.course_id)
        WHEN 'project' THEN EXISTS (
          SELECT 1 FROM public.project_courses pjc
           WHERE pjc.project_id = v_id AND pjc.course_id = v_session.course_id)
          OR EXISTS (
          SELECT 1 FROM public.projects pr
           WHERE pr.id = v_id AND pr.course_id = v_session.course_id)
        WHEN 'exam' THEN EXISTS (
          SELECT 1 FROM public.exams e
           WHERE e.id = v_id AND e.course_id = v_session.course_id)
        WHEN 'report_signature' THEN EXISTS (
          SELECT 1 FROM public.generated_reports gr
           WHERE gr.id = v_id AND gr.course_id = v_session.course_id)
        ELSE false
      END;
      IF NOT v_del_curso THEN
        RETURN jsonb_build_object('ok', false, 'error', 'requirement_not_in_course');
      END IF;
      IF NOT public.attendance_requirement_available(v_kind, v_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'requirement_unavailable');
      END IF;
    END LOOP;
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
  IF p_rotation_seconds <> 0 AND (p_rotation_seconds < 15 OR p_rotation_seconds > 86400) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_rotation');
  END IF;

  -- ── SOLO se toca el set si llegó un arreglo ─────────────────────────────
  -- `NULL` = no tocar. Sin esta distinción, abrir el check-in desde un cliente que
  -- no manda el campo borra la configuración del semestre — y así se perdió la de
  -- una sesión real, en clase.
  IF jsonb_typeof(p_requirements) = 'array' THEN
    DELETE FROM public.attendance_session_requirements WHERE session_id = p_session_id;
    INSERT INTO public.attendance_session_requirements (session_id, kind, item_id, created_by)
    SELECT p_session_id, e->>'kind', (e->>'id')::uuid, v_uid
      FROM jsonb_array_elements(p_requirements) e
    ON CONFLICT DO NOTHING;
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
    'email_only', coalesce(p_email_only, false),
    -- Cuántos requisitos quedaron, para que la pantalla pueda confirmarlo en vez de
    -- suponerlo: es la señal que habría delatado el borrado el primer día.
    'requirements_count', (
      SELECT count(*) FROM public.attendance_session_requirements
       WHERE session_id = p_session_id
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_open_attendance_check_in(uuid, timestamptz, timestamptz, int, boolean, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_open_attendance_check_in(uuid, timestamptz, timestamptz, int, boolean, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_open_attendance_check_in(uuid, timestamptz, timestamptz, int, boolean, jsonb) TO authenticated;

-- ── Compatibilidad con los clientes en caché: los DOS campos ──────────────
-- `requirements` (todas) y `requirement` (la primera). Un navegador con la versión
-- anterior servida vuelve a mostrar un mensaje entendible sin recargar nada.
CREATE OR REPLACE FUNCTION public.attendance_requirements_payload(_pend jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = public AS $$
  SELECT jsonb_build_object(
    'ok', false,
    'error', 'requirement_pending',
    'requirements', _pend,
    'requirement', _pend->0
  );
$$;

REVOKE ALL ON FUNCTION public.attendance_requirements_payload(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attendance_requirements_payload(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.attendance_requirements_payload(jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ── Los dos caminos de marcado devuelven el payload compatible ────────────

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
  v_previo text;
  v_filas int;
  v_pend jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;
  SELECT * INTO v_session FROM public.attendance_sessions WHERE id = p_session_id;
  IF NOT FOUND OR v_session.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;
  IF public._course_in_papelera(v_session.course_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;

  SELECT status INTO v_previo
    FROM public.attendance_records
   WHERE session_id = p_session_id AND user_id = v_uid;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', v_previo);
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

  -- Los requisitos, el último guard (después del código: el código es la prueba de
  -- presencia, y chequearlos antes volvería esta función un oráculo).
  v_pend := public.attendance_requirements_pending(p_session_id, v_uid);
  IF jsonb_array_length(v_pend) > 0 THEN
    RETURN public.attendance_requirements_payload(v_pend);
  END IF;

  INSERT INTO public.attendance_records (session_id, user_id, status)
  VALUES (p_session_id, v_uid, 'presente')
  ON CONFLICT (session_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;

  IF v_filas = 0 THEN
    SELECT status INTO v_previo
      FROM public.attendance_records
     WHERE session_id = p_session_id AND user_id = v_uid;
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', v_previo);
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', 'presente');
END;
$$;

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
  v_previo text;
  v_filas int;
  v_pend jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;
  SELECT * INTO v_session FROM public.attendance_sessions WHERE id = p_session_id;
  IF NOT FOUND OR v_session.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;
  IF public._course_in_papelera(v_session.course_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;

  SELECT status INTO v_previo
    FROM public.attendance_records
   WHERE session_id = p_session_id AND user_id = p_user_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', v_previo);
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

  v_pend := public.attendance_requirements_pending(p_session_id, p_user_id);
  IF jsonb_array_length(v_pend) > 0 THEN
    RETURN public.attendance_requirements_payload(v_pend);
  END IF;

  INSERT INTO public.attendance_records (session_id, user_id, status)
  VALUES (p_session_id, p_user_id, 'presente')
  ON CONFLICT (session_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;

  IF v_filas = 0 THEN
    SELECT status INTO v_previo
      FROM public.attendance_records
     WHERE session_id = p_session_id AND user_id = p_user_id;
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', v_previo);
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', 'presente');
END;
$$;

REVOKE ALL ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) FROM authenticated;

-- ── Se restituyen los dos requisitos que se perdieron ─────────────────────
-- La sesión del 3 de septiembre de Seminario de Sistemas los perdió al reabrirse el
-- check-in. Se reponen leyendo lo que tienen sus HERMANAS del mismo curso, para no
-- clavar ids acá: si el docente los cambió a propósito, la sesión queda igual que
-- las demás de su curso, que es lo esperable.
DO $repone$
DECLARE
  v_ses uuid;
  v_falta int;
BEGIN
  IF to_regclass('public.attendance_session_requirements') IS NULL THEN
    RETURN;
  END IF;

  FOR v_ses IN
    SELECT s.id
      FROM public.attendance_sessions s
     WHERE s.deleted_at IS NULL
       AND s.session_date > current_date - interval '7 days'
       -- Sin requisitos propios…
       AND NOT EXISTS (
         SELECT 1 FROM public.attendance_session_requirements r WHERE r.session_id = s.id)
       -- …pero con hermanas del mismo curso que sí los tienen.
       AND EXISTS (
         SELECT 1
           FROM public.attendance_sessions s2
           JOIN public.attendance_session_requirements r2 ON r2.session_id = s2.id
          WHERE s2.course_id = s.course_id AND s2.id <> s.id)
  LOOP
    INSERT INTO public.attendance_session_requirements (session_id, kind, item_id)
    SELECT DISTINCT v_ses, r2.kind, r2.item_id
      FROM public.attendance_sessions s2
      JOIN public.attendance_session_requirements r2 ON r2.session_id = s2.id
     WHERE s2.course_id = (SELECT course_id FROM public.attendance_sessions WHERE id = v_ses)
       AND s2.id <> v_ses
    ON CONFLICT DO NOTHING;
    RAISE NOTICE 'Requisitos repuestos en la sesion %', v_ses;
  END LOOP;

  SELECT count(*) INTO v_falta
    FROM public.attendance_sessions s
   WHERE s.deleted_at IS NULL
     AND s.session_date > current_date - interval '7 days'
     AND NOT EXISTS (
       SELECT 1 FROM public.attendance_session_requirements r WHERE r.session_id = s.id)
     AND EXISTS (
       SELECT 1 FROM public.attendance_sessions s2
         JOIN public.attendance_session_requirements r2 ON r2.session_id = s2.id
        WHERE s2.course_id = s.course_id AND s2.id <> s.id);
  IF v_falta = 0 THEN
    RAISE NOTICE 'No quedan sesiones recientes sin los requisitos de su curso.';
  ELSE
    RAISE NOTICE 'ATENCION: quedan % sesiones sin requisitos.', v_falta;
  END IF;
END $repone$;

NOTIFY pgrst, 'reload schema';
