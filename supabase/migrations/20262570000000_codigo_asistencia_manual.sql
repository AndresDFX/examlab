-- ----------------------------------------------------------------------
-- Codigo de asistencia ELEGIDO por el docente, en vez de derivado.
--
-- Hasta ahora el codigo salia SIEMPRE de la semilla
-- (`compute_attendance_code(seed, period)`), asi que el docente no podia
-- elegirlo: para dictarlo en clase tenia que leer el que le tocara, y no podia
-- repetir el mismo entre sesiones. Con `manual_code` lo fija el; la semilla
-- queda como respaldo del modo generado.
--
-- -- Lo que hace que esto no rompa nada --------------------------------
--
-- 1. `NULL` = comportamiento ANTERIOR, byte por byte. Ninguna de las filas que
--    hoy existen en produccion cambia: siguen derivando de la semilla.
--
-- 2. La comparacion pasa a estar en UN solo lugar
--    (`attendance_codigo_valido`). Estaba COPIADA, byte-identica, en
--    `student_check_in_attendance` y en `public_check_in_attendance`. Un codigo
--    manual honrado en uno y no en el otro habria funcionado desde el QR y
--    fallado desde el enlace por correo: el alumno cree que marco, no marco, y
--    no tiene como enterarse. Es el mismo motivo por el que
--    `attendance_marcar_grupo` es el unico lugar de la propagacion.
--
-- 3. Seis digitos, no texto libre. El guard de las dos RPC es `^[0-9]{6}$`, el
--    campo del estudiante acepta 6 digitos y el QR codifica `?code=`; un codigo
--    con letras se rechazaria ANTES de compararse — el docente lo veria en el
--    proyector y no funcionaria. Se valida en la columna (CHECK) y al abrir.
--
-- 4. Un codigo manual APAGA la rotacion. Un codigo elegido no puede rotar, asi
--    que dejar `rotation_seconds` en 60 pondria un contador en el proyector que
--    no cambia nada, y el alumno que lo ve llegar a cero cree que su codigo
--    vencio. Al abrir con codigo manual se fuerza 0.
--
-- 5. Las hermanas del grupo lo COPIAN, igual que la semilla. Sin eso el ancla
--    valida contra el codigo elegido y las hermanas contra el derivado: el
--    mismo codigo marcaria una sesion y no las otras, sin error a la vista.
--
-- -- Lo que NO cambia, a proposito -------------------------------------
--
-- Un codigo elegido es mas facil de adivinar y de compartir que uno rotativo.
-- Eso ya era cierto: en produccion los siete cursos abiertos usan
-- `rotation_seconds = 0`, o sea codigo fijo. Los candados que de verdad
-- sostienen la asistencia siguen intactos y no se tocan aca: matricula en el
-- curso, ventana abierta, requisitos pendientes y papelera del curso.
-- ----------------------------------------------------------------------

DO $mig$
BEGIN
  IF to_regclass('public.attendance_check_in_state') IS NOT NULL THEN
    ALTER TABLE public.attendance_check_in_state
      ADD COLUMN IF NOT EXISTS manual_code text;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'chk_attendance_manual_code'
         AND conrelid = 'public.attendance_check_in_state'::regclass
    ) THEN
      ALTER TABLE public.attendance_check_in_state
        ADD CONSTRAINT chk_attendance_manual_code
        CHECK (manual_code IS NULL OR manual_code ~ '^[0-9]{6}$');
    END IF;

    COMMENT ON COLUMN public.attendance_check_in_state.manual_code IS
      'Codigo de 6 digitos elegido por el docente. NULL = se deriva de la semilla.';
  END IF;
END $mig$;

-- -- 1 - La UNICA comparacion de codigo ---------------------------------
CREATE OR REPLACE FUNCTION public.attendance_codigo_valido(
  p_state public.attendance_check_in_state,
  p_code text
) RETURNS boolean
LANGUAGE plpgsql STABLE
SET search_path = public, extensions AS $fn$
DECLARE
  v_period bigint;
