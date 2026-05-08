--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.9

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'SQL_ASCII';
SET standard_conforming_strings = off;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET escape_string_warning = off;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA "public";


--
-- Name: SCHEMA "public"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA "public" IS 'standard public schema';


--
-- Name: app_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."app_role" AS ENUM (
    'Admin',
    'Docente',
    'Estudiante'
);


--
-- Name: assert_one_project_group_per_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."assert_one_project_group_per_user"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_project_id uuid;
BEGIN
  SELECT project_id INTO v_project_id FROM public.project_groups WHERE id = NEW.group_id;
  IF EXISTS (
    SELECT 1
    FROM public.project_group_members m
    JOIN public.project_groups g ON g.id = m.group_id
    WHERE g.project_id = v_project_id
      AND m.user_id = NEW.user_id
      AND m.group_id <> NEW.group_id
  ) THEN
    RAISE EXCEPTION 'El estudiante ya está en otro grupo de este proyecto';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: assert_one_workshop_group_per_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."assert_one_workshop_group_per_user"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_workshop_id uuid;
BEGIN
  SELECT workshop_id INTO v_workshop_id FROM public.workshop_groups WHERE id = NEW.group_id;
  IF EXISTS (
    SELECT 1
    FROM public.workshop_group_members m
    JOIN public.workshop_groups g ON g.id = m.group_id
    WHERE g.workshop_id = v_workshop_id
      AND m.user_id = NEW.user_id
      AND m.group_id <> NEW.group_id
  ) THEN
    RAISE EXCEPTION 'El estudiante ya está en otro grupo de este taller';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: compute_attendance_code("text", bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."compute_attendance_code"("p_seed" "text", "p_period" bigint) RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public', 'extensions'
    AS $$
DECLARE
  h text;
  n int;
BEGIN
  h := encode(extensions.digest(p_seed || ':' || p_period::text, 'sha256'), 'hex');
  n := (('x' || substr(h, 1, 7))::bit(28))::int;
  RETURN lpad((n % 1000000)::text, 6, '0');
END;
$$;


--
-- Name: enforce_cut_item_weights_max_100(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."enforce_cut_item_weights_max_100"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE total NUMERIC;
BEGIN
  SELECT COALESCE(SUM(weight), 0) INTO total
  FROM public.grade_cut_items
  WHERE cut_id = COALESCE(NEW.cut_id, OLD.cut_id)
    AND id <> COALESCE(NEW.id, OLD.id);
  total := total + COALESCE(NEW.weight, 0);
  IF total > 100.01 THEN
    RAISE EXCEPTION 'La suma de pesos de items del corte excede 100 (actual: %).', total;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: enforce_cut_weights_max_100(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."enforce_cut_weights_max_100"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE total NUMERIC;
BEGIN
  SELECT COALESCE(SUM(weight), 0) INTO total
  FROM public.grade_cuts
  WHERE course_id = COALESCE(NEW.course_id, OLD.course_id)
    AND id <> COALESCE(NEW.id, OLD.id);
  total := total + COALESCE(NEW.weight, 0);
  IF total > 100.01 THEN
    RAISE EXCEPTION 'La suma de pesos de cortes excede 100 (actual: %).', total;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, personal_email, institutional_email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    NEW.raw_user_meta_data->>'personal_email',
    COALESCE(NEW.raw_user_meta_data->>'institutional_email', NEW.email)
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;


--
-- Name: has_role("uuid", "public"."app_role"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."has_role"("_user_id" "uuid", "_role" "public"."app_role") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;


--
-- Name: is_question_course_teacher("text", "uuid", "uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."is_question_course_teacher"("p_kind" "text", "p_question_id" "uuid", "p_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select case p_kind
    when 'exam' then exists (
      select 1
      from public.questions q
      join public.exams e on e.id = q.exam_id
      join public.course_teachers ct on ct.course_id = e.course_id
      where q.id = p_question_id and ct.user_id = p_user_id
    )
    when 'workshop' then exists (
      select 1
      from public.workshop_questions wq
      join public.workshops w on w.id = wq.workshop_id
      join public.course_teachers ct on ct.course_id = w.course_id
      where wq.id = p_question_id and ct.user_id = p_user_id
    )
    when 'project' then exists (
      select 1
      from public.project_files pf
      join public.projects p on p.id = pf.project_id
      left join public.project_courses pc on pc.project_id = p.id
      join public.course_teachers ct
        on (ct.course_id = pc.course_id or ct.course_id = p.course_id)
      where pf.id = p_question_id and ct.user_id = p_user_id
    )
    else false
  end;
$$;


--
-- Name: is_submission_owner("text", "uuid", "uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."is_submission_owner"("p_kind" "text", "p_submission_id" "uuid", "p_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select case p_kind
    when 'exam' then exists (
      select 1 from public.submissions s
      where s.id = p_submission_id and s.user_id = p_user_id
    )
    when 'workshop' then exists (
      select 1 from public.workshop_submissions s
      where s.id = p_submission_id and s.user_id = p_user_id
    )
    when 'project' then exists (
      select 1 from public.project_submissions s
      where s.id = p_submission_id and s.user_id = p_user_id
    )
    else false
  end;
$$;


--
-- Name: notify_course_students("uuid", "text", "text", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."notify_course_students"("_course_id" "uuid", "_title" "text", "_body" "text", "_kind" "text" DEFAULT 'info'::"text", "_link" "text" DEFAULT NULL::"text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  _count INTEGER;
BEGIN
  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT ce.user_id, _title, _body, _kind, _link
  FROM public.course_enrollments ce
  WHERE ce.course_id = _course_id;

  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END;
$$;


--
-- Name: notify_exam_teachers("uuid", "text", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."notify_exam_teachers"("_exam_id" "uuid", "_title" "text", "_body" "text", "_link" "text" DEFAULT NULL::"text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  _staff_rows INTEGER := 0;
  _course_id UUID;
  _exam_title TEXT;
BEGIN
  SELECT e.course_id, e.title INTO _course_id, _exam_title
  FROM public.exams e
  WHERE e.id = _exam_id;

  IF _course_id IS NULL THEN
    RETURN 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.submissions s
    WHERE s.exam_id = _exam_id AND s.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- Docentes del curso (course_teachers) + autor del examen
  INSERT INTO public.notifications (
    user_id, title, body, kind, link, exam_id, related_user_id
  )
  SELECT DISTINCT
    x.tid,
    _title,
    _body,
    'exam_integrity_staff',
    _link,
    _exam_id,
    auth.uid()
  FROM (
    SELECT e.created_by AS tid
    FROM public.exams e
    WHERE e.id = _exam_id AND e.created_by IS NOT NULL
    UNION
    SELECT ct.user_id AS tid
    FROM public.course_teachers ct
    WHERE ct.course_id = _course_id
  ) x
  WHERE x.tid IS NOT NULL;

  GET DIAGNOSTICS _staff_rows = ROW_COUNT;

  INSERT INTO public.notifications (
    user_id, title, body, kind, link, exam_id, related_user_id
  )
  VALUES (
    auth.uid(),
    'Examen marcado como sospechoso',
    format(
      'Tu intento del examen "%s" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.',
      COALESCE(_exam_title, 'el examen')
    ),
    'exam_integrity_student',
    '/app/student/exams',
    _exam_id,
    auth.uid()
  );

  RETURN _staff_rows + 1;
END;
$$;


--
-- Name: notify_feedback_event("uuid", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."notify_feedback_event"("_thread_id" "uuid", "_event" "text", "_actor_role" "text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  t public.feedback_threads;
  _student_id uuid;
  _course_id uuid;
  _ref_id uuid;
  _student_link text;
  _teacher_link text;
  _parent_title text;
  _course_name text;
  _kind_label text;
  _actor_name text;
  _question_pos integer;
  _attempt_number integer;
  _question_label text;
  _title text;
  _body text;
  _count integer := 0;
begin
  select * into t from public.feedback_threads where id = _thread_id;
  if not found then
    return 0;
  end if;

  select full_name into _actor_name
  from public.profiles where id = auth.uid();

  if t.parent_kind = 'exam' then
    select user_id into _student_id from public.submissions where id = t.submission_id;
    select exam_id into _ref_id from public.questions where id = t.question_id;
    select course_id, e.title into _course_id, _parent_title
    from public.exams e where e.id = _ref_id;
    select position into _question_pos
    from public.questions where id = t.question_id;
    with ranked as (
      select s.id, row_number() over (
        partition by s.user_id, s.exam_id order by s.created_at
      ) as rn
      from public.submissions s
      where s.user_id = _student_id and s.exam_id = _ref_id
    )
    select rn::integer into _attempt_number from ranked where id = t.submission_id;
    _kind_label := 'Examen';
    _student_link := '/app/student/review/' || _ref_id::text;
    _teacher_link := '/app/teacher/monitor/' || _ref_id::text
      || '?student=' || _student_id::text;
  elsif t.parent_kind = 'workshop' then
    select user_id into _student_id from public.workshop_submissions where id = t.submission_id;
    select workshop_id into _ref_id from public.workshop_questions where id = t.question_id;
    select course_id, w.title into _course_id, _parent_title
    from public.workshops w where w.id = _ref_id;
    select position into _question_pos
    from public.workshop_questions where id = t.question_id;
    _kind_label := 'Taller';
    _student_link := '/app/student/workshop/' || _ref_id::text;
    _teacher_link := '/app/teacher/workshops?id=' || _ref_id::text
      || '&student=' || _student_id::text;
  elsif t.parent_kind = 'project' then
    select user_id into _student_id from public.project_submissions where id = t.submission_id;
    select project_id into _ref_id from public.project_files where id = t.question_id;
    select
      coalesce(
        p.course_id,
        (select pc.course_id from public.project_courses pc where pc.project_id = _ref_id limit 1)
      ),
      p.title
    into _course_id, _parent_title
    from public.projects p where p.id = _ref_id;
    select position into _question_pos
    from public.project_files where id = t.question_id;
    _kind_label := 'Proyecto';
    _student_link := '/app/student/project/' || _ref_id::text;
    _teacher_link := '/app/teacher/projects?id=' || _ref_id::text
      || '&student=' || _student_id::text;
  else
    return 0;
  end if;

  -- Nombre del curso para el título.
  if _course_id is not null then
    select name into _course_name from public.courses where id = _course_id;
  end if;

  if _question_pos is null then
    _question_label := 'una pregunta';
  else
    _question_label := 'la pregunta ' || (
      case when _question_pos < 1 then _question_pos + 1 else _question_pos end
    )::text;
    if t.parent_kind = 'exam' and _attempt_number is not null then
      _question_label := _question_label || ' (intento ' || _attempt_number::text || ')';
    end if;
  end if;

  -- Título: "Examen: Parcial 1 · Programación I". Si no hay curso,
  -- omitimos el sufijo " · ..." para no dejar un punto medio huérfano.
  _title := _kind_label || ': ' || coalesce(_parent_title, 'sin título');
  if _course_name is not null then
    _title := _title || ' · ' || _course_name;
  end if;

  if _event = 'comment' then
    if _actor_role = 'student' then
      _body := coalesce(_actor_name, 'Un estudiante')
        || ' hizo un comentario en ' || _question_label || '.';
      insert into public.notifications (user_id, title, body, kind, link)
      select ct.user_id, _title, _body, 'feedback', _teacher_link
      from public.course_teachers ct
      where ct.course_id = _course_id;
      get diagnostics _count = row_count;
    else
      _body := coalesce(_actor_name, 'El docente')
        || ' respondió a tu retroalimentación en ' || _question_label || '.';
      if _student_id is not null then
        insert into public.notifications (user_id, title, body, kind, link)
        values (_student_id, _title, _body, 'feedback', _student_link);
        _count := 1;
      end if;
    end if;
  elsif _event = 'closed' then
    _body := 'El docente cerró la conversación de retroalimentación en '
      || _question_label || '.';
    if _student_id is not null then
      insert into public.notifications (user_id, title, body, kind, link)
      values (_student_id, _title, _body, 'feedback', _student_link);
      _count := 1;
    end if;
  elsif _event = 'reopened' then
    _body := 'El docente reabrió la conversación de retroalimentación en '
      || _question_label || '.';
    if _student_id is not null then
      insert into public.notifications (user_id, title, body, kind, link)
      values (_student_id, _title, _body, 'feedback', _student_link);
      _count := 1;
    end if;
  end if;

  return _count;
end;
$$;


--
-- Name: notify_students_course_closing(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."notify_students_course_closing"("_days" integer DEFAULT 7) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE _count INTEGER;
BEGIN
  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT
    ce.user_id,
    'Curso ' || c.name || ' cerrando pronto',
    'El curso ' || c.name || ' finaliza el ' || c.end_date::text || '.',
    'info',
    '/app/student/courses'
  FROM public.courses c
  JOIN public.course_enrollments ce ON ce.course_id = c.id
  WHERE c.end_date = (CURRENT_DATE + _days)
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
      WHERE n.user_id = ce.user_id
        AND n.title = 'Curso ' || c.name || ' cerrando pronto'
        AND n.created_at::date = CURRENT_DATE
    );
  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END $$;


--
-- Name: notify_students_cut_closing(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."notify_students_cut_closing"("_days" integer DEFAULT 3) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE _count INTEGER;
BEGIN
  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT
    ce.user_id,
    'Corte ' || gc.name || ' cerrando pronto',
    'El corte "' || gc.name || '" del curso ' || c.name ||
      ' cierra el ' || gc.end_date::text || '.',
    'grade',
    '/app/student/grades'
  FROM public.grade_cuts gc
  JOIN public.courses c ON c.id = gc.course_id
  JOIN public.course_enrollments ce ON ce.course_id = c.id
  WHERE gc.end_date = (CURRENT_DATE + _days)
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
      WHERE n.user_id = ce.user_id
        AND n.link = '/app/student/grades'
        AND n.title = 'Corte ' || gc.name || ' cerrando pronto'
        AND n.created_at::date = CURRENT_DATE
    );
  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END $$;


--
-- Name: notify_teachers_pending_grading(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."notify_teachers_pending_grading"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE _count INTEGER;
BEGIN
  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT
    ct.user_id,
    'Entregas pendientes por calificar',
    'Tienes ' || COUNT(*)::text || ' entrega(s) en el curso ' || c.name ||
      ' pendientes después de su fecha de cierre.',
    'workshop',
    '/app/teacher/workshops'
  FROM public.workshop_submissions ws
  JOIN public.workshops w ON w.id = ws.workshop_id
  JOIN public.courses c ON c.id = w.course_id
  JOIN public.course_teachers ct ON ct.course_id = c.id
  WHERE w.due_date < now()
    AND ws.status IN ('entregado', 'ai_revisado')  -- aún no calificados
  GROUP BY ct.user_id, c.id, c.name
  HAVING COUNT(*) > 0;
  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END $$;


--
-- Name: notify_teachers_workshop_due_tomorrow(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."notify_teachers_workshop_due_tomorrow"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE _count INTEGER;
BEGIN
  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT
    ct.user_id,
    'Talleres vencen mañana',
    COUNT(*)::text || ' taller(es) del curso ' || c.name || ' vencen mañana.',
    'workshop',
    '/app/teacher/workshops'
  FROM public.workshops w
  JOIN public.courses c ON c.id = w.course_id
  JOIN public.course_teachers ct ON ct.course_id = c.id
  WHERE w.due_date::date = (CURRENT_DATE + 1)
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
      WHERE n.user_id = ct.user_id
        AND n.title = 'Talleres vencen mañana'
        AND n.link = '/app/teacher/workshops'
        AND n.created_at::date = CURRENT_DATE
    )
  GROUP BY ct.user_id, c.id, c.name;
  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END $$;


--
-- Name: student_check_in_attendance("uuid", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."student_check_in_attendance"("p_session_id" "uuid", "p_code" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $_$
DECLARE
  v_uid uuid := auth.uid();
  v_session public.attendance_sessions%ROWTYPE;
  v_state public.attendance_check_in_state%ROWTYPE;
  v_period bigint;
  v_code_now text;
  v_code_prev text;
  v_normalized text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;
  SELECT * INTO v_session FROM public.attendance_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
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

  v_period := floor(extract(epoch from now()) / v_state.rotation_seconds)::bigint;
  v_code_now := public.compute_attendance_code(v_state.seed, v_period);
  v_code_prev := public.compute_attendance_code(v_state.seed, v_period - 1);
  IF v_normalized <> v_code_now AND v_normalized <> v_code_prev THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;

  INSERT INTO public.attendance_records (session_id, user_id, status)
  VALUES (p_session_id, v_uid, 'presente')
  ON CONFLICT (session_id, user_id) DO UPDATE SET status = 'presente';

  RETURN jsonb_build_object('ok', true);
END;
$_$;


--
-- Name: teacher_close_attendance_check_in("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."teacher_close_attendance_check_in"("p_session_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;
  IF NOT (public.has_role(v_uid, 'Admin') OR public.has_role(v_uid, 'Docente')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;
  UPDATE public.attendance_sessions SET check_in_open = false WHERE id = p_session_id;
  DELETE FROM public.attendance_check_in_state WHERE session_id = p_session_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;


--
-- Name: teacher_mark_pending_absent("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."teacher_mark_pending_absent"("p_session_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_session public.attendance_sessions%ROWTYPE;
  v_inserted int;
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

  WITH inserted AS (
    INSERT INTO public.attendance_records (session_id, user_id, status)
    SELECT p_session_id, ce.user_id, 'ausente'
    FROM public.course_enrollments ce
    WHERE ce.course_id = v_session.course_id
      AND NOT EXISTS (
        SELECT 1 FROM public.attendance_records ar
        WHERE ar.session_id = p_session_id AND ar.user_id = ce.user_id
      )
    RETURNING 1
  )
  SELECT count(*)::int INTO v_inserted FROM inserted;

  RETURN jsonb_build_object('ok', true, 'marked_absent', v_inserted);
END;
$$;


--
-- Name: teacher_open_attendance_check_in("uuid", integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."teacher_open_attendance_check_in"("p_session_id" "uuid", "p_duration_minutes" integer DEFAULT 10, "p_rotation_seconds" integer DEFAULT 60) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
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
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = "heap";

--
-- Name: ai_model_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_model_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider" "text" NOT NULL,
    "model" "text" NOT NULL,
    "is_active" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "uuid",
    CONSTRAINT "ai_model_settings_provider_check" CHECK (("provider" = ANY (ARRAY['lovable'::"text", 'openai'::"text"])))
);


--
-- Name: ai_prompts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_prompts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "use_case" "text" NOT NULL,
    "course_id" "uuid",
    "system_prompt" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "uuid",
    CONSTRAINT "ai_prompts_use_case_check" CHECK (("use_case" = ANY (ARRAY['workshop_full'::"text", 'workshop_question'::"text", 'project_file'::"text", 'project_full'::"text", 'exam_question'::"text", 'exam_time_evaluation'::"text"])))
);


--
-- Name: attendance_check_in_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."attendance_check_in_state" (
    "session_id" "uuid" NOT NULL,
    "seed" "text" NOT NULL,
    "rotation_seconds" integer DEFAULT 60 NOT NULL,
    "opened_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "closes_at" timestamp with time zone NOT NULL
);


--
-- Name: attendance_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."attendance_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'presente'::"text" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: attendance_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."attendance_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "course_id" "uuid" NOT NULL,
    "session_date" "date" NOT NULL,
    "title" "text",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "check_in_open" boolean DEFAULT false NOT NULL
);


--
-- Name: code_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."code_executions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "submission_id" "uuid",
    "question_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "language" "text" DEFAULT 'java'::"text" NOT NULL,
    "source_code" "text" NOT NULL,
    "stdin" "text" DEFAULT ''::"text",
    "stdout" "text",
    "stderr" "text",
    "exit_code" integer,
    "execution_time_ms" integer,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: course_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."course_enrollments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "course_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: course_grading_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."course_grading_config" (
    "course_id" "uuid" NOT NULL,
    "final_project_weight" numeric(5,2) DEFAULT 0 NOT NULL,
    "coursework_weight" numeric(5,2) DEFAULT 100 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cgc_weights_nonneg" CHECK ((("final_project_weight" >= (0)::numeric) AND ("coursework_weight" >= (0)::numeric))),
    CONSTRAINT "cgc_weights_sum_100" CHECK ((("final_project_weight" + "coursework_weight") = (100)::numeric))
);


--
-- Name: course_grading_weights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."course_grading_weights" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "course_id" "uuid" NOT NULL,
    "component" "text" NOT NULL,
    "weight" numeric DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: course_teachers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."course_teachers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "course_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: courses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."courses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "period" "text",
    "start_date" "date",
    "end_date" "date",
    "grade_scale_min" numeric DEFAULT 0 NOT NULL,
    "grade_scale_max" numeric DEFAULT 5 NOT NULL,
    "exam_weight" numeric DEFAULT 50 NOT NULL,
    "workshop_weight" numeric DEFAULT 50 NOT NULL,
    "passing_grade" numeric DEFAULT 3 NOT NULL,
    "attendance_weight" numeric DEFAULT 0 NOT NULL,
    "language" "text" DEFAULT 'es'::"text" NOT NULL,
    "max_exam_attempts" integer DEFAULT 1 NOT NULL,
    "project_weight" numeric DEFAULT 0 NOT NULL,
    CONSTRAINT "courses_language_check" CHECK (("language" = ANY (ARRAY['es'::"text", 'en'::"text"])))
);


--
-- Name: exam_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."exam_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "exam_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: exam_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."exam_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "exam_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "content" "text" NOT NULL,
    "status" "text" DEFAULT 'pendiente'::"text" NOT NULL,
    "rejection_reason" "text",
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "exam_notes_status_check" CHECK (("status" = ANY (ARRAY['pendiente'::"text", 'aprobada'::"text", 'rechazada'::"text"])))
);


--
-- Name: exam_timer_controls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."exam_timer_controls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "exam_id" "uuid" NOT NULL,
    "target_user_id" "uuid",
    "action" "text" NOT NULL,
    "extra_seconds" integer DEFAULT 0,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: exams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."exams" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "course_id" "uuid" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "start_time" timestamp with time zone NOT NULL,
    "end_time" timestamp with time zone NOT NULL,
    "time_limit_minutes" integer DEFAULT 60 NOT NULL,
    "navigation_type" "text" DEFAULT 'libre'::"text" NOT NULL,
    "shuffle_enabled" boolean DEFAULT false NOT NULL,
    "parent_exam_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "max_attempts" integer,
    "cut_id" "uuid",
    "weight" numeric DEFAULT 1 NOT NULL,
    "schedule_type" "text" DEFAULT 'normal'::"text" NOT NULL,
    "retry_mode" "text" DEFAULT 'last'::"text" NOT NULL,
    "is_external" boolean DEFAULT false NOT NULL,
    "max_warnings" integer DEFAULT 3 NOT NULL,
    CONSTRAINT "exams_max_warnings_check" CHECK ((("max_warnings" >= 1) AND ("max_warnings" <= 50))),
    CONSTRAINT "exams_retry_mode_check" CHECK (("retry_mode" = ANY (ARRAY['last'::"text", 'average'::"text", 'highest'::"text"]))),
    CONSTRAINT "exams_schedule_type_check" CHECK (("schedule_type" = ANY (ARRAY['normal'::"text", 'relativo'::"text"])))
);


--
-- Name: feedback_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."feedback_comments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thread_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "author_role" "text" DEFAULT 'student'::"text" NOT NULL,
    CONSTRAINT "feedback_comments_author_role_check" CHECK (("author_role" = ANY (ARRAY['student'::"text", 'teacher'::"text"]))),
    CONSTRAINT "feedback_comments_body_check" CHECK ((("length"("body") > 0) AND ("length"("body") <= 4000)))
);


--
-- Name: feedback_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."feedback_threads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "parent_kind" "text" NOT NULL,
    "question_id" "uuid" NOT NULL,
    "submission_id" "uuid" NOT NULL,
    "closed" boolean DEFAULT false NOT NULL,
    "closed_at" timestamp with time zone,
    "closed_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "feedback_threads_parent_kind_check" CHECK (("parent_kind" = ANY (ARRAY['exam'::"text", 'workshop'::"text", 'project'::"text"])))
);


--
-- Name: grade_cut_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."grade_cut_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "cut_id" "uuid" NOT NULL,
    "item_type" "text" NOT NULL,
    "exam_id" "uuid",
    "workshop_id" "uuid",
    "project_title" "text",
    "weight" numeric(5,2) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "project_id" "uuid",
    CONSTRAINT "grade_cut_items_item_type_check" CHECK (("item_type" = ANY (ARRAY['exam'::"text", 'workshop'::"text", 'project'::"text"]))),
    CONSTRAINT "grade_cut_items_shape" CHECK (((("item_type" = 'exam'::"text") AND ("exam_id" IS NOT NULL) AND ("workshop_id" IS NULL) AND ("project_id" IS NULL) AND ("project_title" IS NULL)) OR (("item_type" = 'workshop'::"text") AND ("workshop_id" IS NOT NULL) AND ("exam_id" IS NULL) AND ("project_id" IS NULL) AND ("project_title" IS NULL)) OR (("item_type" = 'project'::"text") AND ("exam_id" IS NULL) AND ("workshop_id" IS NULL) AND (("project_id" IS NOT NULL) OR ("project_title" IS NOT NULL))))),
    CONSTRAINT "grade_cut_items_weight_range" CHECK ((("weight" >= (0)::numeric) AND ("weight" <= (100)::numeric)))
);


--
-- Name: grade_cuts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."grade_cuts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "course_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "start_date" "date",
    "end_date" "date",
    "weight" numeric(5,2) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "exam_weight" numeric DEFAULT 0 NOT NULL,
    "workshop_weight" numeric DEFAULT 0 NOT NULL,
    "attendance_weight" numeric DEFAULT 0 NOT NULL,
    "project_weight" numeric DEFAULT 0 NOT NULL,
    CONSTRAINT "grade_cuts_dates_ok" CHECK ((("start_date" IS NULL) OR ("end_date" IS NULL) OR ("start_date" <= "end_date"))),
    CONSTRAINT "grade_cuts_weight_range" CHECK ((("weight" >= (0)::numeric) AND ("weight" <= (100)::numeric)))
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text" NOT NULL,
    "kind" "text" DEFAULT 'info'::"text" NOT NULL,
    "link" "text",
    "read" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "exam_id" "uuid",
    "related_user_id" "uuid"
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."profiles" (
    "id" "uuid" NOT NULL,
    "full_name" "text" NOT NULL,
    "personal_email" "text",
    "institutional_email" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: project_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."project_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: project_courses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."project_courses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "course_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: project_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."project_files" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "expected_rubric" "text",
    "language" "text",
    "points" numeric DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "type" "text" DEFAULT 'abierta'::"text" NOT NULL,
    "options" "jsonb",
    "starter_code" "text",
    "content" "text",
    CONSTRAINT "project_files_type_check" CHECK (("type" = ANY (ARRAY['abierta'::"text", 'cerrada'::"text", 'codigo'::"text", 'diagrama'::"text", 'java_gui'::"text", 'codigo_zip'::"text"])))
);


--
-- Name: project_group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."project_group_members" (
    "group_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: project_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."project_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "signup_code" "text" DEFAULT "substr"("md5"(("random"())::"text"), 1, 6) NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: project_submission_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."project_submission_attachments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_submission_file_id" "uuid" NOT NULL,
    "file_name" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "mime_type" "text",
    "size_bytes" bigint,
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: project_submission_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."project_submission_files" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "submission_id" "uuid" NOT NULL,
    "file_id" "uuid" NOT NULL,
    "content" "text",
    "ai_grade" numeric,
    "ai_feedback" "text",
    "ai_likelihood" numeric,
    "ai_reasons" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "selected_option" "text",
    "zip_path" "text"
);


--
-- Name: project_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."project_submissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "zip_url" "text",
    "status" "text" DEFAULT 'pendiente'::"text" NOT NULL,
    "ai_grade" numeric,
    "ai_feedback" "text",
    "ai_detected" boolean DEFAULT false NOT NULL,
    "ai_detected_score" numeric,
    "ai_detected_reasons" "text",
    "final_grade" numeric,
    "teacher_feedback" "text",
    "submitted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "submission_grade" numeric,
    "defense_factor" numeric,
    "defense_notes" "text",
    "defense_at" timestamp with time zone,
    "repository_url" "text",
    "group_id" "uuid",
    CONSTRAINT "project_submissions_defense_factor_check" CHECK ((("defense_factor" IS NULL) OR (("defense_factor" >= (0)::numeric) AND ("defense_factor" <= (1)::numeric))))
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "course_id" "uuid" NOT NULL,
    "cut_id" "uuid",
    "created_by" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "instructions" "text",
    "project_type" "text" DEFAULT 'escrito'::"text" NOT NULL,
    "max_files" integer DEFAULT 10 NOT NULL,
    "max_score" numeric DEFAULT 100 NOT NULL,
    "start_date" timestamp with time zone,
    "due_date" timestamp with time zone,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "ai_generated" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "external_link" "text",
    "weight" numeric DEFAULT 1 NOT NULL,
    "group_mode" "text" DEFAULT 'individual'::"text" NOT NULL,
    "group_size_min" integer DEFAULT 2 NOT NULL,
    "group_size_max" integer DEFAULT 5 NOT NULL,
    "is_external" boolean DEFAULT false NOT NULL,
    CONSTRAINT "projects_group_mode_check" CHECK (("group_mode" = ANY (ARRAY['individual'::"text", 'teacher_assigned'::"text", 'self_signup'::"text"])))
);


--
-- Name: questions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."questions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "exam_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "content" "text" NOT NULL,
    "expected_rubric" "text",
    "options" "jsonb",
    "points" numeric DEFAULT 1 NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "language" "text" DEFAULT 'java'::"text",
    "starter_code" "text",
    "test_cases" "jsonb",
    CONSTRAINT "questions_type_check" CHECK (("type" = ANY (ARRAY['abierta'::"text", 'cerrada'::"text", 'codigo'::"text", 'diagrama'::"text", 'java_gui'::"text"])))
);


--
-- Name: similarity_pairs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."similarity_pairs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "kind" "text" NOT NULL,
    "ref_id" "uuid" NOT NULL,
    "question_id" "uuid",
    "submission_a" "uuid" NOT NULL,
    "submission_b" "uuid" NOT NULL,
    "user_a" "uuid" NOT NULL,
    "user_b" "uuid" NOT NULL,
    "score" numeric NOT NULL,
    "method" "text" DEFAULT 'gemini'::"text" NOT NULL,
    "reasons" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "similarity_pairs_distinct" CHECK (("submission_a" <> "submission_b")),
    CONSTRAINT "similarity_pairs_kind_check" CHECK (("kind" = ANY (ARRAY['exam'::"text", 'workshop'::"text", 'project'::"text"]))),
    CONSTRAINT "similarity_pairs_ordered" CHECK (("submission_a" < "submission_b")),
    CONSTRAINT "similarity_pairs_score_check" CHECK ((("score" >= (0)::numeric) AND ("score" <= (1)::numeric)))
);


--
-- Name: submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."submissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "exam_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "answers" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "ai_grade" numeric,
    "final_override_grade" numeric,
    "status" "text" DEFAULT 'en_progreso'::"text" NOT NULL,
    "focus_warnings" integer DEFAULT 0 NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "submitted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ai_detected" boolean DEFAULT false NOT NULL,
    "ai_detected_score" numeric,
    "ai_detected_reasons" "text",
    "teacher_feedback" "text",
    "extra_seconds" integer DEFAULT 0 NOT NULL
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."user_roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "public"."app_role" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: workshop_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."workshop_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workshop_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: workshop_group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."workshop_group_members" (
    "group_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: workshop_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."workshop_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workshop_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "signup_code" "text" DEFAULT "substr"("md5"(("random"())::"text"), 1, 6) NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: workshop_questions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."workshop_questions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workshop_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "content" "text" NOT NULL,
    "options" "jsonb",
    "position" integer DEFAULT 0 NOT NULL,
    "points" numeric DEFAULT 1 NOT NULL,
    "expected_rubric" "text",
    "starter_code" "text",
    "test_cases" "jsonb",
    "language" "text" DEFAULT 'java'::"text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "workshop_questions_type_check" CHECK (("type" = ANY (ARRAY['abierta'::"text", 'cerrada'::"text", 'codigo'::"text", 'diagrama'::"text", 'java_gui'::"text"])))
);


--
-- Name: workshop_submission_answers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."workshop_submission_answers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "submission_id" "uuid" NOT NULL,
    "question_id" "uuid" NOT NULL,
    "answer_text" "text",
    "selected_option" "text",
    "code_content" "text",
    "diagram_code" "text",
    "ai_grade" numeric,
    "ai_feedback" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ai_detected" boolean DEFAULT false NOT NULL,
    "ai_detected_score" numeric,
    "ai_detected_reasons" "text"
);


--
-- Name: workshop_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."workshop_submissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workshop_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "content" "text",
    "file_url" "text",
    "external_link" "text",
    "ai_grade" numeric,
    "ai_feedback" "text",
    "final_grade" numeric,
    "teacher_feedback" "text",
    "status" "text" DEFAULT 'pendiente'::"text" NOT NULL,
    "submitted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ai_detected" boolean DEFAULT false NOT NULL,
    "ai_detected_score" numeric,
    "ai_detected_reasons" "text",
    "group_id" "uuid"
);


--
-- Name: workshops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."workshops" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "course_id" "uuid" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "instructions" "text",
    "external_link" "text",
    "ai_generated" boolean DEFAULT false NOT NULL,
    "due_date" timestamp with time zone,
    "rubric" "jsonb",
    "max_score" numeric DEFAULT 100 NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "start_date" timestamp with time zone,
    "cut_id" "uuid",
    "is_external" boolean DEFAULT false NOT NULL,
    "weight" numeric DEFAULT 1 NOT NULL,
    "group_mode" "text" DEFAULT 'individual'::"text" NOT NULL,
    "group_size_min" integer DEFAULT 2 NOT NULL,
    "group_size_max" integer DEFAULT 5 NOT NULL,
    CONSTRAINT "workshops_group_mode_check" CHECK (("group_mode" = ANY (ARRAY['individual'::"text", 'teacher_assigned'::"text", 'self_signup'::"text"])))
);


--
-- Data for Name: ai_model_settings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ai_prompts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: attendance_check_in_state; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: attendance_records; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: attendance_sessions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: code_executions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: course_enrollments; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: course_grading_config; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: course_grading_weights; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: course_teachers; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: courses; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: exam_assignments; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: exam_notes; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: exam_timer_controls; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: exams; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: feedback_comments; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: feedback_threads; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: grade_cut_items; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: grade_cuts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: notifications; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: profiles; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: project_assignments; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: project_courses; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: project_files; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: project_group_members; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: project_groups; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: project_submission_attachments; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: project_submission_files; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: project_submissions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: projects; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: questions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: similarity_pairs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: submissions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: user_roles; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workshop_assignments; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workshop_group_members; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workshop_groups; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workshop_questions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workshop_submission_answers; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workshop_submissions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workshops; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Name: ai_model_settings ai_model_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_model_settings"
    ADD CONSTRAINT "ai_model_settings_pkey" PRIMARY KEY ("id");


--
-- Name: ai_prompts ai_prompts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_prompts"
    ADD CONSTRAINT "ai_prompts_pkey" PRIMARY KEY ("id");


--
-- Name: attendance_check_in_state attendance_check_in_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attendance_check_in_state"
    ADD CONSTRAINT "attendance_check_in_state_pkey" PRIMARY KEY ("session_id");


--
-- Name: attendance_records attendance_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attendance_records"
    ADD CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id");


--
-- Name: attendance_records attendance_records_session_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attendance_records"
    ADD CONSTRAINT "attendance_records_session_id_user_id_key" UNIQUE ("session_id", "user_id");


--
-- Name: attendance_sessions attendance_sessions_course_id_session_date_title_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attendance_sessions"
    ADD CONSTRAINT "attendance_sessions_course_id_session_date_title_key" UNIQUE ("course_id", "session_date", "title");


--
-- Name: attendance_sessions attendance_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attendance_sessions"
    ADD CONSTRAINT "attendance_sessions_pkey" PRIMARY KEY ("id");


--
-- Name: code_executions code_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."code_executions"
    ADD CONSTRAINT "code_executions_pkey" PRIMARY KEY ("id");


--
-- Name: course_enrollments course_enrollments_course_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."course_enrollments"
    ADD CONSTRAINT "course_enrollments_course_id_user_id_key" UNIQUE ("course_id", "user_id");


--
-- Name: course_enrollments course_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."course_enrollments"
    ADD CONSTRAINT "course_enrollments_pkey" PRIMARY KEY ("id");


--
-- Name: course_grading_config course_grading_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."course_grading_config"
    ADD CONSTRAINT "course_grading_config_pkey" PRIMARY KEY ("course_id");


--
-- Name: course_grading_weights course_grading_weights_course_id_component_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."course_grading_weights"
    ADD CONSTRAINT "course_grading_weights_course_id_component_key" UNIQUE ("course_id", "component");


--
-- Name: course_grading_weights course_grading_weights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."course_grading_weights"
    ADD CONSTRAINT "course_grading_weights_pkey" PRIMARY KEY ("id");


--
-- Name: course_teachers course_teachers_course_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."course_teachers"
    ADD CONSTRAINT "course_teachers_course_id_user_id_key" UNIQUE ("course_id", "user_id");


--
-- Name: course_teachers course_teachers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."course_teachers"
    ADD CONSTRAINT "course_teachers_pkey" PRIMARY KEY ("id");


--
-- Name: courses courses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."courses"
    ADD CONSTRAINT "courses_pkey" PRIMARY KEY ("id");


--
-- Name: exam_assignments exam_assignments_exam_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exam_assignments"
    ADD CONSTRAINT "exam_assignments_exam_id_user_id_key" UNIQUE ("exam_id", "user_id");


--
-- Name: exam_assignments exam_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exam_assignments"
    ADD CONSTRAINT "exam_assignments_pkey" PRIMARY KEY ("id");


--
-- Name: exam_notes exam_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exam_notes"
    ADD CONSTRAINT "exam_notes_pkey" PRIMARY KEY ("id");


--
-- Name: exam_timer_controls exam_timer_controls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exam_timer_controls"
    ADD CONSTRAINT "exam_timer_controls_pkey" PRIMARY KEY ("id");


--
-- Name: exams exams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exams"
    ADD CONSTRAINT "exams_pkey" PRIMARY KEY ("id");


--
-- Name: feedback_comments feedback_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."feedback_comments"
    ADD CONSTRAINT "feedback_comments_pkey" PRIMARY KEY ("id");


--
-- Name: feedback_threads feedback_threads_parent_kind_question_id_submission_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."feedback_threads"
    ADD CONSTRAINT "feedback_threads_parent_kind_question_id_submission_id_key" UNIQUE ("parent_kind", "question_id", "submission_id");


--
-- Name: feedback_threads feedback_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."feedback_threads"
    ADD CONSTRAINT "feedback_threads_pkey" PRIMARY KEY ("id");


--
-- Name: grade_cut_items grade_cut_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."grade_cut_items"
    ADD CONSTRAINT "grade_cut_items_pkey" PRIMARY KEY ("id");


--
-- Name: grade_cuts grade_cuts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."grade_cuts"
    ADD CONSTRAINT "grade_cuts_pkey" PRIMARY KEY ("id");


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");


--
-- Name: profiles profiles_institutional_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_institutional_email_key" UNIQUE ("institutional_email");


--
-- Name: profiles profiles_personal_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_personal_email_key" UNIQUE ("personal_email");


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");


--
-- Name: project_assignments project_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_assignments"
    ADD CONSTRAINT "project_assignments_pkey" PRIMARY KEY ("id");


--
-- Name: project_assignments project_assignments_project_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_assignments"
    ADD CONSTRAINT "project_assignments_project_id_user_id_key" UNIQUE ("project_id", "user_id");


--
-- Name: project_courses project_courses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_courses"
    ADD CONSTRAINT "project_courses_pkey" PRIMARY KEY ("id");


--
-- Name: project_courses project_courses_project_id_course_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_courses"
    ADD CONSTRAINT "project_courses_project_id_course_id_key" UNIQUE ("project_id", "course_id");


--
-- Name: project_files project_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_files"
    ADD CONSTRAINT "project_files_pkey" PRIMARY KEY ("id");


--
-- Name: project_group_members project_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_group_members"
    ADD CONSTRAINT "project_group_members_pkey" PRIMARY KEY ("group_id", "user_id");


--
-- Name: project_groups project_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_groups"
    ADD CONSTRAINT "project_groups_pkey" PRIMARY KEY ("id");


--
-- Name: project_groups project_groups_project_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_groups"
    ADD CONSTRAINT "project_groups_project_id_name_key" UNIQUE ("project_id", "name");


--
-- Name: project_submission_attachments project_submission_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_submission_attachments"
    ADD CONSTRAINT "project_submission_attachments_pkey" PRIMARY KEY ("id");


--
-- Name: project_submission_attachments project_submission_attachments_storage_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_submission_attachments"
    ADD CONSTRAINT "project_submission_attachments_storage_path_key" UNIQUE ("storage_path");


--
-- Name: project_submission_files project_submission_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_submission_files"
    ADD CONSTRAINT "project_submission_files_pkey" PRIMARY KEY ("id");


--
-- Name: project_submission_files project_submission_files_submission_id_file_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_submission_files"
    ADD CONSTRAINT "project_submission_files_submission_id_file_id_key" UNIQUE ("submission_id", "file_id");


--
-- Name: project_submissions project_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_submissions"
    ADD CONSTRAINT "project_submissions_pkey" PRIMARY KEY ("id");


--
-- Name: project_submissions project_submissions_project_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_submissions"
    ADD CONSTRAINT "project_submissions_project_id_user_id_key" UNIQUE ("project_id", "user_id");


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");


--
-- Name: questions questions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."questions"
    ADD CONSTRAINT "questions_pkey" PRIMARY KEY ("id");


--
-- Name: similarity_pairs similarity_pairs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."similarity_pairs"
    ADD CONSTRAINT "similarity_pairs_pkey" PRIMARY KEY ("id");


--
-- Name: submissions submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."submissions"
    ADD CONSTRAINT "submissions_pkey" PRIMARY KEY ("id");


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id");


--
-- Name: user_roles user_roles_user_id_role_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_role_key" UNIQUE ("user_id", "role");


--
-- Name: workshop_assignments workshop_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_assignments"
    ADD CONSTRAINT "workshop_assignments_pkey" PRIMARY KEY ("id");


--
-- Name: workshop_assignments workshop_assignments_workshop_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_assignments"
    ADD CONSTRAINT "workshop_assignments_workshop_id_user_id_key" UNIQUE ("workshop_id", "user_id");


--
-- Name: workshop_group_members workshop_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_group_members"
    ADD CONSTRAINT "workshop_group_members_pkey" PRIMARY KEY ("group_id", "user_id");


--
-- Name: workshop_groups workshop_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_groups"
    ADD CONSTRAINT "workshop_groups_pkey" PRIMARY KEY ("id");


--
-- Name: workshop_groups workshop_groups_workshop_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_groups"
    ADD CONSTRAINT "workshop_groups_workshop_id_name_key" UNIQUE ("workshop_id", "name");


--
-- Name: workshop_questions workshop_questions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_questions"
    ADD CONSTRAINT "workshop_questions_pkey" PRIMARY KEY ("id");


--
-- Name: workshop_submission_answers workshop_submission_answers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_submission_answers"
    ADD CONSTRAINT "workshop_submission_answers_pkey" PRIMARY KEY ("id");


--
-- Name: workshop_submission_answers workshop_submission_answers_submission_id_question_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_submission_answers"
    ADD CONSTRAINT "workshop_submission_answers_submission_id_question_id_key" UNIQUE ("submission_id", "question_id");


--
-- Name: workshop_submissions workshop_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_submissions"
    ADD CONSTRAINT "workshop_submissions_pkey" PRIMARY KEY ("id");


--
-- Name: workshop_submissions workshop_submissions_workshop_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_submissions"
    ADD CONSTRAINT "workshop_submissions_workshop_id_user_id_key" UNIQUE ("workshop_id", "user_id");


--
-- Name: workshops workshops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshops"
    ADD CONSTRAINT "workshops_pkey" PRIMARY KEY ("id");


--
-- Name: feedback_comments_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "feedback_comments_thread" ON "public"."feedback_comments" USING "btree" ("thread_id", "created_at");


--
-- Name: feedback_threads_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "feedback_threads_lookup" ON "public"."feedback_threads" USING "btree" ("parent_kind", "submission_id");


--
-- Name: idx_ai_model_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_ai_model_one_active" ON "public"."ai_model_settings" USING "btree" ("is_active") WHERE ("is_active" = true);


--
-- Name: idx_ai_prompts_course; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_ai_prompts_course" ON "public"."ai_prompts" USING "btree" ("use_case", "course_id") WHERE ("course_id" IS NOT NULL);


--
-- Name: idx_ai_prompts_course_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_prompts_course_id" ON "public"."ai_prompts" USING "btree" ("course_id");


--
-- Name: idx_ai_prompts_global; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_ai_prompts_global" ON "public"."ai_prompts" USING "btree" ("use_case") WHERE ("course_id" IS NULL);


--
-- Name: idx_assignments_exam; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_assignments_exam" ON "public"."exam_assignments" USING "btree" ("exam_id");


--
-- Name: idx_assignments_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_assignments_user" ON "public"."exam_assignments" USING "btree" ("user_id");


--
-- Name: idx_attendance_records_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_attendance_records_session" ON "public"."attendance_records" USING "btree" ("session_id");


--
-- Name: idx_attendance_records_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_attendance_records_user" ON "public"."attendance_records" USING "btree" ("user_id");


--
-- Name: idx_attendance_sessions_course; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_attendance_sessions_course" ON "public"."attendance_sessions" USING "btree" ("course_id");


--
-- Name: idx_code_exec_submission; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_code_exec_submission" ON "public"."code_executions" USING "btree" ("submission_id");


--
-- Name: idx_code_exec_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_code_exec_user" ON "public"."code_executions" USING "btree" ("user_id");


--
-- Name: idx_course_enrollments_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_course_enrollments_user_id" ON "public"."course_enrollments" USING "btree" ("user_id");


--
-- Name: idx_course_teachers_course; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_course_teachers_course" ON "public"."course_teachers" USING "btree" ("course_id");


--
-- Name: idx_course_teachers_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_course_teachers_user" ON "public"."course_teachers" USING "btree" ("user_id");


--
-- Name: idx_enrollments_course; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_enrollments_course" ON "public"."course_enrollments" USING "btree" ("course_id");


--
-- Name: idx_enrollments_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_enrollments_user" ON "public"."course_enrollments" USING "btree" ("user_id");


--
-- Name: idx_exam_notes_exam_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_exam_notes_exam_user" ON "public"."exam_notes" USING "btree" ("exam_id", "user_id");


--
-- Name: idx_exam_notes_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_exam_notes_status" ON "public"."exam_notes" USING "btree" ("exam_id", "status");


--
-- Name: idx_exams_course; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_exams_course" ON "public"."exams" USING "btree" ("course_id");


--
-- Name: idx_exams_course_is_external; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_exams_course_is_external" ON "public"."exams" USING "btree" ("course_id", "is_external");


--
-- Name: idx_exams_cut_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_exams_cut_id" ON "public"."exams" USING "btree" ("cut_id");


--
-- Name: idx_exams_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_exams_parent" ON "public"."exams" USING "btree" ("parent_exam_id");


--
-- Name: idx_grade_cut_items_cut; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_grade_cut_items_cut" ON "public"."grade_cut_items" USING "btree" ("cut_id");


--
-- Name: idx_grade_cuts_course; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_grade_cuts_course" ON "public"."grade_cuts" USING "btree" ("course_id");


--
-- Name: idx_grading_weights_course; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_grading_weights_course" ON "public"."course_grading_weights" USING "btree" ("course_id");


--
-- Name: idx_notifications_exam_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_notifications_exam_id" ON "public"."notifications" USING "btree" ("exam_id") WHERE ("exam_id" IS NOT NULL);


--
-- Name: idx_notifications_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_notifications_unread" ON "public"."notifications" USING "btree" ("user_id", "read") WHERE ("read" = false);


--
-- Name: idx_notifications_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_notifications_user" ON "public"."notifications" USING "btree" ("user_id");


--
-- Name: idx_project_courses_course; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_project_courses_course" ON "public"."project_courses" USING "btree" ("course_id");


--
-- Name: idx_project_courses_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_project_courses_project" ON "public"."project_courses" USING "btree" ("project_id");


--
-- Name: idx_project_files_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_project_files_project" ON "public"."project_files" USING "btree" ("project_id");


--
-- Name: idx_project_group_members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_project_group_members_user" ON "public"."project_group_members" USING "btree" ("user_id");


--
-- Name: idx_project_groups_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_project_groups_project" ON "public"."project_groups" USING "btree" ("project_id");


--
-- Name: idx_project_sub_files_file; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_project_sub_files_file" ON "public"."project_submission_files" USING "btree" ("file_id");


--
-- Name: idx_project_sub_files_sub; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_project_sub_files_sub" ON "public"."project_submission_files" USING "btree" ("submission_id");


--
-- Name: idx_project_submissions_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_project_submissions_group" ON "public"."project_submissions" USING "btree" ("group_id");


--
-- Name: idx_project_submissions_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_project_submissions_project" ON "public"."project_submissions" USING "btree" ("project_id");


--
-- Name: idx_project_submissions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_project_submissions_user" ON "public"."project_submissions" USING "btree" ("user_id");


--
-- Name: idx_projects_course; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_projects_course" ON "public"."projects" USING "btree" ("course_id");


--
-- Name: idx_projects_course_is_external; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_projects_course_is_external" ON "public"."projects" USING "btree" ("course_id", "is_external");


--
-- Name: idx_projects_cut; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_projects_cut" ON "public"."projects" USING "btree" ("cut_id");


--
-- Name: idx_psa_psf; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_psa_psf" ON "public"."project_submission_attachments" USING "btree" ("project_submission_file_id");


--
-- Name: idx_questions_exam; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_questions_exam" ON "public"."questions" USING "btree" ("exam_id");


--
-- Name: idx_similarity_pairs_question; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_similarity_pairs_question" ON "public"."similarity_pairs" USING "btree" ("question_id");


--
-- Name: idx_similarity_pairs_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_similarity_pairs_ref" ON "public"."similarity_pairs" USING "btree" ("kind", "ref_id");


--
-- Name: idx_similarity_pairs_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_similarity_pairs_score" ON "public"."similarity_pairs" USING "btree" ("score" DESC);


--
-- Name: idx_similarity_pairs_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_similarity_pairs_unique" ON "public"."similarity_pairs" USING "btree" ("kind", "ref_id", COALESCE("question_id", '00000000-0000-0000-0000-000000000000'::"uuid"), "submission_a", "submission_b");


--
-- Name: idx_submissions_exam; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_submissions_exam" ON "public"."submissions" USING "btree" ("exam_id");


--
-- Name: idx_submissions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_submissions_user" ON "public"."submissions" USING "btree" ("user_id");


--
-- Name: idx_timer_controls_exam; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_timer_controls_exam" ON "public"."exam_timer_controls" USING "btree" ("exam_id");


--
-- Name: idx_timer_controls_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_timer_controls_target" ON "public"."exam_timer_controls" USING "btree" ("target_user_id");


--
-- Name: idx_user_roles_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_user_roles_user" ON "public"."user_roles" USING "btree" ("user_id");


--
-- Name: idx_workshop_answers_question; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_workshop_answers_question" ON "public"."workshop_submission_answers" USING "btree" ("question_id");


--
-- Name: idx_workshop_answers_submission; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_workshop_answers_submission" ON "public"."workshop_submission_answers" USING "btree" ("submission_id");


--
-- Name: idx_workshop_group_members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_workshop_group_members_user" ON "public"."workshop_group_members" USING "btree" ("user_id");


--
-- Name: idx_workshop_groups_workshop; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_workshop_groups_workshop" ON "public"."workshop_groups" USING "btree" ("workshop_id");


--
-- Name: idx_workshop_questions_workshop; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_workshop_questions_workshop" ON "public"."workshop_questions" USING "btree" ("workshop_id");


--
-- Name: idx_workshop_submissions_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_workshop_submissions_group" ON "public"."workshop_submissions" USING "btree" ("group_id");


--
-- Name: idx_workshops_course; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_workshops_course" ON "public"."workshops" USING "btree" ("course_id");


--
-- Name: idx_workshops_course_is_external; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_workshops_course_is_external" ON "public"."workshops" USING "btree" ("course_id", "is_external");


--
-- Name: idx_workshops_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_workshops_created_by" ON "public"."workshops" USING "btree" ("created_by");


--
-- Name: idx_workshops_cut_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_workshops_cut_id" ON "public"."workshops" USING "btree" ("cut_id");


--
-- Name: idx_ws_submissions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ws_submissions_user" ON "public"."workshop_submissions" USING "btree" ("user_id");


--
-- Name: idx_ws_submissions_workshop; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ws_submissions_workshop" ON "public"."workshop_submissions" USING "btree" ("workshop_id");


--
-- Name: submissions_one_in_progress_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "submissions_one_in_progress_per_user" ON "public"."submissions" USING "btree" ("exam_id", "user_id") WHERE ("status" = 'en_progreso'::"text");


--
-- Name: course_grading_config cgc_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "cgc_updated" BEFORE UPDATE ON "public"."course_grading_config" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: courses courses_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "courses_updated" BEFORE UPDATE ON "public"."courses" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: exam_notes exam_notes_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "exam_notes_set_updated_at" BEFORE UPDATE ON "public"."exam_notes" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: exams exams_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "exams_updated" BEFORE UPDATE ON "public"."exams" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: grade_cuts grade_cuts_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "grade_cuts_updated" BEFORE UPDATE ON "public"."grade_cuts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: profiles profiles_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "profiles_updated" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: project_submission_files project_sub_files_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "project_sub_files_updated" BEFORE UPDATE ON "public"."project_submission_files" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: submissions submissions_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "submissions_updated" BEFORE UPDATE ON "public"."submissions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: ai_model_settings trg_ai_model_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_ai_model_settings_updated_at" BEFORE UPDATE ON "public"."ai_model_settings" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: ai_prompts trg_ai_prompts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_ai_prompts_updated_at" BEFORE UPDATE ON "public"."ai_prompts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: grade_cut_items trg_enforce_cut_item_weights; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_enforce_cut_item_weights" BEFORE INSERT OR UPDATE ON "public"."grade_cut_items" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_cut_item_weights_max_100"();


--
-- Name: grade_cuts trg_enforce_cut_weights; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_enforce_cut_weights" BEFORE INSERT OR UPDATE ON "public"."grade_cuts" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_cut_weights_max_100"();


--
-- Name: project_group_members trg_one_project_group_per_user; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_one_project_group_per_user" BEFORE INSERT OR UPDATE ON "public"."project_group_members" FOR EACH ROW EXECUTE FUNCTION "public"."assert_one_project_group_per_user"();


--
-- Name: workshop_group_members trg_one_workshop_group_per_user; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_one_workshop_group_per_user" BEFORE INSERT OR UPDATE ON "public"."workshop_group_members" FOR EACH ROW EXECUTE FUNCTION "public"."assert_one_workshop_group_per_user"();


--
-- Name: project_submissions update_project_submissions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_project_submissions_updated_at" BEFORE UPDATE ON "public"."project_submissions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: projects update_projects_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_projects_updated_at" BEFORE UPDATE ON "public"."projects" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: workshop_submission_answers update_workshop_answers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_workshop_answers_updated_at" BEFORE UPDATE ON "public"."workshop_submission_answers" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: workshop_submissions workshop_submissions_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "workshop_submissions_updated" BEFORE UPDATE ON "public"."workshop_submissions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: workshops workshops_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "workshops_updated" BEFORE UPDATE ON "public"."workshops" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: ai_model_settings ai_model_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_model_settings"
    ADD CONSTRAINT "ai_model_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;


--
-- Name: ai_prompts ai_prompts_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_prompts"
    ADD CONSTRAINT "ai_prompts_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE CASCADE;


--
-- Name: ai_prompts ai_prompts_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_prompts"
    ADD CONSTRAINT "ai_prompts_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;


--
-- Name: attendance_check_in_state attendance_check_in_state_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attendance_check_in_state"
    ADD CONSTRAINT "attendance_check_in_state_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."attendance_sessions"("id") ON DELETE CASCADE;


--
-- Name: attendance_records attendance_records_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attendance_records"
    ADD CONSTRAINT "attendance_records_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."attendance_sessions"("id") ON DELETE CASCADE;


--
-- Name: attendance_records attendance_records_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attendance_records"
    ADD CONSTRAINT "attendance_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: attendance_sessions attendance_sessions_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attendance_sessions"
    ADD CONSTRAINT "attendance_sessions_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE CASCADE;


--
-- Name: attendance_sessions attendance_sessions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attendance_sessions"
    ADD CONSTRAINT "attendance_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");


--
-- Name: code_executions code_executions_question_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."code_executions"
    ADD CONSTRAINT "code_executions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE CASCADE;


--
-- Name: code_executions code_executions_submission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."code_executions"
    ADD CONSTRAINT "code_executions_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE CASCADE;


--
-- Name: code_executions code_executions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."code_executions"
    ADD CONSTRAINT "code_executions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: course_enrollments course_enrollments_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."course_enrollments"
    ADD CONSTRAINT "course_enrollments_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE CASCADE;


--
-- Name: course_enrollments course_enrollments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."course_enrollments"
    ADD CONSTRAINT "course_enrollments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: course_enrollments course_enrollments_user_profile_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."course_enrollments"
    ADD CONSTRAINT "course_enrollments_user_profile_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


--
-- Name: course_grading_config course_grading_config_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."course_grading_config"
    ADD CONSTRAINT "course_grading_config_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE CASCADE;


--
-- Name: course_grading_weights course_grading_weights_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."course_grading_weights"
    ADD CONSTRAINT "course_grading_weights_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE CASCADE;


--
-- Name: course_teachers course_teachers_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."course_teachers"
    ADD CONSTRAINT "course_teachers_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE CASCADE;


--
-- Name: course_teachers course_teachers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."course_teachers"
    ADD CONSTRAINT "course_teachers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: exam_assignments exam_assignments_exam_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exam_assignments"
    ADD CONSTRAINT "exam_assignments_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE CASCADE;


--
-- Name: exam_assignments exam_assignments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exam_assignments"
    ADD CONSTRAINT "exam_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: exam_notes exam_notes_exam_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exam_notes"
    ADD CONSTRAINT "exam_notes_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE CASCADE;


--
-- Name: exam_timer_controls exam_timer_controls_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exam_timer_controls"
    ADD CONSTRAINT "exam_timer_controls_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");


--
-- Name: exam_timer_controls exam_timer_controls_exam_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exam_timer_controls"
    ADD CONSTRAINT "exam_timer_controls_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE CASCADE;


--
-- Name: exam_timer_controls exam_timer_controls_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exam_timer_controls"
    ADD CONSTRAINT "exam_timer_controls_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: exams exams_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exams"
    ADD CONSTRAINT "exams_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE CASCADE;


--
-- Name: exams exams_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exams"
    ADD CONSTRAINT "exams_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");


--
-- Name: exams exams_cut_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exams"
    ADD CONSTRAINT "exams_cut_id_fkey" FOREIGN KEY ("cut_id") REFERENCES "public"."grade_cuts"("id") ON DELETE SET NULL;


--
-- Name: exams exams_parent_exam_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exams"
    ADD CONSTRAINT "exams_parent_exam_id_fkey" FOREIGN KEY ("parent_exam_id") REFERENCES "public"."exams"("id") ON DELETE SET NULL;


--
-- Name: feedback_comments feedback_comments_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."feedback_comments"
    ADD CONSTRAINT "feedback_comments_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."feedback_threads"("id") ON DELETE CASCADE;


--
-- Name: feedback_comments feedback_comments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."feedback_comments"
    ADD CONSTRAINT "feedback_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");


