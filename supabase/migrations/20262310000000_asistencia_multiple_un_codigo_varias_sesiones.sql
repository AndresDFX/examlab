-- Un solo enlace y un solo código marcan asistencia en VARIAS sesiones.
--
-- ── El caso real ─────────────────────────────────────────────────────
-- Una clase de tres horas está partida en dos o tres sesiones del sistema
-- (porque así se planificó, o porque el bloque cruza dos franjas del horario).
-- Hoy el docente tiene que abrir el check-in una vez por sesión, proyectar un
-- QR distinto para cada una y pedirle al curso que escanee dos o tres veces. En
-- 21 personas eso son dos o tres rondas de "no me tomó", y el docente termina
-- marcando a mano.
--
-- ── Por qué esto es CHICO: el código ya sale de la semilla ────────────
-- `compute_attendance_code(seed, period)` deriva el número de la SEMILLA. O sea
-- que dos sesiones que comparten semilla ya aceptan el mismo código, sin tocar
-- el cálculo ni el cliente. Lo único que falta es (a) abrirlas juntas con la
-- misma semilla y (b) que marcar una marque las demás.
--
-- ── Por qué un `group_id` explícito y no "misma semilla" ──────────────
-- Deducir el grupo comparando semillas sería un invariante implícito: dos
-- aperturas independientes podrían colisionar (improbable, pero el fallo sería
-- marcar asistencia en la sesión de otra clase), y nada impediría que alguien
-- "arregle" la generación de semillas y rompa el grupo sin enterarse. Con la
-- columna, el grupo es un dato y no una coincidencia.
--
-- ── Dónde NO se toca nada ────────────────────────────────────────────
-- El QR, el enlace `?session=X&code=Y`, `compute_attendance_code`, su espejo en
-- JavaScript y el escáner del alumno quedan IDÉNTICOS. El enlace apunta a UNA
-- sesión (el ancla) y la propagación pasa del lado del servidor. Así el alumno
-- que ya sabe escanear no aprende nada nuevo, y un cliente viejo sigue
-- funcionando.

-- ── 1 · La columna del grupo ─────────────────────────────────────────
-- Defensivo con `to_regclass` (convención del repo): si la tabla no existe en
-- un entorno, la migración no puede abortar el deploy entero.
DO $$
BEGIN
  IF to_regclass('public.attendance_check_in_state') IS NOT NULL THEN
    ALTER TABLE public.attendance_check_in_state
      ADD COLUMN IF NOT EXISTS group_id uuid;
    -- Parcial: la enorme mayoría de las aperturas es de UNA sesión y deja
    -- `group_id` en NULL. Indexar esas filas no aporta nada.
    CREATE INDEX IF NOT EXISTS idx_checkin_state_group
      ON public.attendance_check_in_state (group_id)
      WHERE group_id IS NOT NULL;
  END IF;
END $$;

COMMENT ON COLUMN public.attendance_check_in_state.group_id IS
  'Sesiones que comparten UN código: mismo group_id y misma semilla. NULL = check-in de una sola sesión (el caso normal).';