BEGIN
  IF p_code IS NULL OR p_code !~ '^[0-9]{6}$' THEN
    RETURN false;
  END IF;

  -- Codigo elegido: se compara SOLO contra el. Aceptar ademas el derivado daria
  -- dos codigos validos a la vez para la misma sesion, y el docente conoce uno:
  -- el otro seria una puerta abierta que no puede cerrar.
  IF p_state.manual_code IS NOT NULL THEN
    RETURN p_code = p_state.manual_code;
  END IF;

  IF COALESCE(p_state.rotation_seconds, 0) <= 0 THEN
    RETURN p_code = public.compute_attendance_code(p_state.seed, 0);
  END IF;

  v_period := public.attendance_code_period(p_state.rotation_seconds);
  RETURN p_code IN (
    public.compute_attendance_code(p_state.seed, v_period),
    public.compute_attendance_code(p_state.seed, v_period - 1),
    public.compute_attendance_code(p_state.seed, v_period + 1)
  );
END;
$fn$;

-- Interna: la llaman las RPC de check-in, que son SECURITY DEFINER. Nadie mas
-- necesita poder preguntarle si un codigo es valido — eso seria un oraculo.
REVOKE ALL ON FUNCTION public.attendance_codigo_valido(public.attendance_check_in_state, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attendance_codigo_valido(public.attendance_check_in_state, text) FROM anon;
REVOKE ALL ON FUNCTION public.attendance_codigo_valido(public.attendance_check_in_state, text) FROM authenticated;

-- -- 2 - Abrir el check-in, ahora aceptando el codigo elegido -----------
-- Esta funcion se reescribio ONCE veces. La version de la que parte esta es la
-- de `20262140000000` (la ULTIMA, la que gana en la base), no la primera que
-- aparece buscando en el repositorio: partir de una vieja revierte arreglos sin
-- que nada falle al aplicar la migracion, y ya paso una vez
-- (`20261810000000_attendance_open_pgcrypto_regression`). Lo fija
-- `checkin-preserva-semilla.test.ts`, que mira la ULTIMA definicion.
-- Las firmas VIEJAS se dropean: con `CREATE OR REPLACE` mas un parametro nuevo
-- quedarian las dos vivas y PostgREST no sabria cual llamar.
DROP FUNCTION IF EXISTS public.teacher_open_attendance_check_in(uuid, timestamptz, timestamptz, int, boolean, jsonb);
DROP FUNCTION IF EXISTS public.teacher_open_attendance_check_in_multi(uuid[], timestamptz, timestamptz, int, boolean, jsonb);

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
  p_requirements jsonb DEFAULT NULL,
  p_manual_code text DEFAULT NULL
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
  v_manual text;
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

  -- -- Codigo ELEGIDO por el docente ------------------------------------
  -- Vacio se trata como "sin codigo elegido": un campo que el docente abrio y
  -- dejo en blanco significa "el de siempre", no "codigo vacio".
  --
  -- Al AJUSTAR se aplica TAL CUAL llega, incluido NULL — o sea que vaciar el
  -- campo vuelve al codigo generado. Es a proposito, y se diferencia de
  -- `p_requirements`, donde NULL significa "no tocar": ahi el dato es una lista
  -- que el cliente puede no haber cargado, y borrarla perdio la configuracion de
  -- un semestre en una clase real. Aca es UN campo que la pantalla siempre
  -- manda, y sin esto el docente no tendria como volver atras. La firma vieja se
  -- DROPEA en esta misma migracion, asi que un cliente viejo falla ruidosamente
  -- al llamar, en vez de borrar el codigo en silencio.
  v_manual := NULLIF(regexp_replace(COALESCE(p_manual_code, ''), '\s+', '', 'g'), '');
  IF v_manual IS NOT NULL AND v_manual !~ '^[0-9]{6}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_manual_code');
  END IF;
  -- Un codigo elegido no puede rotar. Dejar la rotacion encendida pondria un
  -- contador en el proyector que no cambia nada, y el alumno que lo ve llegar a
  -- cero cree que su codigo vencio.
  IF v_manual IS NOT NULL THEN
    v_rot := 0;
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
           email_only       = v_solo_correo,
           manual_code      = v_manual
     WHERE session_id = p_session_id;
    v_seed := v_prev.seed;
  ELSE
    v_seed := encode(extensions.gen_random_bytes(16), 'hex');
    INSERT INTO public.attendance_check_in_state
      (session_id, seed, rotation_seconds, opened_at, closes_at, email_only, manual_code)
    VALUES (p_session_id, v_seed, v_rot, v_abre, v_cierra, v_solo_correo, v_manual)
    ON CONFLICT (session_id) DO UPDATE
      -- Fila VENCIDA: es una re-apertura, y el código de la ventana anterior
      -- tiene que dejar de valer.
      SET seed             = EXCLUDED.seed,
          manual_code      = EXCLUDED.manual_code,
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
    'manual_code', v_manual,
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