--
-- Name: feedback_threads feedback_threads_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."feedback_threads"
    ADD CONSTRAINT "feedback_threads_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "auth"."users"("id");


--
-- Name: grade_cut_items grade_cut_items_cut_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."grade_cut_items"
    ADD CONSTRAINT "grade_cut_items_cut_id_fkey" FOREIGN KEY ("cut_id") REFERENCES "public"."grade_cuts"("id") ON DELETE CASCADE;


--
-- Name: grade_cut_items grade_cut_items_exam_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."grade_cut_items"
    ADD CONSTRAINT "grade_cut_items_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE CASCADE;


--
-- Name: grade_cut_items grade_cut_items_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."grade_cut_items"
    ADD CONSTRAINT "grade_cut_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;


--
-- Name: grade_cut_items grade_cut_items_workshop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."grade_cut_items"
    ADD CONSTRAINT "grade_cut_items_workshop_id_fkey" FOREIGN KEY ("workshop_id") REFERENCES "public"."workshops"("id") ON DELETE CASCADE;


--
-- Name: grade_cuts grade_cuts_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."grade_cuts"
    ADD CONSTRAINT "grade_cuts_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE CASCADE;


--
-- Name: notifications notifications_exam_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE SET NULL;


--
-- Name: notifications notifications_related_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_related_user_id_fkey" FOREIGN KEY ("related_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: project_assignments project_assignments_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_assignments"
    ADD CONSTRAINT "project_assignments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;


