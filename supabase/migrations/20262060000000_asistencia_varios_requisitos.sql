-- ══════════════════════════════════════════════════════════════════════════
-- VARIOS requisitos por sesión, y uno nuevo: haber FIRMADO un documento.
--
-- La versión anterior (20262050000000) guardaba UN requisito en dos columnas de
-- `attendance_sessions`. El pedido concreto es exigir dos a la vez: la encuesta de
-- bienestar Y la firma del Acuerdo Pedagógico. Dos columnas no dan para eso.
--
-- ── Se MIGRAN los datos y se BORRAN las columnas ──────────────────────────
-- No se dejan como "legacy": dos fuentes de verdad para lo mismo es cómo se
-- termina con un requisito que la interfaz muestra y el marcado no exige, o al
-- revés. Las columnas se crearon hoy y solo las escribió esta misma tanda de
-- cambios, así que migrar y dropear es seguro — y las 45 filas que ya tienen
-- requisito se conservan.
--
-- ── El requisito nuevo: `report_signature` ────────────────────────────────
-- El ítem es un `generated_reports.id`, y "cumplido" es tener la firma PUESTA
-- (`report_signatures.signed_at IS NOT NULL`). No alcanza con que exista la
-- solicitud: pedirle la firma a alguien no es que la haya dado.
--
-- Y como cada curso tiene SU propio documento generado, el requisito es por sesión
-- —que ya es por curso—, así que no hace falta nada más para que cada grupo firme
-- el suyo.
--
-- ── Lo que NO cambia, porque es lo que evita el daño ──────────────────────
-- Sigue fallando ABIERTO: un ítem que ya no se puede completar deja de exigirse. Y
-- con varios requisitos eso importa MÁS, no menos: dos condiciones son dos formas
-- de quedarse sin asistencia. Se evalúan todas y se devuelven TODAS las pendientes,
-- para que el estudiante sepa de una qué le falta en vez de descubrirlo de a una.
-- ══════════════════════════════════════════════════════════════════════════

