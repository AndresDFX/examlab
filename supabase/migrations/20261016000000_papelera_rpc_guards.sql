-- ══════════════════════════════════════════════════════════════════════
-- Auditoría papelera — guards server-side en RPCs SECURITY DEFINER.
--
-- REGLA UNIVERSAL (CLAUDE.md): una entidad en la papelera (deleted_at NOT NULL)
-- NO debe ser visualizable NI USABLE en NINGÚN flujo/rol. Para RPCs SECURITY
-- DEFINER la regla exige guard `deleted_at IS NULL` SERVER-SIDE — no confiar en
-- que el chooser del cliente ya filtró (un id stale o una llamada directa a la
-- API bypassaría el filtro UI).
--
-- 5 RPCs resolvían/usaban una entacidad soft-deletable por id SIN guard:
--   1-3. clone_exam / clone_workshop / clone_project  → clonaban un origen en
--        papelera (la auth pasa porque el row trashed sigue existiendo).
--   4.   teacher_open_attendance_check_in             → (re)abría check-in sobre
--        una sesión en papelera.
--   5.   update_session_whiteboard_scene              → escribía la pizarra de
--        una sesión en papelera.
--
-- Cada función se recrea VERBATIM (vía pg_get_functiondef del prod) + el guard
-- inyectado, para no driftar el resto del cuerpo (flags parametrizables, auth,
-- tenant scoping de 20260995000000). Idempotente (CREATE OR REPLACE).
--
-- BUG ADICIONAL detectado durante la auditoría (no es de papelera, pero se
-- arregla aquí porque ya recreamos estas funciones): clone_workshop y
-- clone_project NO insertaban `created_by`, pero workshops.created_by y
-- projects.created_by son NOT NULL sin default ni trigger → "Duplicar taller" y
-- "Duplicar proyecto" SIEMPRE fallaban con "null value in column created_by ...".
-- clone_exam sí lo seteaba (auth.uid()). Se añade `created_by = auth.uid()` a
-- las dos INSERT para igualar a clone_exam. Verificado: con el fix el happy-path
-- crea la copia OK; sin él, viola el NOT NULL.
-- ══════════════════════════════════════════════════════════════════════