--
-- Name: project_assignments project_assignments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_assignments"
    ADD CONSTRAINT "project_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: project_courses project_courses_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_courses"
    ADD CONSTRAINT "project_courses_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE CASCADE;


--
-- Name: project_courses project_courses_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_courses"
    ADD CONSTRAINT "project_courses_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;


--
-- Name: project_files project_files_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_files"
    ADD CONSTRAINT "project_files_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;


--
-- Name: project_group_members project_group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_group_members"
    ADD CONSTRAINT "project_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."project_groups"("id") ON DELETE CASCADE;


--
-- Name: project_group_members project_group_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_group_members"
    ADD CONSTRAINT "project_group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: project_groups project_groups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_groups"
    ADD CONSTRAINT "project_groups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;


--
-- Name: project_groups project_groups_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_groups"
    ADD CONSTRAINT "project_groups_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;


--
-- Name: project_submission_attachments project_submission_attachments_project_submission_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_submission_attachments"
    ADD CONSTRAINT "project_submission_attachments_project_submission_file_id_fkey" FOREIGN KEY ("project_submission_file_id") REFERENCES "public"."project_submission_files"("id") ON DELETE CASCADE;


--
-- Name: project_submission_attachments project_submission_attachments_psf_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_submission_attachments"
    ADD CONSTRAINT "project_submission_attachments_psf_fk" FOREIGN KEY ("project_submission_file_id") REFERENCES "public"."project_submission_files"("id") ON DELETE CASCADE;