-- ── 2 · La propagación, en UN solo lugar ─────────────────────────────
-- Vive acá y no copiada en los dos caminos de check-in (el autenticado y el
-- público por correo) porque las reglas de quién puede quedar marcado no pueden
-- diferir entre ellos: si difirieran, el mismo alumno con el mismo código
-- quedaría marcado en dos sesiones por un camino y en una por el otro.
--
-- Cada hermana se valida por su cuenta. NO se asume que compartir grupo alcance:
-- una sesión del grupo puede haber quedado en la papelera, con su ventana
-- cerrada, o con un requisito pendiente propio. Marcarla igual sería inventar
-- asistencia, que es el peor error posible en este módulo.
CREATE OR REPLACE FUNCTION public.attendance_marcar_grupo(
  p_session_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  v_grupo uuid;
  v_hermana record;
  v_marcadas int := 0;
  v_nombres text[] := '{}';
  v_omitidas int := 0;
  v_filas int;
BEGIN
  IF p_session_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('marcadas', 0, 'sesiones', '[]'::jsonb, 'omitidas', 0);
  END IF;

  SELECT group_id INTO v_grupo
    FROM public.attendance_check_in_state
   WHERE session_id = p_session_id;

  -- Sin grupo no hay nada que propagar: es el 99% de los casos y sale por acá
  -- sin tocar ninguna otra tabla.
  IF v_grupo IS NULL THEN
    RETURN jsonb_build_object('marcadas', 0, 'sesiones', '[]'::jsonb, 'omitidas', 0);
  END IF;

  FOR v_hermana IN
    SELECT s.id, s.title, s.session_date, s.course_id
      FROM public.attendance_check_in_state st
      JOIN public.attendance_sessions s ON s.id = st.session_id
     WHERE st.group_id = v_grupo
       AND st.session_id <> p_session_id
       AND s.deleted_at IS NULL
       AND s.check_in_open
       -- `opened_at`, NO `opens_at`: la tabla NO tiene esa columna. `p_opens_at`
       -- es el PARÁMETRO de la RPC de apertura, que se guarda en `opened_at`;
       -- confundirlos hacía que esta función fallara con "column does not
       -- exist" en la primera propagación real.
       AND now() BETWEEN st.opened_at AND st.closes_at
     ORDER BY s.session_date, s.start_time NULLS LAST
  LOOP
    -- La papelera del CURSO: un curso en papelera no habilita nada (regla
    -- universal del repo), y la sesión puede seguir sin `deleted_at` propio.
    CONTINUE WHEN public._course_in_papelera(v_hermana.course_id);

    -- La matrícula se re-verifica por sesión aunque el grupo sea de un solo
    -- curso: el grupo lo armó el docente y la matrícula pudo cambiar después.
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM public.course_enrollments ce
       WHERE ce.course_id = v_hermana.course_id AND ce.user_id = p_user_id
    );

    -- Requisitos PROPIOS de la hermana. La apertura múltiple les pone los
    -- mismos a todas, así que en la práctica satisfacer el ancla las satisface;
    -- pero una sesión pudo quedar con requisitos de una apertura anterior, y
    -- saltearlos sería darle asistencia a quien no cumplió.
    IF jsonb_array_length(public.attendance_requirements_pending(v_hermana.id, p_user_id)) > 0 THEN
      v_omitidas := v_omitidas + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.attendance_records (session_id, user_id, status)
    VALUES (v_hermana.id, p_user_id, 'presente')
    ON CONFLICT (session_id, user_id) DO NOTHING;
    GET DIAGNOSTICS v_filas = ROW_COUNT;
    IF v_filas > 0 THEN
      v_marcadas := v_marcadas + 1;
      v_nombres := v_nombres || COALESCE(NULLIF(v_hermana.title, ''), to_char(v_hermana.session_date, 'DD/MM'));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'marcadas', v_marcadas,
    'sesiones', to_jsonb(v_nombres),
    'omitidas', v_omitidas
  );
END;
$$;