-- ── 1) clone_exam ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.clone_exam(_source_id uuid, _target_course_id uuid, _new_title text DEFAULT NULL::text, _new_start_time timestamp with time zone DEFAULT NULL::timestamp with time zone, _new_end_time timestamp with time zone DEFAULT NULL::timestamp with time zone, _copy_questions boolean DEFAULT true, _copy_proctoring boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _new_id UUID;
  _final_title TEXT;
  _final_start TIMESTAMPTZ;
  _final_end TIMESTAMPTZ;
BEGIN
  IF NOT (
    (
      public.is_admin_of_course_tenant((SELECT e.course_id FROM public.exams e WHERE e.id = _source_id))
      AND public.is_admin_of_course_tenant(_target_course_id)
    )
    OR (
      EXISTS (
        SELECT 1 FROM public.exams e
        JOIN public.course_teachers ct ON ct.course_id = e.course_id
        WHERE e.id = _source_id AND ct.user_id = auth.uid()
      )
      AND EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = _target_course_id AND ct.user_id = auth.uid()
      )
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para clonar este examen al curso destino';
  END IF;

  -- Papelera: no se puede clonar un examen origen en la papelera (defensa
  -- server-side; el chooser del cliente ya filtra deleted_at, esto cubre ids
  -- stale / llamadas directas a la API).
  IF (SELECT e.deleted_at FROM public.exams e WHERE e.id = _source_id) IS NOT NULL THEN
    RAISE EXCEPTION 'No se puede clonar: el examen origen está en la papelera';
  END IF;

  SELECT
    COALESCE(_new_title, 'Copia de ' || e.title),
    COALESCE(_new_start_time, e.start_time),
    COALESCE(_new_end_time, e.end_time)
    INTO _final_title, _final_start, _final_end
    FROM public.exams e WHERE e.id = _source_id;

  INSERT INTO public.exams (
    course_id, created_by, title, description, time_limit_minutes, navigation_type,
    shuffle_enabled, start_time, end_time, status, max_warnings,
    weight, max_attempts, retry_mode, is_external, schedule_type,
    cut_id
  )
  SELECT
    _target_course_id, auth.uid(), _final_title, e.description, e.time_limit_minutes,
    CASE WHEN _copy_proctoring THEN e.navigation_type ELSE 'libre' END,
    CASE WHEN _copy_proctoring THEN e.shuffle_enabled ELSE false END,
    _final_start, _final_end, 'draft',
    CASE WHEN _copy_proctoring THEN e.max_warnings ELSE 3 END,
    e.weight, e.max_attempts, e.retry_mode, e.is_external, e.schedule_type,
    CASE WHEN _target_course_id = e.course_id THEN e.cut_id ELSE NULL END
  FROM public.exams e WHERE e.id = _source_id
  RETURNING id INTO _new_id;

  IF _copy_questions THEN
    INSERT INTO public.questions (
      exam_id, type, content, options, expected_rubric, language, starter_code,
      points, position
    )
    SELECT
      _new_id, q.type, q.content, q.options, q.expected_rubric, q.language, q.starter_code,
      q.points, q.position
    FROM public.questions q
    WHERE q.exam_id = _source_id;
  END IF;

  RETURN _new_id;
END
$function$;

-- ── 2) clone_workshop ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.clone_workshop(_source_id uuid, _target_course_id uuid, _new_title text DEFAULT NULL::text, _new_start_date timestamp with time zone DEFAULT NULL::timestamp with time zone, _new_due_date timestamp with time zone DEFAULT NULL::timestamp with time zone, _copy_questions boolean DEFAULT true, _copy_groups boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _new_id UUID;
  _final_title TEXT;
BEGIN
  IF NOT (
    (
      public.is_admin_of_course_tenant((SELECT w.course_id FROM public.workshops w WHERE w.id = _source_id))
      AND public.is_admin_of_course_tenant(_target_course_id)
    )
    OR (
      EXISTS (
        SELECT 1 FROM public.workshops w
        JOIN public.course_teachers ct ON ct.course_id = w.course_id
        WHERE w.id = _source_id AND ct.user_id = auth.uid()
      )
      AND EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = _target_course_id AND ct.user_id = auth.uid()
      )
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para clonar este taller al curso destino';
  END IF;

  -- Papelera: no se puede clonar un taller origen en la papelera.
  IF (SELECT w.deleted_at FROM public.workshops w WHERE w.id = _source_id) IS NOT NULL THEN
    RAISE EXCEPTION 'No se puede clonar: el taller origen está en la papelera';
  END IF;

  SELECT COALESCE(_new_title, 'Copia de ' || w.title)
    INTO _final_title
    FROM public.workshops w WHERE w.id = _source_id;

  INSERT INTO public.workshops (
    course_id, created_by, title, description, instructions, start_date, due_date,
    status, weight, is_external, group_mode, group_size_min, group_size_max,
    max_score, cut_id
  )
  SELECT
    _target_course_id, auth.uid(), _final_title, w.description, w.instructions,
    COALESCE(_new_start_date, w.start_date),
    COALESCE(_new_due_date, w.due_date),
    'draft', w.weight, w.is_external,
    CASE WHEN _copy_groups THEN w.group_mode ELSE 'individual' END,
    CASE WHEN _copy_groups THEN w.group_size_min ELSE NULL END,
    CASE WHEN _copy_groups THEN w.group_size_max ELSE NULL END,
    w.max_score,
    CASE WHEN _target_course_id = w.course_id THEN w.cut_id ELSE NULL END
  FROM public.workshops w WHERE w.id = _source_id
  RETURNING id INTO _new_id;

  IF _copy_questions THEN
    INSERT INTO public.workshop_questions (
      workshop_id, type, content, options, expected_rubric, language, starter_code,
      points, position
    )
    SELECT
      _new_id, q.type, q.content, q.options, q.expected_rubric, q.language, q.starter_code,
      q.points, q.position
    FROM public.workshop_questions q
    WHERE q.workshop_id = _source_id;
  END IF;

  RETURN _new_id;
END
$function$;

-- ── 3) clone_project ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.clone_project(_source_id uuid, _target_course_id uuid, _new_title text DEFAULT NULL::text, _new_start_date timestamp with time zone DEFAULT NULL::timestamp with time zone, _new_due_date timestamp with time zone DEFAULT NULL::timestamp with time zone, _copy_files boolean DEFAULT true, _copy_groups boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _new_id UUID;
  _final_title TEXT;
BEGIN
  IF NOT (
    (
      public.is_admin_of_course_tenant((SELECT p.course_id FROM public.projects p WHERE p.id = _source_id))
      AND public.is_admin_of_course_tenant(_target_course_id)
    )
    OR (
      EXISTS (
        SELECT 1 FROM public.projects p
        JOIN public.course_teachers ct ON ct.course_id = p.course_id
        WHERE p.id = _source_id AND ct.user_id = auth.uid()
      )
      AND EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = _target_course_id AND ct.user_id = auth.uid()
      )
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para clonar este proyecto al curso destino';
  END IF;

  -- Papelera: no se puede clonar un proyecto origen en la papelera.
  IF (SELECT p.deleted_at FROM public.projects p WHERE p.id = _source_id) IS NOT NULL THEN
    RAISE EXCEPTION 'No se puede clonar: el proyecto origen está en la papelera';
  END IF;

  SELECT COALESCE(_new_title, 'Copia de ' || p.title)
    INTO _final_title
    FROM public.projects p WHERE p.id = _source_id;

  INSERT INTO public.projects (
    course_id, created_by, title, description, instructions, external_link,
    start_date, due_date, status, max_score, weight, is_external,
    group_mode, group_size_min, group_size_max
  )
  SELECT
    _target_course_id, auth.uid(), _final_title, p.description, p.instructions, p.external_link,
    COALESCE(_new_start_date, p.start_date),
    COALESCE(_new_due_date, p.due_date),
    'draft', p.max_score, p.weight, p.is_external,
    CASE WHEN _copy_groups THEN p.group_mode ELSE 'individual' END,
    CASE WHEN _copy_groups THEN p.group_size_min ELSE NULL END,
    CASE WHEN _copy_groups THEN p.group_size_max ELSE NULL END
  FROM public.projects p WHERE p.id = _source_id
  RETURNING id INTO _new_id;

  IF _copy_files THEN
    INSERT INTO public.project_files (
      project_id, type, title, description, expected_rubric, language,
      starter_code, points, position, options
    )
    SELECT
      _new_id, f.type, f.title, f.description, f.expected_rubric, f.language,
      f.starter_code, f.points, f.position, f.options
    FROM public.project_files f
    WHERE f.project_id = _source_id;
  END IF;

  RETURN _new_id;
END
$function$;

-- ── 4) teacher_open_attendance_check_in ────────────────────────────────
CREATE OR REPLACE FUNCTION public.teacher_open_attendance_check_in(p_session_id uuid, p_duration_minutes integer DEFAULT 10, p_rotation_seconds integer DEFAULT 60)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
  -- Papelera: no abrir check-in sobre una sesión en la papelera.
  IF v_session.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;
  IF p_duration_minutes < 1 OR p_duration_minutes > 240 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_duration');
  END IF;
  IF p_rotation_seconds < 15 OR p_rotation_seconds > 600 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_rotation');
  END IF;
  v_seed := encode(extensions.gen_random_bytes(16), 'hex');
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
$function$;

-- ── 5) update_session_whiteboard_scene ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_session_whiteboard_scene(_session_id uuid, _scene jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_course_id UUID;
  v_shared BOOLEAN;
  v_deleted_at TIMESTAMPTZ;
  v_is_teacher BOOLEAN;
  v_is_enrolled BOOLEAN;
BEGIN
  -- Cargar curso + estado de share + papelera. NULL = sesión no existe.
  SELECT course_id, COALESCE(whiteboard_shared, false), deleted_at
  INTO v_course_id, v_shared, v_deleted_at
  FROM public.attendance_sessions
  WHERE id = _session_id;

  IF v_course_id IS NULL THEN
    RAISE EXCEPTION 'Sesión no encontrada' USING ERRCODE = 'P0001';
  END IF;

  -- Papelera: una sesión borrada no se edita por nadie.
  IF v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'La sesión está en la papelera' USING ERRCODE = 'P0001';
  END IF;

  -- Docente / Admin / SuperAdmin: bypass directo.
  v_is_teacher := EXISTS (
    SELECT 1 FROM public.course_teachers
    WHERE course_id = v_course_id AND user_id = auth.uid()
  ) OR public.has_role(auth.uid(), 'Admin'::public.app_role)
    OR public.is_super_admin();

  IF NOT v_is_teacher THEN
    -- Alumno: solo si shared=true Y matriculado en el curso.
    IF NOT v_shared THEN
      RAISE EXCEPTION 'La pizarra no está compartida' USING ERRCODE = 'P0001';
    END IF;
    v_is_enrolled := EXISTS (
      SELECT 1 FROM public.course_enrollments
      WHERE course_id = v_course_id AND user_id = auth.uid()
    );
    IF NOT v_is_enrolled THEN
      RAISE EXCEPTION 'No estás matriculado en este curso' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Pasada la validación, escribimos. NO tocamos updated_at — el trigger
  -- existente lo maneja si está configurado para esa tabla.
  UPDATE public.attendance_sessions
  SET whiteboard_scene = _scene
  WHERE id = _session_id;
END;
$function$;

NOTIFY pgrst, 'reload schema';