DO $tabla$
BEGIN
  IF to_regclass('public.attendance_sessions') IS NULL THEN
    RAISE NOTICE 'Sin attendance_sessions: nada que hacer.';
    RETURN;
  END IF;

  CREATE TABLE IF NOT EXISTS public.attendance_session_requirements (
    session_id uuid NOT NULL REFERENCES public.attendance_sessions(id) ON DELETE CASCADE,
    kind text NOT NULL,
    item_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    -- La PK evita el mismo requisito dos veces en la misma sesión, que se vería
    -- como un aviso duplicado al estudiante.
    PRIMARY KEY (session_id, kind, item_id)
  );

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_asr_kind') THEN
    ALTER TABLE public.attendance_session_requirements
      ADD CONSTRAINT chk_asr_kind CHECK (
        kind IN ('poll', 'workshop', 'project', 'exam', 'report_signature')
      );
  END IF;

  CREATE INDEX IF NOT EXISTS idx_asr_session
    ON public.attendance_session_requirements(session_id);

  ALTER TABLE public.attendance_session_requirements ENABLE ROW LEVEL SECURITY;

  -- SELECT: espeja la policy de `attendance_sessions` (20261065000000) — staff del
  -- tenant, o el estudiante MATRICULADO en el curso de la sesión. El estudiante lo
  -- necesita para ver qué le falta ANTES de intentar marcarse.
  DROP POLICY IF EXISTS asr_select ON public.attendance_session_requirements;
  CREATE POLICY asr_select ON public.attendance_session_requirements
    FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM public.attendance_sessions s
         WHERE s.id = attendance_session_requirements.session_id
           AND public.course_in_my_tenant(s.course_id)
           AND (
             public.has_role(auth.uid(), 'Docente')
             OR public.has_role(auth.uid(), 'Admin')
             OR public.is_super_admin()
             OR EXISTS (
               SELECT 1 FROM public.course_enrollments ce
                WHERE ce.course_id = s.course_id AND ce.user_id = auth.uid()
             )
           )
      )
    );

  -- WRITE: solo quien DICTA el curso de la sesión, o el Admin de su institución.
  -- Una rama `has_role('Docente')` suelta sería un leak cross-tenant: los roles son
  -- globales, así que un docente de otra institución la pasaría.
  DROP POLICY IF EXISTS asr_write ON public.attendance_session_requirements;
  CREATE POLICY asr_write ON public.attendance_session_requirements
    FOR ALL USING (
      EXISTS (
        SELECT 1 FROM public.attendance_sessions s
         WHERE s.id = attendance_session_requirements.session_id
           AND (
             EXISTS (SELECT 1 FROM public.course_teachers ct
                      WHERE ct.course_id = s.course_id AND ct.user_id = auth.uid())
             OR public.is_admin_of_course_tenant(s.course_id)
           )
      )
    ) WITH CHECK (
      EXISTS (
        SELECT 1 FROM public.attendance_sessions s
         WHERE s.id = attendance_session_requirements.session_id
           AND (
             EXISTS (SELECT 1 FROM public.course_teachers ct
                      WHERE ct.course_id = s.course_id AND ct.user_id = auth.uid())
             OR public.is_admin_of_course_tenant(s.course_id)
           )
      )
    );

  -- ── Migración de los datos de las dos columnas ─────────────────────────
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'attendance_sessions'
       AND column_name = 'requirement_kind'
  ) THEN
    INSERT INTO public.attendance_session_requirements (session_id, kind, item_id)
    SELECT s.id, s.requirement_kind, s.requirement_id
      FROM public.attendance_sessions s
     WHERE s.requirement_kind IS NOT NULL AND s.requirement_id IS NOT NULL
    ON CONFLICT DO NOTHING;

    RAISE NOTICE 'Requisitos migrados a la tabla: %',
      (SELECT count(*) FROM public.attendance_session_requirements);

    ALTER TABLE public.attendance_sessions
      DROP CONSTRAINT IF EXISTS chk_attendance_requirement_pair,
      DROP CONSTRAINT IF EXISTS chk_attendance_requirement_kind;
    ALTER TABLE public.attendance_sessions
      DROP COLUMN IF EXISTS requirement_kind,
      DROP COLUMN IF EXISTS requirement_id;
  END IF;
END $tabla$;

-- ── El ítem sigue disponible (ahora también para la firma) ────────────────
CREATE OR REPLACE FUNCTION public.attendance_requirement_available(
  _kind text,
  _id uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF _kind IS NULL OR _id IS NULL THEN
    RETURN false;
  END IF;

  IF _kind = 'poll' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.polls p
       WHERE p.id = _id
         AND p.deleted_at IS NULL
         AND p.is_published
         AND p.poll_type <> 'kahoot'
         AND (p.closes_at IS NULL OR p.closes_at > now())
    );
  ELSIF _kind = 'workshop' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.workshops w
       WHERE w.id = _id AND w.deleted_at IS NULL AND w.status = 'published'
    );
  ELSIF _kind = 'project' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.projects pr
       WHERE pr.id = _id AND pr.deleted_at IS NULL AND pr.status = 'published'
    );
  ELSIF _kind = 'exam' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.exams e
       WHERE e.id = _id AND e.deleted_at IS NULL AND e.status = 'published'
    );
  ELSIF _kind = 'report_signature' THEN
    -- El informe tiene que existir Y tener al menos UNA solicitud de firma: sin
    -- solicitudes nadie puede firmar, así que exigirlo sería un bloqueo sin salida.
    RETURN EXISTS (SELECT 1 FROM public.generated_reports gr WHERE gr.id = _id)
       AND EXISTS (SELECT 1 FROM public.report_signatures rs WHERE rs.report_id = _id);
  END IF;
  RETURN false;
END;
$$;

