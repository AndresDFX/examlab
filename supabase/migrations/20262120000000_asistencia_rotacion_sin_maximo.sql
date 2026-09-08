-- ══════════════════════════════════════════════════════════════════════════
-- La ROTACIÓN del código de asistencia deja de tener máximo.
--
-- El tope era 86400 s = exactamente un día, y molestaba: la VENTANA ya admite
-- hasta 365 días (`range_too_long`), así que un check-in de una semana no podía
-- tener una rotación acorde y había que dejarlo en fijo a mano.
--
-- Queda solo el mínimo de 15 s. `0` sigue siendo la forma EXPLÍCITA de pedir
-- código fijo.
--
-- ── Y una normalización, porque "casi no rota" no existe ──────────────────
-- Una rotación >= la ventana NO es "un código que casi no cambia": el período es
-- `floor(epoch / rotación)` anclado al epoch ABSOLUTO, así que el código cambia en
-- los múltiplos de esa rotación y no al abrir — con rotación de un día cambia a la
-- medianoche UTC, o sea 19:00 en Bogotá, en mitad de una clase nocturna. Con 30
-- días la frontera cae en un instante del calendario que el docente no puede
-- prever, y el proyector queda mostrando una barra que avanza 1% cada 7,2 horas al
-- lado de "Cambia en 720 horas".
--
-- Entonces el servidor la normaliza a `0` (fijo), que es lo que el docente pidió de
-- verdad, y lo AVISA en la respuesta (`rotation_fixed_by_window`): normalizar en
-- silencio dejaría al docente creyendo que su número se ignoró.
--
-- Techo real: la columna y el parámetro son `int` (int4) ⇒ ~68 años. Migrar a
-- `bigint` arrastraría `attendance_code_period(int)` y no vale la pena.
--
-- ── El cuerpo se copia TEXTUAL de 20262070000000 ──────────────────────────
-- Esta función se reescribió 10 veces y una de esas migraciones se llama
-- `20261810000000_attendance_open_pgcrypto_regression.sql`: ya hubo una regresión
-- por partir de una copia vieja. Acá se cambia SOLO el guard de la rotación, el
-- valor que se persiste y el retorno. Todo lo demás —`NULL` = no tocar los
-- requisitos, la validación de los 5 `kind`, `email_only`, `opens_at/closes_at`, el
-- guard de papelera, `requirements_count` y el `SET search_path = public,
-- extensions` que `gen_random_bytes` necesita— es idéntico.
--
-- La firma no cambia y el retorno sigue siendo `jsonb` ⇒ `CREATE OR REPLACE` basta.
-- `attendance_check_in_state.rotation_seconds` no tiene CHECK (verificado en el DDL
-- original y en todas las migraciones posteriores), así que no hay ALTER TABLE.
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
  v_rot int;
  v_fijado boolean := false;
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
  -- ── Rotación: mínimo 15 s, SIN máximo ──────────────────────────────────
  -- `0` = código FIJO toda la ventana (sigue siendo la forma explícita de pedirlo).
  -- El tope de 86400 se quitó a pedido del docente: hay ventanas de varios días.
  --
  -- El `COALESCE` no es adorno: el `DEFAULT 60` de la firma solo aplica si el
  -- argumento se OMITE, y un `p_rotation_seconds: null` explícito salta el guard
  -- (`NULL <> 0` → NULL → IF falso) y estalla con 23502 al insertar en una columna
  -- NOT NULL.
  v_rot := COALESCE(p_rotation_seconds, 60);
  IF v_rot <> 0 AND v_rot < 15 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_rotation');
  END IF;

  -- Una rotación >= la ventana NO es lo mismo que dejarla correr: el período es
  -- `floor(epoch / rotación)`, anclado al epoch ABSOLUTO, así que el código cambia
  -- en los múltiplos de esa rotación y no al abrir — con rotación de un día cambia
  -- a la medianoche UTC (19:00 en Bogotá), en mitad de la clase. Se normaliza al
  -- modo fijo, que es lo que el docente pidió de verdad y lo único que el proyector
  -- puede mostrar sin mentir (barra congelada + "Cambia en 720 horas").
  -- Se avisa en la respuesta: `rotation_fixed_by_window`.
  IF v_rot <> 0 AND v_rot >= EXTRACT(EPOCH FROM (v_cierra - v_abre)) THEN
    v_rot := 0;
    v_fijado := true;
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
  VALUES (p_session_id, v_seed, v_rot, v_abre, v_cierra, coalesce(p_email_only, false))
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
    -- El EFECTIVO, no el pedido: el cliente lo usa para calcular el código en el
    -- proyector, y con el pedido mostraría códigos que el servidor no valida.
    'rotation_seconds', v_rot,
    -- Verdadero cuando la rotación pedida era >= la ventana y se normalizó a fijo.
    -- La pantalla lo dice; normalizar en silencio dejaría al docente creyendo que
    -- su número se ignoró.
    'rotation_fixed_by_window', v_fijado,
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

NOTIFY pgrst, 'reload schema';