CREATE OR REPLACE FUNCTION public.teacher_open_attendance_check_in_multi(
  p_session_ids uuid[],
  p_opens_at timestamptz DEFAULT NULL,
  p_closes_at timestamptz DEFAULT NULL,
  p_rotation_seconds int DEFAULT NULL,
  p_email_only boolean DEFAULT NULL,
  p_requirements jsonb DEFAULT NULL,
  p_manual_code text DEFAULT NULL
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
  v_manual text;
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
    v_ancla, p_opens_at, p_closes_at, p_rotation_seconds, p_email_only, p_requirements,
    p_manual_code
  );
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN v_res;
  END IF;
  v_abiertas := 1;

  SELECT seed, manual_code INTO v_semilla, v_manual
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
      v_id, p_opens_at, p_closes_at, p_rotation_seconds, p_email_only, p_requirements,
      p_manual_code
    );
    IF COALESCE((v_res->>'ok')::boolean, false) IS TRUE THEN
      -- La semilla Y el codigo elegido. Copiar solo la semilla dejaria a las
      -- hermanas validando contra el derivado: el mismo codigo marcaria el
      -- ancla y no las demas, sin ningun error a la vista.
      UPDATE public.attendance_check_in_state
         SET seed = v_semilla, manual_code = v_manual
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

-- -- 3 - Los dos caminos de check-in, con UNA comparacion ---------

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
  v_normalized text;
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

  -- UNA sola comparacion, compartida por los dos caminos de check-in. Antes este
  -- bloque estaba copiado aca y en el otro, byte por byte.
  IF NOT public.attendance_codigo_valido(v_state, v_normalized) THEN
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
  v_normalized text;
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

  -- UNA sola comparacion, compartida por los dos caminos de check-in. Antes este
  -- bloque estaba copiado aca y en el otro, byte por byte.
  IF NOT public.attendance_codigo_valido(v_state, v_normalized) THEN
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

REVOKE ALL ON FUNCTION public.teacher_open_attendance_check_in(uuid, timestamptz, timestamptz, int, boolean, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_open_attendance_check_in(uuid, timestamptz, timestamptz, int, boolean, jsonb, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_open_attendance_check_in(uuid, timestamptz, timestamptz, int, boolean, jsonb, text) TO authenticated;

REVOKE ALL ON FUNCTION public.teacher_open_attendance_check_in_multi(uuid[], timestamptz, timestamptz, int, boolean, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_open_attendance_check_in_multi(uuid[], timestamptz, timestamptz, int, boolean, jsonb, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_open_attendance_check_in_multi(uuid[], timestamptz, timestamptz, int, boolean, jsonb, text) TO authenticated;