-- ── ¿Este estudiante cumplió ESTE requisito? ──────────────────────────────
CREATE OR REPLACE FUNCTION public.attendance_requirement_met(
  _kind text,
  _id uuid,
  _uid uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF _kind IS NULL OR _id IS NULL THEN
    RETURN true;
  END IF;
  IF NOT public.attendance_requirement_available(_kind, _id) THEN
    RETURN true;
  END IF;

  IF _kind = 'poll' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.poll_question_responses r
       WHERE r.poll_id = _id AND r.user_id = _uid
    ) OR EXISTS (
      SELECT 1 FROM public.poll_responses pr
       WHERE pr.poll_id = _id AND pr.user_id = _uid
    );
  ELSIF _kind = 'workshop' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.workshop_submissions s
       WHERE s.workshop_id = _id
         AND s.submitted_at IS NOT NULL
         AND (
           s.user_id = _uid
           OR (s.group_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.workshop_group_members m
                 WHERE m.group_id = s.group_id AND m.user_id = _uid))
         )
    );
  ELSIF _kind = 'project' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.project_submissions s
       WHERE s.project_id = _id
         AND s.submitted_at IS NOT NULL
         AND (
           s.user_id = _uid
           OR (s.group_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.project_group_members m
                 WHERE m.group_id = s.group_id AND m.user_id = _uid))
         )
    );
  ELSIF _kind = 'exam' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.submissions s
       WHERE s.exam_id = _id AND s.user_id = _uid AND s.submitted_at IS NOT NULL
    );
  ELSIF _kind = 'report_signature' THEN
    -- FIRMADO, no "se le pidió": `signed_at` es lo que distingue una firma puesta
    -- de una solicitud abierta.
    RETURN EXISTS (
      SELECT 1 FROM public.report_signatures rs
       WHERE rs.report_id = _id AND rs.user_id = _uid AND rs.signed_at IS NOT NULL
    );
  END IF;
  RETURN true;
END;
$$;

