-- ══════════════════════════════════════════════════════════════════════════
-- El check-in ABIERTO se puede AJUSTAR, sin cambiar el código proyectado.
--
-- Hasta hoy lo único editable de un check-in en curso eran los botones
-- +5/+10/+15 (`teacher_extend_attendance_check_in`). Para fijar una hora de
-- cierre concreta, cambiar cada cuánto rota el código, el modo solo-correo o
-- los requisitos, había que CERRAR y volver a abrir — y eso tenía un costo que
-- el docente no veía: el `ON CONFLICT … SET seed = EXCLUDED.seed` de esta misma
-- función REGENERA la semilla, así que los seis dígitos proyectados cambiaban
-- de golpe a mitad de clase y quien los había anotado se quedaba con un número
-- muerto, sin ningún aviso.
--
-- ── El discriminador es la VENTANA VIVA, no la existencia de la fila ──────
-- `attendance_check_in_state.seed` es NOT NULL (DDL original, 20260507100000),
-- así que "preservar con un COALESCE" es imposible: nunca caería al valor
-- nuevo. La condición correcta es `closes_at > now()`:
--   · ventana VIVA  ⇒ AJUSTE: la semilla y `opened_at` se preservan.
--   · fila VENCIDA  ⇒ RE-APERTURA: la semilla ROTA, y tiene que rotar. Si no,
--     el código fijo de la ventana de ayer seguiría valiendo hoy y alguien
--     marca presente desde la casa con un número que anotó.
--
-- ── NULL = no tocar, en LOS CUATRO campos ─────────────────────────────────
-- Es la semántica que 20262070000000 ya estableció para `p_requirements`,
-- escrita a costa de un incidente en clase (de 45 sesiones configuradas, la
-- única que perdió sus requisitos fue la única a la que se le abrió el
-- check-in). Extendida a cierre, rotación y solo-correo, un cliente que manda
-- medio formulario deja de poder borrar el resto.
--
-- ── El cuerpo se copia TEXTUAL de 20262120000000 ──────────────────────────
-- Esta función se reescribió 10 veces y una de esas migraciones se llama
-- `20261810000000_attendance_open_pgcrypto_regression.sql`: ya hubo una
-- regresión por partir de una copia vieja. Acá se agregan SOLO: la lectura del
-- estado con FOR UPDATE, la bifurcación de valores efectivos, la base de la
-- normalización, la rama de escritura y dos claves en el retorno. Todo lo demás
-- —los 5 guards de autorización y papelera, la validación de los 5 `kind`, los
-- 3 guards de ventana, el mínimo de 15 s, `requirements_count` y el
-- `SET search_path = public, extensions` que `gen_random_bytes` necesita— es
-- idéntico, carácter por carácter.
--
-- La firma no cambia y el retorno sigue siendo jsonb ⇒ CREATE OR REPLACE.
-- Y `teacher_extend_attendance_check_in` NO se toca: su GREATEST(now(), …) la
-- vuelve incapaz de producir un cierre en el pasado, y su tope es el mismo
-- `opened_at + 365 days`.
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.teacher_open_attendance_check_in(
  p_session_id uuid,
  p_opens_at timestamptz DEFAULT NULL,
  p_closes_at timestamptz DEFAULT NULL,
  -- DEFAULT NULL y no 60/false: el contrato es «NULL = no tocar», y con los
  -- defaults viejos un llamador que OMITIERA el argumento en un ajuste ponía
  -- rotación 60 (cambiando el código) y apagaba el modo solo-correo. La rama de
  -- apertura ya hace COALESCE(…, 60) / COALESCE(…, false), así que no cambia.
  p_rotation_seconds int DEFAULT NULL,
  p_email_only boolean DEFAULT NULL,
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
  -- ── Nuevo: el estado que ya existe, y si esto es un ajuste ──────────────
  v_prev public.attendance_check_in_state%ROWTYPE;
  v_hay_prev boolean;
  v_ajuste boolean := false;
  v_solo_correo boolean;
  v_base_rot timestamptz;
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

  -- ── ¿Ventana VIVA? Entonces esto es un AJUSTE ───────────────────────────
  -- FOR UPDATE no es adorno: el cron `close-expired-attendance-checkins` BORRA
  -- las filas vencidas cada minuto (20261230000000). Sin el candado, entre este
  -- SELECT y el UPDATE de abajo la fila puede desaparecer y el ajuste se
  -- aplicaría a 0 filas, en silencio, dejando al docente creyendo que guardó.
  SELECT * INTO v_prev
    FROM public.attendance_check_in_state
   WHERE session_id = p_session_id
     FOR UPDATE;
  v_hay_prev := FOUND;
  v_ajuste := v_hay_prev AND v_prev.closes_at > now();

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

  IF v_ajuste THEN
    -- `opened_at` NO se mueve. Es el ancla del tope de 365 días (acá y en
    -- extend) y del guard `not_started` que recibe el alumno; moverlo hacia
    -- adelante haría que el servidor rechace a toda la clase mientras el
    -- proyector sigue mostrando un código válido. `p_opens_at` se IGNORA en
    -- este camino, y el retorno trae el `opened_at` real para que la pantalla
    -- lo muestre en vez de suponerlo.
    v_abre        := v_prev.opened_at;
    v_cierra      := COALESCE(p_closes_at, v_prev.closes_at);
    v_rot         := COALESCE(p_rotation_seconds, v_prev.rotation_seconds);
    v_solo_correo := COALESCE(p_email_only, v_prev.email_only);
  ELSE
    -- Camino de APERTURA: idéntico a 20262120000000, expresión por expresión.
    v_abre        := COALESCE(p_opens_at, now());
    v_cierra      := COALESCE(p_closes_at, v_abre + interval '10 minutes');
    v_rot         := COALESCE(p_rotation_seconds, 60);
    v_solo_correo := COALESCE(p_email_only, false);
  END IF;

  -- En el AJUSTE este guard va ANTES de `invalid_range`, y no es cosmético:
  -- `v_abre` es el `opened_at` original, o sea una hora YA PASADA, así que un
  -- cierre en el pasado cae primero en `invalid_range` y el docente lee "el
  -- cierre tiene que ser posterior a la apertura" en un diálogo que NO muestra
  -- campo de apertura — un mensaje sobre un campo que no existe en pantalla.
  -- Una vez que este guard pasa, `invalid_range` es inalcanzable en el ajuste
  -- (`opened_at <= now() < closes_at`), así que el orden no esconde nada. El
  -- camino de APERTURA queda intacto: ahí `v_abre` lo elige el docente y las
  -- dos comprobaciones siguen en el orden de siempre.
  IF v_ajuste AND v_cierra <= now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'closes_in_past');
  END IF;
  IF v_cierra <= v_abre THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_range');
  END IF;
  IF v_cierra > v_abre + interval '365 days' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'range_too_long');
  END IF;
  -- El guard que decide todo en el camino de ajuste: un cierre <= ahora es
  -- IRREVERSIBLE. Tres mecanismos independientes borran la fila —el tick del
  -- proyector, el cron cada minuto y el propio RPC del alumno— y con la fila se
  -- va la SEMILLA. La única salida sería reabrir, o sea exactamente la trampa
  -- que este cambio existe para evitar. Para terminar ahora está
  -- `teacher_close_attendance_check_in`.
  IF v_cierra <= now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'closes_in_past');
  END IF;

  -- ── Rotación: mínimo 15 s, SIN máximo ──────────────────────────────────
  -- El COALESCE de arriba no es adorno: el DEFAULT 60 de la firma solo aplica
  -- si el argumento se OMITE, y un p_rotation_seconds nulo explícito saltaría
  -- el guard (NULL <> 0 → NULL → IF falso) y estallaría con 23502 al escribir
  -- una columna NOT NULL.
  IF v_rot <> 0 AND v_rot < 15 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_rotation');
  END IF;

  -- La ventana contra la que se compara: al AJUSTAR, la que queda POR DELANTE
  -- (el docente decide para lo que resta de la clase). Al ABRIR, la completa —
  -- idéntico a hoy, para no cambiar ni un caso del camino existente.
  v_base_rot := CASE WHEN v_ajuste THEN GREATEST(v_abre, now()) ELSE v_abre END;

  -- Una rotación >= la ventana NO es "un código que casi no cambia": el período
  -- es floor(epoch / rotación) anclado al epoch ABSOLUTO, así que cambia en los
  -- múltiplos de esa rotación y no al abrir. Se normaliza a fijo y se avisa.
  --
  -- Y SOLO se normaliza si la rotación se está EDITANDO (o si es una apertura).
  -- Si se aplicara también al acortar la ventana, acortar cambiaría el código
  -- proyectado como efecto lateral de una edición que no era de rotación — que
  -- es el daño exacto que este cambio existe para no causar.
  --
  -- OJO con el predicado: `IS NOT NULL` NO distingue «la rotación se está
  -- editando» de «el cliente la reenvió igual», y el único llamador manda
  -- siempre un número. Con eso, ACORTAR la ventana normalizaba a código fijo
  -- — y `attendancePeriod(60) ≠ attendancePeriod(0)`, así que los seis dígitos
  -- proyectados cambiaban sin aviso, con la rotación POR DEFECTO y sin que el
  -- docente hubiera tocado la rotación. Se compara contra el valor guardado.
  IF (NOT v_ajuste OR p_rotation_seconds IS DISTINCT FROM v_prev.rotation_seconds)
     AND v_rot <> 0
     AND v_rot >= EXTRACT(EPOCH FROM (v_cierra - v_base_rot)) THEN
    v_rot := 0;
    v_fijado := true;
  END IF;

  -- ── SOLO se toca el set si llegó un arreglo ─────────────────────────────
  -- NULL = no tocar. Sin esta distinción, abrir (o ajustar) el check-in desde
  -- un cliente que no manda el campo borra la configuración del semestre — y así
  -- se perdió la de una sesión real, en clase.
  IF jsonb_typeof(p_requirements) = 'array' THEN
    DELETE FROM public.attendance_session_requirements WHERE session_id = p_session_id;
    INSERT INTO public.attendance_session_requirements (session_id, kind, item_id, created_by)
    SELECT p_session_id, e->>'kind', (e->>'id')::uuid, v_uid
      FROM jsonb_array_elements(p_requirements) e
    ON CONFLICT DO NOTHING;
  END IF;

  IF v_ajuste THEN
    -- `seed` y `opened_at` NO aparecen en este SET. No es un COALESCE que haya
    -- que razonar: es imposible que esta sentencia los toque.
    UPDATE public.attendance_check_in_state
       SET rotation_seconds = v_rot,
           closes_at        = v_cierra,
           email_only       = v_solo_correo
     WHERE session_id = p_session_id;
    v_seed := v_prev.seed;
  ELSE
    v_seed := encode(extensions.gen_random_bytes(16), 'hex');
    INSERT INTO public.attendance_check_in_state
      (session_id, seed, rotation_seconds, opened_at, closes_at, email_only)
    VALUES (p_session_id, v_seed, v_rot, v_abre, v_cierra, v_solo_correo)
    ON CONFLICT (session_id) DO UPDATE
      -- Fila VENCIDA: es una re-apertura, y el código de la ventana anterior
      -- tiene que dejar de valer.
      SET seed             = EXCLUDED.seed,
          rotation_seconds = EXCLUDED.rotation_seconds,
          opened_at        = EXCLUDED.opened_at,
          closes_at        = EXCLUDED.closes_at,
          email_only       = EXCLUDED.email_only;
  END IF;

  -- Se deja tal cual. NO re-notifica al curso: el trigger es
  -- WHEN (NEW.check_in_open IS TRUE AND OLD.check_in_open IS NOT TRUE)
  -- (20260517110000), y en un ajuste ya vale true.
  UPDATE public.attendance_sessions SET check_in_open = true WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'ok', true,
    -- Para que la pantalla sepa si abrió o ajustó: cambia el toast, y la
    -- auditoría deja de contar ajustes como aperturas.
    'adjusted', v_ajuste,
    'seed', v_seed,
    -- El EFECTIVO, no el pedido: el cliente lo usa para calcular el código, y
    -- con el pedido mostraría códigos que el servidor no valida.
    'rotation_seconds', v_rot,
    -- Verdadero cuando la rotación pedida era >= la ventana y se normalizó a
    -- fijo. La pantalla lo dice; normalizar en silencio dejaría al docente
    -- creyendo que su número se ignoró.
    'rotation_fixed_by_window', v_fijado,
    'opened_at', v_abre,
    'closes_at', v_cierra,
    'email_only', v_solo_correo,
    -- Cuántos requisitos quedaron, para que la pantalla pueda confirmarlo en
    -- vez de suponerlo: es la señal que habría delatado el borrado el primer día.
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