--
-- Name: project_submission_files project_submission_files_file_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_submission_files"
    ADD CONSTRAINT "project_submission_files_file_fk" FOREIGN KEY ("file_id") REFERENCES "public"."project_files"("id") ON DELETE CASCADE;


--
-- Name: project_submission_files project_submission_files_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_submission_files"
    ADD CONSTRAINT "project_submission_files_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."project_files"("id") ON DELETE CASCADE;


--
-- Name: project_submission_files project_submission_files_submission_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_submission_files"
    ADD CONSTRAINT "project_submission_files_submission_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."project_submissions"("id") ON DELETE CASCADE;


--
-- Name: project_submission_files project_submission_files_submission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_submission_files"
    ADD CONSTRAINT "project_submission_files_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "public"."project_submissions"("id") ON DELETE CASCADE;


--
-- Name: project_submissions project_submissions_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_submissions"
    ADD CONSTRAINT "project_submissions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."project_groups"("id") ON DELETE SET NULL;


--
-- Name: projects projects_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE SET NULL;


--
-- Name: questions questions_exam_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."questions"
    ADD CONSTRAINT "questions_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE CASCADE;


--
-- Name: submissions submissions_exam_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."submissions"
    ADD CONSTRAINT "submissions_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE CASCADE;


--
-- Name: submissions submissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."submissions"
    ADD CONSTRAINT "submissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: workshop_assignments workshop_assignments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_assignments"
    ADD CONSTRAINT "workshop_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: workshop_assignments workshop_assignments_workshop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_assignments"
    ADD CONSTRAINT "workshop_assignments_workshop_id_fkey" FOREIGN KEY ("workshop_id") REFERENCES "public"."workshops"("id") ON DELETE CASCADE;