-- ── Qué mostrarle: título y enlace, ahora también del documento ───────────
CREATE OR REPLACE FUNCTION public.attendance_requirement_info(
  _kind text,
  _id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_titulo text;
  v_token text;
BEGIN
  IF _kind IS NULL OR _id IS NULL THEN
    RETURN NULL;
  END IF;

  IF _kind = 'poll' THEN
    SELECT p.title, CASE WHEN p.public_enabled THEN p.public_token ELSE NULL END
      INTO v_titulo, v_token
      FROM public.polls p WHERE p.id = _id;
  ELSIF _kind = 'workshop' THEN
    SELECT w.title INTO v_titulo FROM public.workshops w WHERE w.id = _id;
  ELSIF _kind = 'project' THEN
    SELECT pr.title INTO v_titulo FROM public.projects pr WHERE pr.id = _id;
  ELSIF _kind = 'exam' THEN
    SELECT e.title INTO v_titulo FROM public.exams e WHERE e.id = _id;
  ELSIF _kind = 'report_signature' THEN
    SELECT gr.template_name,
           CASE WHEN gr.public_enabled THEN gr.public_token ELSE NULL END
      INTO v_titulo, v_token
      FROM public.generated_reports gr WHERE gr.id = _id;
  END IF;

  RETURN jsonb_build_object(
    'kind', _kind,
    'id', _id,
    'title', COALESCE(v_titulo, ''),
    'public_token', v_token
  );
END;
$$;

-- ── TODAS las pendientes de una sesión, para esta persona ─────────────────
-- Devuelve un arreglo (vacío = nada pendiente). Se devuelven todas y no la
-- primera: con dos requisitos, informar de a uno obliga al estudiante a resolver,
-- reintentar, y descubrir el segundo — en clase, con el profesor esperando.
CREATE OR REPLACE FUNCTION public.attendance_requirements_pending(
  _session_id uuid,
  _uid uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v jsonb := '[]'::jsonb;
  f record;
BEGIN
  FOR f IN
    SELECT r.kind, r.item_id
      FROM public.attendance_session_requirements r
     WHERE r.session_id = _session_id
     ORDER BY r.created_at, r.kind
  LOOP
    IF NOT public.attendance_requirement_met(f.kind, f.item_id, _uid) THEN
      v := v || jsonb_build_array(public.attendance_requirement_info(f.kind, f.item_id));
    END IF;
  END LOOP;
  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION public.attendance_requirements_pending(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attendance_requirements_pending(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.attendance_requirements_pending(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ══════════════════════════════════════════════════════════════════════════
-- Abrir el check-in con VARIOS requisitos.
--
-- `p_requirements` es un arreglo JSON de `{kind, id}`. Reemplaza a los dos
-- parámetros sueltos de 20262050000000: con N requisitos, dos escalares no dan, y
-- dos arreglos paralelos (kinds[] + ids[]) se pueden desalinear.
--
-- Se ESCRIBE lo que llega: un arreglo vacío o NULL borra los requisitos. Es
-- predecible y obliga a que el diálogo los pre-cargue, que es lo que el docente
-- espera al reabrir un check-in que ya tenía requisitos.
--
-- DROP de la firma de 7 argumentos: sin eso quedan dos funciones con el mismo
-- nombre y PostgREST no puede resolver la llamada (PGRST203).
-- ══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.teacher_open_attendance_check_in(uuid, timestamptz, timestamptz, int, boolean, text, uuid);

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

  -- ── Validación de CADA requisito, antes de tocar nada ───────────────────
  -- Se valida todo primero y se escribe después: aceptar tres y rechazar el cuarto
  -- dejaría la sesión a medio configurar sin que el docente lo sepa.
  IF p_requirements IS NOT NULL AND jsonb_typeof(p_requirements) = 'array' THEN
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

      -- Que el ítem sea DE ESTE CURSO. Talleres y proyectos son M:N: el vínculo
      -- real está en su tabla puente y `course_id` es solo el ancla.
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

  -- Reemplazo completo del set de requisitos.
  DELETE FROM public.attendance_session_requirements WHERE session_id = p_session_id;
  IF p_requirements IS NOT NULL AND jsonb_typeof(p_requirements) = 'array' THEN
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
    'email_only', coalesce(p_email_only, false)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_open_attendance_check_in(uuid, timestamptz, timestamptz, int, boolean, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_open_attendance_check_in(uuid, timestamptz, timestamptz, int, boolean, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_open_attendance_check_in(uuid, timestamptz, timestamptz, int, boolean, jsonb) TO authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- Y los DOS caminos de marcado, evaluando TODAS las pendientes.
--
-- Sigue habiendo tres formas de marcar: la app, la página pública por user_id, y la
-- pública por correo (que delega en la anterior). Se parchean las dos primeras.
--
-- El campo de respuesta pasa de `requirement` (uno) a `requirements` (arreglo). Se
-- devuelven TODAS las pendientes: con dos condiciones, informar de a una obliga al
-- estudiante a resolver, reintentar y descubrir la segunda — en clase, de pie.
-- ══════════════════════════════════════════════════════════════════════════

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

  -- ANTES de mirar el código: si ya está marcado, la respuesta no depende de que el
  -- código siga vigente. Y a quien ya tiene su asistencia puesta no se le quita por
  -- un requisito agregado después.
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

  -- Los requisitos, el ÚLTIMO guard. Después del código porque el código es la
  -- prueba de presencia: chequearlos antes convertiría esta función en un oráculo
  -- donde cualquier matriculado, sin código, averigua qué pide cada sesión.
  v_pend := public.attendance_requirements_pending(p_session_id, v_uid);
  IF jsonb_array_length(v_pend) > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'requirement_pending',
      'requirements', v_pend
    );
  END IF;

  -- DO NOTHING, no DO UPDATE: si otra pestaña insertó entre el SELECT de arriba y
  -- esta línea, no se pisa nada y se responde "ya estaba".
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
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'requirement_pending',
      'requirements', v_pend
    );
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

-- Solo el edge (service_role) la llama, igual que antes de este cambio.
REVOKE ALL ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.public_check_in_attendance(uuid, uuid, text) FROM authenticated;

NOTIFY pgrst, 'reload schema';