REVOKE ALL ON FUNCTION public.attendance_marcar_grupo(uuid, uuid) FROM PUBLIC;
-- `anon` explícito: el `FROM PUBLIC` NO borra la entrada que Supabase otorga por
-- `ALTER DEFAULT PRIVILEGES` (documentado en CLAUDE.md). Esta función marca
-- asistencia, así que solo la llaman las RPC de check-in, que son SECURITY
-- DEFINER y ya validaron el código.
REVOKE ALL ON FUNCTION public.attendance_marcar_grupo(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.attendance_marcar_grupo(uuid, uuid) FROM authenticated;

-- ── 3 · Abrir el check-in para VARIAS sesiones ───────────────────────
-- RPC aparte y no un argumento más en `teacher_open_attendance_check_in`: esa
-- función ya tiene seis parámetros y dos caminos (apertura y ajuste), y su
-- contrato «NULL = no tocar» está documentado parámetro por parámetro. Meterle
-- un arreglo de sesiones multiplicaría los caminos. Acá se delega en ella una
-- vez por sesión y después se sella el grupo: la lógica de validación, semilla,
-- ventana y requisitos NO se duplica.
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
  v_uid uuid := auth.uid();
  v_ids uuid[];
  v_ancla uuid;
  v_id uuid;
  v_curso uuid;
  v_curso_i uuid;
  v_grupo uuid := gen_random_uuid();
  v_res jsonb;
  v_semilla text;
  v_abiertas int := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;
  IF NOT (public.has_role(v_uid, 'Admin') OR public.has_role(v_uid, 'Docente')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  -- Duplicados fuera y orden estable: el ancla tiene que ser determinista para
  -- que el enlace que el docente copió no cambie entre dos llamadas iguales.
  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(COALESCE(p_session_ids, '{}')) AS x;
  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_sessions');
  END IF;
  IF array_length(v_ids, 1) > 20 THEN
    -- Tope defensivo: un código que cubre media asignatura deja de ser "la
    -- clase de hoy" y se vuelve una forma de regalar asistencia del semestre.
    RETURN jsonb_build_object('ok', false, 'error', 'too_many_sessions');
  END IF;

  -- TODAS del MISMO curso. Un código que cruza cursos es una puerta a marcar
  -- asistencia en una clase a la que el alumno no va: la matrícula se valida
  -- por sesión, pero el docente no debería poder ni construir ese grupo.
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

  -- ── Ninguna hermana puede tener YA un check-in vivo ────────────────────
  -- Es el daño más caro que esta función puede hacer. Si una hermana tiene su
  -- ventana abierta, `teacher_open_attendance_check_in` toma su rama de AJUSTE,
  -- que PRESERVA la semilla a propósito (mig 20262140000000) — y el UPDATE de
  -- más abajo la pisaría con la del ancla, invalidando en silencio el código que
  -- esa clase está mirando en el proyector. Es exactamente lo que
  -- `checkin-preserva-semilla.test.ts` existe para evitar, por una vía que ese
  -- test no mira porque no toca el cuerpo de aquella función.
  --
  -- Se RECHAZA en vez de saltear: saltearla dejaría a esa sesión fuera del grupo
  -- sin que el docente lo pida, o sea un código que cubre menos de lo que él
  -- cree. El ancla SÍ puede estar viva: su semilla es la que el grupo adopta,
  -- así que sus estudiantes conservan el código que ya tienen.
  SELECT s.id INTO v_id
    FROM public.attendance_check_in_state st
    JOIN public.attendance_sessions s ON s.id = st.session_id
   WHERE st.session_id = ANY(v_ids)
     AND st.session_id <> (
       SELECT id FROM public.attendance_sessions
        WHERE id = ANY(v_ids)
        ORDER BY session_date, start_time NULLS LAST, id
        LIMIT 1
     )
     AND st.closes_at > now()
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'session_already_open',
      'session_id', v_id
    );
  END IF;

  -- El ANCLA es la primera por fecha/hora: es la sesión a la que apunta el
  -- enlace y el QR, así que tiene que ser la que el docente reconoce como "la
  -- de ahora", no un uuid al azar.
  SELECT id INTO v_ancla
    FROM public.attendance_sessions
   WHERE id = ANY(v_ids)
   ORDER BY session_date, start_time NULLS LAST, id
   LIMIT 1;

  -- Se abre el ancla PRIMERO y con la RPC existente: de ahí sale la semilla que
  -- van a compartir todas. Si el ancla falla (sin permiso, papelera, requisito
  -- no disponible) se devuelve su error tal cual y no se abre nada más.
  v_res := public.teacher_open_attendance_check_in(
    v_ancla, p_opens_at, p_closes_at, p_rotation_seconds, p_email_only, p_requirements
  );
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN v_res;
  END IF;
  v_abiertas := 1;

  SELECT seed INTO v_semilla
    FROM public.attendance_check_in_state
   WHERE session_id = v_ancla;

  -- El resto: misma ventana y mismos requisitos, y DESPUÉS se les copia la
  -- semilla del ancla. Copiarla es lo que hace que un solo código sirva: cada
  -- apertura genera su propia semilla, así que sin este UPDATE cada sesión
  -- pediría su propio número y el grupo no serviría de nada.
  FOREACH v_id IN ARRAY v_ids
  LOOP
    CONTINUE WHEN v_id = v_ancla;
    v_res := public.teacher_open_attendance_check_in(
      v_id, p_opens_at, p_closes_at, p_rotation_seconds, p_email_only, p_requirements
    );
    IF COALESCE((v_res->>'ok')::boolean, false) IS TRUE THEN
      UPDATE public.attendance_check_in_state
         SET seed = v_semilla
       WHERE session_id = v_id;
      v_abiertas := v_abiertas + 1;
    END IF;
    -- Una hermana que falla NO aborta el grupo: el docente está frente al curso
    -- y es mejor un check-in que cubre 2 de 3 —con el conteo a la vista— que
    -- ninguno. El conteo devuelto es lo que el cliente muestra.
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

-- ── 4 · Cerrar el grupo de una vez ───────────────────────────────────
-- Sin esto, cerrar un check-in múltiple obliga a cerrar sesión por sesión, y el
-- docente que cierra solo el ancla deja las hermanas abiertas con la misma
-- semilla: el código sigue sirviendo y nadie lo ve.
CREATE OR REPLACE FUNCTION public.teacher_close_attendance_check_in_group(
  p_session_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_grupo uuid;
  v_ids uuid[];
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

  SELECT group_id INTO v_grupo
    FROM public.attendance_check_in_state
   WHERE session_id = p_session_id;

  IF v_grupo IS NULL THEN
    v_ids := ARRAY[p_session_id];
  ELSE
    SELECT array_agg(session_id) INTO v_ids
      FROM public.attendance_check_in_state
     WHERE group_id = v_grupo;
  END IF;

  UPDATE public.attendance_sessions SET check_in_open = false WHERE id = ANY(v_ids);
  DELETE FROM public.attendance_check_in_state WHERE session_id = ANY(v_ids);

  RETURN jsonb_build_object('ok', true, 'closed', COALESCE(array_length(v_ids, 1), 0));
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_close_attendance_check_in_group(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_close_attendance_check_in_group(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_close_attendance_check_in_group(uuid) TO authenticated;

-- ── 5 · Los dos caminos de check-in propagan al grupo ────────────────
-- Se re-emiten TAL CUAL están hoy (mig 20262070000000) con tres cambios: la
-- variable `v_grupo`, la llamada a `attendance_marcar_grupo` y el resultado
-- fusionado en la respuesta. El cuerpo NO se retipeó: se extrajo del archivo de
-- esa migración, porque copiar 90 líneas de PL/pgSQL a mano es la forma más
-- fácil de revertir sin querer un arreglo anterior.
--
-- Se propaga en los TRES puntos de salida exitosa, incluido el "ya estabas
-- marcado": si el alumno escaneó, el docente agregó una sesión al grupo y el
-- alumno vuelve a abrir el enlace, tiene que quedar marcado en la nueva. Tener
-- ya un registro en el ancla ES la prueba de presencia; el código no hace falta
-- pedirlo dos veces.

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
  v_grupo jsonb;
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
    v_grupo := public.attendance_marcar_grupo(p_session_id, v_uid);
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', v_previo) || v_grupo;
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
    v_grupo := public.attendance_marcar_grupo(p_session_id, v_uid);
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', v_previo) || v_grupo;
  END IF;
  v_grupo := public.attendance_marcar_grupo(p_session_id, v_uid);
  RETURN jsonb_build_object('ok', true, 'status', 'presente') || v_grupo;
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
  v_grupo jsonb;
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
    v_grupo := public.attendance_marcar_grupo(p_session_id, p_user_id);
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', v_previo) || v_grupo;
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
    v_grupo := public.attendance_marcar_grupo(p_session_id, p_user_id);
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', v_previo) || v_grupo;
  END IF;
  v_grupo := public.attendance_marcar_grupo(p_session_id, p_user_id);
  RETURN jsonb_build_object('ok', true, 'status', 'presente') || v_grupo;
END;
$$;