--
-- Name: workshop_group_members workshop_group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_group_members"
    ADD CONSTRAINT "workshop_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."workshop_groups"("id") ON DELETE CASCADE;


--
-- Name: workshop_group_members workshop_group_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_group_members"
    ADD CONSTRAINT "workshop_group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: workshop_groups workshop_groups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_groups"
    ADD CONSTRAINT "workshop_groups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;


--
-- Name: workshop_groups workshop_groups_workshop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_groups"
    ADD CONSTRAINT "workshop_groups_workshop_id_fkey" FOREIGN KEY ("workshop_id") REFERENCES "public"."workshops"("id") ON DELETE CASCADE;


--
-- Name: workshop_submission_answers workshop_submission_answers_submission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_submission_answers"
    ADD CONSTRAINT "workshop_submission_answers_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "public"."workshop_submissions"("id") ON DELETE CASCADE;


--
-- Name: workshop_submissions workshop_submissions_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_submissions"
    ADD CONSTRAINT "workshop_submissions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."workshop_groups"("id") ON DELETE SET NULL;


--
-- Name: workshop_submissions workshop_submissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_submissions"
    ADD CONSTRAINT "workshop_submissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: workshop_submissions workshop_submissions_workshop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshop_submissions"
    ADD CONSTRAINT "workshop_submissions_workshop_id_fkey" FOREIGN KEY ("workshop_id") REFERENCES "public"."workshops"("id") ON DELETE CASCADE;


--
-- Name: workshops workshops_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshops"
    ADD CONSTRAINT "workshops_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE CASCADE;


--
-- Name: workshops workshops_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshops"
    ADD CONSTRAINT "workshops_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");


--
-- Name: workshops workshops_cut_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workshops"
    ADD CONSTRAINT "workshops_cut_id_fkey" FOREIGN KEY ("cut_id") REFERENCES "public"."grade_cuts"("id") ON DELETE SET NULL;


--
-- Name: course_teachers Admins manage course_teachers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage course_teachers" ON "public"."course_teachers" TO "authenticated" USING ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")) WITH CHECK ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"));


--
-- Name: courses Admins manage courses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage courses" ON "public"."courses" TO "authenticated" USING ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")) WITH CHECK ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"));


--
-- Name: course_enrollments Admins manage enrollments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage enrollments" ON "public"."course_enrollments" TO "authenticated" USING ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")) WITH CHECK ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"));


--
-- Name: profiles Admins manage profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage profiles" ON "public"."profiles" TO "authenticated" USING ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")) WITH CHECK ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"));


--
-- Name: user_roles Admins manage roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage roles" ON "public"."user_roles" TO "authenticated" USING ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")) WITH CHECK ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"));


--
-- Name: user_roles Admins see all roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins see all roles" ON "public"."user_roles" FOR SELECT TO "authenticated" USING ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"));


--
-- Name: attendance_sessions Authenticated view attendance sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated view attendance sessions" ON "public"."attendance_sessions" FOR SELECT TO "authenticated" USING (true);


--
-- Name: course_teachers Authenticated view course_teachers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated view course_teachers" ON "public"."course_teachers" FOR SELECT TO "authenticated" USING (true);


--
-- Name: exams Authenticated view exams; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated view exams" ON "public"."exams" FOR SELECT TO "authenticated" USING (true);


--
-- Name: course_grading_weights Authenticated view grading weights; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated view grading weights" ON "public"."course_grading_weights" FOR SELECT TO "authenticated" USING (true);


--
-- Name: projects Authenticated view projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated view projects" ON "public"."projects" FOR SELECT TO "authenticated" USING (true);


--
-- Name: questions Authenticated view questions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated view questions" ON "public"."questions" FOR SELECT TO "authenticated" USING (true);


--
-- Name: workshop_questions Authenticated view workshop questions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated view workshop questions" ON "public"."workshop_questions" FOR SELECT TO "authenticated" USING (true);


--
-- Name: workshops Authenticated view workshops; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated view workshops" ON "public"."workshops" FOR SELECT TO "authenticated" USING (true);


--
-- Name: courses Courses viewable by authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Courses viewable by authenticated" ON "public"."courses" FOR SELECT TO "authenticated" USING (true);


--
-- Name: courses Docentes manage courses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes manage courses" ON "public"."courses" TO "authenticated" USING ("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role")) WITH CHECK ("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role"));


--
-- Name: course_enrollments Docentes manage enrollments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes manage enrollments" ON "public"."course_enrollments" TO "authenticated" USING ("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role")) WITH CHECK ("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role"));


--
-- Name: course_teachers Docentes manage other course_teachers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes manage other course_teachers" ON "public"."course_teachers" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") AND ("user_id" <> "auth"."uid"()))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") AND ("user_id" <> "auth"."uid"())));


--
-- Name: project_submissions Docentes/Admins delete project submissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins delete project submissions" ON "public"."project_submissions" FOR DELETE TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: similarity_pairs Docentes/Admins delete similarity_pairs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins delete similarity_pairs" ON "public"."similarity_pairs" FOR DELETE TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: submissions Docentes/Admins delete submissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins delete submissions" ON "public"."submissions" FOR DELETE TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: workshop_submission_answers Docentes/Admins delete workshop answers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins delete workshop answers" ON "public"."workshop_submission_answers" FOR DELETE TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: workshop_submissions Docentes/Admins delete workshop submissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins delete workshop submissions" ON "public"."workshop_submissions" FOR DELETE TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: similarity_pairs Docentes/Admins insert similarity_pairs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins insert similarity_pairs" ON "public"."similarity_pairs" FOR INSERT TO "authenticated" WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: submissions Docentes/Admins insert submissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins insert submissions" ON "public"."submissions" FOR INSERT TO "authenticated" WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: workshop_submissions Docentes/Admins insert workshop submissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins insert workshop submissions" ON "public"."workshop_submissions" FOR INSERT TO "authenticated" WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: exam_assignments Docentes/Admins manage assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins manage assignments" ON "public"."exam_assignments" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: attendance_records Docentes/Admins manage attendance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins manage attendance" ON "public"."attendance_records" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: attendance_sessions Docentes/Admins manage attendance sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins manage attendance sessions" ON "public"."attendance_sessions" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: exams Docentes/Admins manage exams; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins manage exams" ON "public"."exams" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: course_grading_weights Docentes/Admins manage grading weights; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins manage grading weights" ON "public"."course_grading_weights" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: projects Docentes/Admins manage projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins manage projects" ON "public"."projects" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: questions Docentes/Admins manage questions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins manage questions" ON "public"."questions" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: workshop_assignments Docentes/Admins manage workshop assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins manage workshop assignments" ON "public"."workshop_assignments" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: workshop_questions Docentes/Admins manage workshop questions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins manage workshop questions" ON "public"."workshop_questions" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: workshops Docentes/Admins manage workshops; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins manage workshops" ON "public"."workshops" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: similarity_pairs Docentes/Admins read similarity_pairs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins read similarity_pairs" ON "public"."similarity_pairs" FOR SELECT TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: submissions Docentes/Admins update submissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins update submissions" ON "public"."submissions" FOR UPDATE TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: workshop_submissions Docentes/Admins update workshop submissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Docentes/Admins update workshop submissions" ON "public"."workshop_submissions" FOR UPDATE TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: course_enrollments Enrollments viewable by authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enrollments viewable by authenticated" ON "public"."course_enrollments" FOR SELECT TO "authenticated" USING (true);


--
-- Name: profiles Profiles viewable by all authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Profiles viewable by all authenticated" ON "public"."profiles" FOR SELECT TO "authenticated" USING (true);


--
-- Name: project_submissions Students delete own project submissions in window; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students delete own project submissions in window" ON "public"."project_submissions" FOR DELETE TO "authenticated" USING ((("auth"."uid"() = "user_id") AND (EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "project_submissions"."project_id") AND ("p"."status" = 'published'::"text") AND (("p"."due_date" IS NULL) OR ("p"."due_date" > "now"())) AND (("p"."start_date" IS NULL) OR ("p"."start_date" <= "now"())))))));


--
-- Name: workshop_submissions Students delete own workshop submissions in window; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students delete own workshop submissions in window" ON "public"."workshop_submissions" FOR DELETE TO "authenticated" USING ((("auth"."uid"() = "user_id") AND (EXISTS ( SELECT 1
   FROM "public"."workshops" "w"
  WHERE (("w"."id" = "workshop_submissions"."workshop_id") AND ("w"."status" = 'published'::"text") AND (("w"."due_date" IS NULL) OR ("w"."due_date" > "now"())) AND (("w"."start_date" IS NULL) OR ("w"."start_date" <= "now"())))))));


--
-- Name: exam_notes Students manage own exam notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students manage own exam notes" ON "public"."exam_notes" TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));


--
-- Name: exam_timer_controls Students see own or global timer controls; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students see own or global timer controls" ON "public"."exam_timer_controls" FOR SELECT TO "authenticated" USING ((("target_user_id" = "auth"."uid"()) OR ("target_user_id" IS NULL)));


--
-- Name: exam_notes Teachers see all exam notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers see all exam notes" ON "public"."exam_notes" FOR SELECT TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: exam_notes Teachers update exam notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers update exam notes" ON "public"."exam_notes" FOR UPDATE TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: code_executions Teachers/Admins manage code executions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers/Admins manage code executions" ON "public"."code_executions" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: exam_timer_controls Teachers/Admins manage timer controls; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers/Admins manage timer controls" ON "public"."exam_timer_controls" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: code_executions Users insert own code executions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users insert own code executions" ON "public"."code_executions" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));


--
-- Name: project_submissions Users insert own project submissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users insert own project submissions" ON "public"."project_submissions" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));


--
-- Name: submissions Users insert own submissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users insert own submissions" ON "public"."submissions" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));


--
-- Name: workshop_submission_answers Users insert own workshop answers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users insert own workshop answers" ON "public"."workshop_submission_answers" FOR INSERT TO "authenticated" WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."workshop_submissions" "ws"
  WHERE (("ws"."id" = "workshop_submission_answers"."submission_id") AND ("ws"."user_id" = "auth"."uid"())))) OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: exam_assignments Users see own assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users see own assignments" ON "public"."exam_assignments" FOR SELECT TO "authenticated" USING ((("auth"."uid"() = "user_id") OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: attendance_records Users see own attendance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users see own attendance" ON "public"."attendance_records" FOR SELECT TO "authenticated" USING ((("auth"."uid"() = "user_id") OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: code_executions Users see own code executions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users see own code executions" ON "public"."code_executions" FOR SELECT TO "authenticated" USING ((("auth"."uid"() = "user_id") OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: project_submissions Users see own project submissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users see own project submissions" ON "public"."project_submissions" FOR SELECT TO "authenticated" USING ((("auth"."uid"() = "user_id") OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: user_roles Users see own roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users see own roles" ON "public"."user_roles" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));


--
-- Name: submissions Users see own submissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users see own submissions" ON "public"."submissions" FOR SELECT TO "authenticated" USING ((("auth"."uid"() = "user_id") OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: workshop_submission_answers Users see own workshop answers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users see own workshop answers" ON "public"."workshop_submission_answers" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."workshop_submissions" "ws"
  WHERE (("ws"."id" = "workshop_submission_answers"."submission_id") AND (("ws"."user_id" = "auth"."uid"()) OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))))));


--
-- Name: workshop_assignments Users see own workshop assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users see own workshop assignments" ON "public"."workshop_assignments" FOR SELECT TO "authenticated" USING ((("auth"."uid"() = "user_id") OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: profiles Users update own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users update own profile" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "id"));


--
-- Name: project_submissions Users update own project submissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users update own project submissions" ON "public"."project_submissions" FOR UPDATE TO "authenticated" USING ((("auth"."uid"() = "user_id") OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: submissions Users update own submissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users update own submissions" ON "public"."submissions" FOR UPDATE TO "authenticated" USING ((("auth"."uid"() = "user_id") OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: workshop_submission_answers Users update own workshop answers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users update own workshop answers" ON "public"."workshop_submission_answers" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."workshop_submissions" "ws"
  WHERE (("ws"."id" = "workshop_submission_answers"."submission_id") AND (("ws"."user_id" = "auth"."uid"()) OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))))));


--
-- Name: ai_model_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ai_model_settings" ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_model_settings ai_model_settings_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "ai_model_settings_admin_write" ON "public"."ai_model_settings" TO "authenticated" USING ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")) WITH CHECK ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"));


--
-- Name: ai_model_settings ai_model_settings_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "ai_model_settings_read" ON "public"."ai_model_settings" FOR SELECT TO "authenticated" USING (true);


--
-- Name: ai_prompts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ai_prompts" ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_prompts ai_prompts_admin_global; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "ai_prompts_admin_global" ON "public"."ai_prompts" TO "authenticated" USING ((("course_id" IS NULL) AND "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK ((("course_id" IS NULL) AND "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: ai_prompts ai_prompts_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "ai_prompts_read" ON "public"."ai_prompts" FOR SELECT TO "authenticated" USING (true);


--
-- Name: ai_prompts ai_prompts_teacher_course; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "ai_prompts_teacher_course" ON "public"."ai_prompts" TO "authenticated" USING ((("course_id" IS NOT NULL) AND ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role") OR (EXISTS ( SELECT 1
   FROM "public"."course_teachers" "ct"
  WHERE (("ct"."course_id" = "ai_prompts"."course_id") AND ("ct"."user_id" = "auth"."uid"()))))))) WITH CHECK ((("course_id" IS NOT NULL) AND ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role") OR (EXISTS ( SELECT 1
   FROM "public"."course_teachers" "ct"
  WHERE (("ct"."course_id" = "ai_prompts"."course_id") AND ("ct"."user_id" = "auth"."uid"())))))));


--
-- Name: attendance_check_in_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."attendance_check_in_state" ENABLE ROW LEVEL SECURITY;

--
-- Name: attendance_records; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."attendance_records" ENABLE ROW LEVEL SECURITY;

--
-- Name: attendance_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."attendance_sessions" ENABLE ROW LEVEL SECURITY;

--
-- Name: course_grading_config cgc_admin_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cgc_admin_all" ON "public"."course_grading_config" TO "authenticated" USING ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")) WITH CHECK ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"));


--
-- Name: course_grading_config cgc_student_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cgc_student_read" ON "public"."course_grading_config" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."course_enrollments" "ce"
  WHERE (("ce"."course_id" = "course_grading_config"."course_id") AND ("ce"."user_id" = "auth"."uid"())))));


--
-- Name: course_grading_config cgc_teacher_of_course; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cgc_teacher_of_course" ON "public"."course_grading_config" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") AND (EXISTS ( SELECT 1
   FROM "public"."course_teachers" "ct"
  WHERE (("ct"."course_id" = "course_grading_config"."course_id") AND ("ct"."user_id" = "auth"."uid"())))))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") AND (EXISTS ( SELECT 1
   FROM "public"."course_teachers" "ct"
  WHERE (("ct"."course_id" = "course_grading_config"."course_id") AND ("ct"."user_id" = "auth"."uid"()))))));


--
-- Name: attendance_check_in_state check_in_state_teacher_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "check_in_state_teacher_admin" ON "public"."attendance_check_in_state" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: code_executions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."code_executions" ENABLE ROW LEVEL SECURITY;

--
-- Name: course_enrollments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."course_enrollments" ENABLE ROW LEVEL SECURITY;

--
-- Name: course_grading_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."course_grading_config" ENABLE ROW LEVEL SECURITY;

--
-- Name: course_grading_weights; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."course_grading_weights" ENABLE ROW LEVEL SECURITY;

--
-- Name: course_teachers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."course_teachers" ENABLE ROW LEVEL SECURITY;

--
-- Name: courses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."courses" ENABLE ROW LEVEL SECURITY;

--
-- Name: grade_cut_items cut_items_admin_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cut_items_admin_all" ON "public"."grade_cut_items" TO "authenticated" USING ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")) WITH CHECK ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"));


--
-- Name: grade_cut_items cut_items_student_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cut_items_student_read" ON "public"."grade_cut_items" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."grade_cuts" "gc"
     JOIN "public"."course_enrollments" "ce" ON (("ce"."course_id" = "gc"."course_id")))
  WHERE (("gc"."id" = "grade_cut_items"."cut_id") AND ("ce"."user_id" = "auth"."uid"())))));


--
-- Name: grade_cut_items cut_items_teacher_of_course; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cut_items_teacher_of_course" ON "public"."grade_cut_items" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") AND (EXISTS ( SELECT 1
   FROM ("public"."grade_cuts" "gc"
     JOIN "public"."course_teachers" "ct" ON (("ct"."course_id" = "gc"."course_id")))
  WHERE (("gc"."id" = "grade_cut_items"."cut_id") AND ("ct"."user_id" = "auth"."uid"())))))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") AND (EXISTS ( SELECT 1
   FROM ("public"."grade_cuts" "gc"
     JOIN "public"."course_teachers" "ct" ON (("ct"."course_id" = "gc"."course_id")))
  WHERE (("gc"."id" = "grade_cut_items"."cut_id") AND ("ct"."user_id" = "auth"."uid"()))))));


--
-- Name: grade_cuts cuts_admin_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cuts_admin_all" ON "public"."grade_cuts" TO "authenticated" USING ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")) WITH CHECK ("public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"));


--
-- Name: grade_cuts cuts_student_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cuts_student_read" ON "public"."grade_cuts" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."course_enrollments" "ce"
  WHERE (("ce"."course_id" = "grade_cuts"."course_id") AND ("ce"."user_id" = "auth"."uid"())))));


--
-- Name: grade_cuts cuts_teacher_of_course; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cuts_teacher_of_course" ON "public"."grade_cuts" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") AND (EXISTS ( SELECT 1
   FROM "public"."course_teachers" "ct"
  WHERE (("ct"."course_id" = "grade_cuts"."course_id") AND ("ct"."user_id" = "auth"."uid"())))))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") AND (EXISTS ( SELECT 1
   FROM "public"."course_teachers" "ct"
  WHERE (("ct"."course_id" = "grade_cuts"."course_id") AND ("ct"."user_id" = "auth"."uid"()))))));


--
-- Name: exam_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."exam_assignments" ENABLE ROW LEVEL SECURITY;

--
-- Name: exam_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."exam_notes" ENABLE ROW LEVEL SECURITY;

--
-- Name: exam_timer_controls; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."exam_timer_controls" ENABLE ROW LEVEL SECURITY;

--
-- Name: exams; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."exams" ENABLE ROW LEVEL SECURITY;

--
-- Name: feedback_comments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."feedback_comments" ENABLE ROW LEVEL SECURITY;

--
-- Name: feedback_comments feedback_comments delete own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "feedback_comments delete own" ON "public"."feedback_comments" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));


--
-- Name: feedback_comments feedback_comments insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "feedback_comments insert" ON "public"."feedback_comments" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."feedback_threads" "t"
  WHERE (("t"."id" = "feedback_comments"."thread_id") AND ("t"."closed" = false) AND ("public"."is_submission_owner"("t"."parent_kind", "t"."submission_id", "auth"."uid"()) OR "public"."is_question_course_teacher"("t"."parent_kind", "t"."question_id", "auth"."uid"())))))));


--
-- Name: feedback_comments feedback_comments select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "feedback_comments select" ON "public"."feedback_comments" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."feedback_threads" "t"
  WHERE (("t"."id" = "feedback_comments"."thread_id") AND ("public"."is_submission_owner"("t"."parent_kind", "t"."submission_id", "auth"."uid"()) OR "public"."is_question_course_teacher"("t"."parent_kind", "t"."question_id", "auth"."uid"()))))));


--
-- Name: feedback_comments feedback_comments update own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "feedback_comments update own" ON "public"."feedback_comments" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));


--
-- Name: feedback_threads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."feedback_threads" ENABLE ROW LEVEL SECURITY;

--
-- Name: feedback_threads feedback_threads insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "feedback_threads insert" ON "public"."feedback_threads" FOR INSERT TO "authenticated" WITH CHECK (("public"."is_submission_owner"("parent_kind", "submission_id", "auth"."uid"()) OR "public"."is_question_course_teacher"("parent_kind", "question_id", "auth"."uid"())));


--
-- Name: feedback_threads feedback_threads select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "feedback_threads select" ON "public"."feedback_threads" FOR SELECT TO "authenticated" USING (("public"."is_submission_owner"("parent_kind", "submission_id", "auth"."uid"()) OR "public"."is_question_course_teacher"("parent_kind", "question_id", "auth"."uid"())));


--
-- Name: feedback_threads feedback_threads update teacher; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "feedback_threads update teacher" ON "public"."feedback_threads" FOR UPDATE TO "authenticated" USING ("public"."is_question_course_teacher"("parent_kind", "question_id", "auth"."uid"())) WITH CHECK ("public"."is_question_course_teacher"("parent_kind", "question_id", "auth"."uid"()));


--
-- Name: grade_cut_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."grade_cut_items" ENABLE ROW LEVEL SECURITY;

--
-- Name: grade_cuts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."grade_cuts" ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications notifications_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "notifications_insert" ON "public"."notifications" FOR INSERT TO "authenticated" WITH CHECK ((("auth"."uid"() = "user_id") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role") OR ("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") AND ("kind" = ANY (ARRAY['exam'::"text", 'info'::"text", 'grade'::"text", 'workshop'::"text", 'system'::"text"])))));


--
-- Name: notifications notifications_select_recipient_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "notifications_select_recipient_or_admin" ON "public"."notifications" FOR SELECT TO "authenticated" USING ((("auth"."uid"() = "user_id") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: notifications notifications_update_recipient; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "notifications_update_recipient" ON "public"."notifications" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;

--
-- Name: project_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."project_assignments" ENABLE ROW LEVEL SECURITY;

--
-- Name: project_assignments project_assignments_manage_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "project_assignments_manage_staff" ON "public"."project_assignments" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: project_assignments project_assignments_owner_or_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "project_assignments_owner_or_staff" ON "public"."project_assignments" FOR SELECT TO "authenticated" USING ((("auth"."uid"() = "user_id") OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: project_courses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."project_courses" ENABLE ROW LEVEL SECURITY;

--
-- Name: project_courses project_courses_manage_teachers_admins; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "project_courses_manage_teachers_admins" ON "public"."project_courses" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: project_courses project_courses_view_all_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "project_courses_view_all_authenticated" ON "public"."project_courses" FOR SELECT TO "authenticated" USING (true);


--
-- Name: project_files; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."project_files" ENABLE ROW LEVEL SECURITY;

--
-- Name: project_files project_files_manage_teachers_admins; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "project_files_manage_teachers_admins" ON "public"."project_files" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: project_files project_files_view_all_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "project_files_view_all_authenticated" ON "public"."project_files" FOR SELECT TO "authenticated" USING (true);


--
-- Name: project_group_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."project_group_members" ENABLE ROW LEVEL SECURITY;

--
-- Name: project_group_members project_group_members_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "project_group_members_read" ON "public"."project_group_members" FOR SELECT TO "authenticated" USING (true);


--
-- Name: project_group_members project_group_members_teacher_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "project_group_members_teacher_admin_write" ON "public"."project_group_members" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: project_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."project_groups" ENABLE ROW LEVEL SECURITY;

--
-- Name: project_groups project_groups_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "project_groups_read" ON "public"."project_groups" FOR SELECT TO "authenticated" USING (true);


--
-- Name: project_groups project_groups_teacher_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "project_groups_teacher_admin_write" ON "public"."project_groups" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: project_submission_files project_sub_files_owner_or_staff_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "project_sub_files_owner_or_staff_insert" ON "public"."project_submission_files" FOR INSERT TO "authenticated" WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."project_submissions" "ps"
  WHERE (("ps"."id" = "project_submission_files"."submission_id") AND ("ps"."user_id" = "auth"."uid"())))) OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: project_submission_files project_sub_files_owner_or_staff_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "project_sub_files_owner_or_staff_select" ON "public"."project_submission_files" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."project_submissions" "ps"
  WHERE (("ps"."id" = "project_submission_files"."submission_id") AND (("ps"."user_id" = "auth"."uid"()) OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))))));


--
-- Name: project_submission_files project_sub_files_owner_or_staff_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "project_sub_files_owner_or_staff_update" ON "public"."project_submission_files" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."project_submissions" "ps"
  WHERE (("ps"."id" = "project_submission_files"."submission_id") AND (("ps"."user_id" = "auth"."uid"()) OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))))));


--
-- Name: project_submission_files project_sub_files_staff_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "project_sub_files_staff_delete" ON "public"."project_submission_files" FOR DELETE TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: project_submission_attachments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."project_submission_attachments" ENABLE ROW LEVEL SECURITY;

--
-- Name: project_submission_files; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."project_submission_files" ENABLE ROW LEVEL SECURITY;

--
-- Name: project_submissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."project_submissions" ENABLE ROW LEVEL SECURITY;

--
-- Name: project_submissions project_submissions_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "project_submissions_insert" ON "public"."project_submissions" FOR INSERT TO "authenticated" WITH CHECK ((("auth"."uid"() = "user_id") OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role") OR (("group_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."project_group_members" "m"
  WHERE (("m"."group_id" = "project_submissions"."group_id") AND ("m"."user_id" = "auth"."uid"())))))));


--
-- Name: project_submissions project_submissions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "project_submissions_select" ON "public"."project_submissions" FOR SELECT TO "authenticated" USING ((("auth"."uid"() = "user_id") OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role") OR (("group_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."project_group_members" "m"
  WHERE (("m"."group_id" = "project_submissions"."group_id") AND ("m"."user_id" = "auth"."uid"())))))));


--
-- Name: project_submissions project_submissions_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "project_submissions_update" ON "public"."project_submissions" FOR UPDATE TO "authenticated" USING ((("auth"."uid"() = "user_id") OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role") OR (("group_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."project_group_members" "m"
  WHERE (("m"."group_id" = "project_submissions"."group_id") AND ("m"."user_id" = "auth"."uid"())))))));


--
-- Name: projects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;

--
-- Name: project_submission_attachments psa_delete_owner_or_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "psa_delete_owner_or_staff" ON "public"."project_submission_attachments" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."project_submission_files" "psf"
     JOIN "public"."project_submissions" "ps" ON (("ps"."id" = "psf"."submission_id")))
  WHERE (("psf"."id" = "project_submission_attachments"."project_submission_file_id") AND (("ps"."user_id" = "auth"."uid"()) OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))))));


--
-- Name: project_submission_attachments psa_insert_owner_or_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "psa_insert_owner_or_staff" ON "public"."project_submission_attachments" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."project_submission_files" "psf"
     JOIN "public"."project_submissions" "ps" ON (("ps"."id" = "psf"."submission_id")))
  WHERE (("psf"."id" = "project_submission_attachments"."project_submission_file_id") AND (("ps"."user_id" = "auth"."uid"()) OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))))));


--
-- Name: project_submission_attachments psa_select_owner_or_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "psa_select_owner_or_staff" ON "public"."project_submission_attachments" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."project_submission_files" "psf"
     JOIN "public"."project_submissions" "ps" ON (("ps"."id" = "psf"."submission_id")))
  WHERE (("psf"."id" = "project_submission_attachments"."project_submission_file_id") AND (("ps"."user_id" = "auth"."uid"()) OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))))));


--
-- Name: questions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."questions" ENABLE ROW LEVEL SECURITY;

--
-- Name: similarity_pairs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."similarity_pairs" ENABLE ROW LEVEL SECURITY;

--
-- Name: submissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."submissions" ENABLE ROW LEVEL SECURITY;

--
-- Name: user_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."user_roles" ENABLE ROW LEVEL SECURITY;

--
-- Name: workshop_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."workshop_assignments" ENABLE ROW LEVEL SECURITY;

--
-- Name: workshop_group_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."workshop_group_members" ENABLE ROW LEVEL SECURITY;

--
-- Name: workshop_group_members workshop_group_members_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "workshop_group_members_read" ON "public"."workshop_group_members" FOR SELECT TO "authenticated" USING (true);


--
-- Name: workshop_group_members workshop_group_members_teacher_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "workshop_group_members_teacher_admin_write" ON "public"."workshop_group_members" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: workshop_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."workshop_groups" ENABLE ROW LEVEL SECURITY;

--
-- Name: workshop_groups workshop_groups_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "workshop_groups_read" ON "public"."workshop_groups" FOR SELECT TO "authenticated" USING (true);


--
-- Name: workshop_groups workshop_groups_teacher_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "workshop_groups_teacher_admin_write" ON "public"."workshop_groups" TO "authenticated" USING (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role"))) WITH CHECK (("public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role")));


--
-- Name: workshop_questions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."workshop_questions" ENABLE ROW LEVEL SECURITY;

--
-- Name: workshop_submission_answers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."workshop_submission_answers" ENABLE ROW LEVEL SECURITY;

--
-- Name: workshop_submissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."workshop_submissions" ENABLE ROW LEVEL SECURITY;

--
-- Name: workshop_submissions workshop_submissions_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "workshop_submissions_insert" ON "public"."workshop_submissions" FOR INSERT TO "authenticated" WITH CHECK ((("auth"."uid"() = "user_id") OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role") OR (("group_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."workshop_group_members" "m"
  WHERE (("m"."group_id" = "workshop_submissions"."group_id") AND ("m"."user_id" = "auth"."uid"())))))));


--
-- Name: workshop_submissions workshop_submissions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "workshop_submissions_select" ON "public"."workshop_submissions" FOR SELECT TO "authenticated" USING ((("auth"."uid"() = "user_id") OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role") OR (("group_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."workshop_group_members" "m"
  WHERE (("m"."group_id" = "workshop_submissions"."group_id") AND ("m"."user_id" = "auth"."uid"())))))));


--
-- Name: workshop_submissions workshop_submissions_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "workshop_submissions_update" ON "public"."workshop_submissions" FOR UPDATE TO "authenticated" USING ((("auth"."uid"() = "user_id") OR "public"."has_role"("auth"."uid"(), 'Docente'::"public"."app_role") OR "public"."has_role"("auth"."uid"(), 'Admin'::"public"."app_role") OR (("group_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."workshop_group_members" "m"
  WHERE (("m"."group_id" = "workshop_submissions"."group_id") AND ("m"."user_id" = "auth"."uid"())))))));


--
-- Name: workshops; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."workshops" ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--


