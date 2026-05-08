--
-- PostgreSQL database dump
--

\restrict fkk1HZhtZggq4GLnS4ffpH31mcZ8JH2OfMnAKKynGCgYXNKxdcSerUYUn8Ucl8o

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

COPY "public"."ai_model_settings" ("id", "provider", "model", "is_active", "created_at", "updated_at", "updated_by") FROM stdin;
3b03db3f-53d6-4643-a19f-ef89d0cd6b02	lovable	google/gemini-2.5-flash	t	2026-05-07 06:46:57.610645+00	2026-05-07 06:46:57.610645+00	\N
\.


--
-- Data for Name: ai_prompts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."ai_prompts" ("id", "use_case", "course_id", "system_prompt", "created_at", "updated_at", "updated_by") FROM stdin;
f013ad57-1b0a-4609-8346-99d2ecddb6cf	workshop_full	\N	Eres un evaluador académico imparcial. Calificas entregas de talleres según las instrucciones y rúbrica proporcionadas. Das un puntaje numérico, retroalimentación detallada y una estimación de probabilidad (0..1) de que la respuesta haya sido generada por IA.	2026-05-07 01:42:55.849386+00	2026-05-07 01:42:55.849386+00	\N
4b3bcdc1-5b16-4ddc-b6c8-965a5d0d5d65	workshop_question	\N	Eres un evaluador académico imparcial. Calificas la respuesta de un estudiante a UNA pregunta de taller. Das un puntaje, retroalimentación útil y una estimación de probabilidad (0..1) de que la respuesta haya sido generada por IA.	2026-05-07 01:42:55.849386+00	2026-05-07 01:42:55.849386+00	\N
82a15109-da21-4067-ad74-836c43174b2b	project_file	\N	Eres un evaluador académico imparcial. Calificas el contenido textual de UN archivo del proyecto de un estudiante. Das un puntaje, retroalimentación útil y una estimación de probabilidad (0..1) de que el contenido haya sido generado por IA.	2026-05-07 01:42:55.849386+00	2026-05-07 01:42:55.849386+00	\N
883df84f-6821-4afd-9555-5343cf41b28f	project_full	\N	Eres un evaluador académico imparcial y experto. Calificas un proyecto académico basándote en sus archivos. Das nota, retroalimentación detallada y una estimación de probabilidad (0..1) de que el contenido fue generado por IA, con razones claras.	2026-05-07 01:42:55.849386+00	2026-05-07 01:42:55.849386+00	\N
24903578-8979-4734-ac72-c7d3de0598fd	exam_question	\N	Eres un evaluador imparcial. Calificas respuestas de exámenes según la rúbrica dada. Das un puntaje, una breve justificación y una estimación de probabilidad (0..1) de que la respuesta haya sido generada por IA con razones.	2026-05-07 01:42:55.849386+00	2026-05-07 01:42:55.849386+00	\N
d8256657-bb35-417f-ab47-29ac1a90ff1e	exam_time_evaluation	\N	Eres un experto en diseño de evaluaciones académicas. Recibes el listado de preguntas de un examen (con tipo, enunciado, puntaje y rúbrica esperada) y la duración actual asignada en minutos.\n\nTu tarea:\n1) Estima cuánto tiempo razonable necesita un estudiante PROMEDIO para resolver cada pregunta. Bases:\n   - Cerrada (opción múltiple): ~1 min por pregunta.\n   - Abierta corta (1-3 puntos): ~3-5 min.\n   - Abierta larga / desarrollo: 5-15 min según complejidad de la rúbrica.\n   - Código: 8-20 min según el alcance del problema.\n   - Diagrama: 8-15 min.\n2) Suma los tiempos individuales para obtener un tiempo recomendado total. Agrega 10-15% de buffer para revisión.\n3) Compara contra la duración asignada y sugiere si es: HOLGADA (sobra ≥30%), AJUSTADA (±20%), CORTA (faltan 20-50%) o INSUFICIENTE (faltan >50%).\n4) Devuelve `suggested_minutes` (entero), `verdict` (uno de los 4 anteriores) y `explanation` con un resumen breve por tipo de pregunta y la justificación de la sugerencia.\n\nSé conservador: en exámenes la presión cognitiva agrega tiempo respecto a un taller. Los estudiantes promedio (no los más rápidos) deben poder terminar.	2026-05-08 04:09:30.448398+00	2026-05-08 04:09:30.448398+00	\N
\.


--
-- Data for Name: attendance_check_in_state; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."attendance_check_in_state" ("session_id", "seed", "rotation_seconds", "opened_at", "closes_at") FROM stdin;
\.


--
-- Data for Name: attendance_records; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."attendance_records" ("id", "session_id", "user_id", "status", "note", "created_at") FROM stdin;
f5f31d5b-a20f-47d0-bc59-a7c19ba9784d	69ac43da-85c8-42b9-bbbe-e4fa5c161583	dac41f00-64e7-40b8-a207-31f1ee2718c0	presente	\N	2026-05-07 21:24:49.751444+00
4704b124-6c97-44d1-b3ca-c0762efc34ad	69ac43da-85c8-42b9-bbbe-e4fa5c161583	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	presente	\N	2026-05-07 21:24:50.088849+00
c536e769-80b3-4fca-9ed8-3c5937b93d70	69ac43da-85c8-42b9-bbbe-e4fa5c161583	2b2cb673-f574-4f99-b152-c4f9c438ab0c	presente	\N	2026-05-07 21:24:50.305565+00
9c79f0b3-d249-4ba2-aa66-146ed15793da	69ac43da-85c8-42b9-bbbe-e4fa5c161583	e8b3c430-2162-413b-8560-9e3a43e3577e	presente	\N	2026-05-07 21:24:50.524832+00
5eecaee3-08e5-44ad-b562-9966ede12b45	69ac43da-85c8-42b9-bbbe-e4fa5c161583	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	presente	\N	2026-05-07 21:24:50.733929+00
6b0b07ce-ab17-4d44-bfd4-258ee1eafca9	69ac43da-85c8-42b9-bbbe-e4fa5c161583	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	presente	\N	2026-05-07 21:24:50.934346+00
02ca3d50-4764-4fc8-803f-fd7d984e9248	69ac43da-85c8-42b9-bbbe-e4fa5c161583	bce0ddee-4001-45e9-b323-719f80dc4f6d	presente	\N	2026-05-07 21:24:51.138022+00
6d3474b5-2a49-4d35-92df-ffffe0acd1a1	69ac43da-85c8-42b9-bbbe-e4fa5c161583	19e004a1-c1f2-4ca5-91d2-4c095058cb84	presente	\N	2026-05-07 21:24:51.335199+00
353ac65c-6c76-40ed-96e3-31c68b3740d4	69ac43da-85c8-42b9-bbbe-e4fa5c161583	e5d5a97e-19e2-42a9-88fa-916eba925885	presente	\N	2026-05-07 21:24:51.549582+00
24978887-c3b6-4e61-80dc-b1707d945af7	69ac43da-85c8-42b9-bbbe-e4fa5c161583	2d709409-7b44-403d-a315-b8bb826aa8ca	presente	\N	2026-05-07 21:24:51.74908+00
eacf1f3d-2987-41fa-8b88-58c84e77972c	69ac43da-85c8-42b9-bbbe-e4fa5c161583	531392ff-60c0-471d-af30-5e58bc80e860	presente	\N	2026-05-07 21:24:51.955454+00
db14d9dd-e792-4da4-a2c0-b3450e4b14d4	69ac43da-85c8-42b9-bbbe-e4fa5c161583	d048a636-8a14-4fcd-aa3e-891cca899b32	presente	\N	2026-05-07 21:24:52.168627+00
5100adde-3995-43fc-b165-c742158d3ca8	69ac43da-85c8-42b9-bbbe-e4fa5c161583	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	presente	\N	2026-05-07 21:24:52.376284+00
c838e98e-c858-4e04-a25a-6172a77db5dd	69ac43da-85c8-42b9-bbbe-e4fa5c161583	032a6335-5776-4677-8881-99db2cef9fe2	presente	\N	2026-05-07 21:24:52.580034+00
e7ea5ca5-f7cc-46ac-9c79-69f8af412f63	69ac43da-85c8-42b9-bbbe-e4fa5c161583	0a02892e-8476-44da-90e8-384c064e6040	presente	\N	2026-05-07 21:24:52.783577+00
3f2e825f-b24e-4ec9-b594-248999b1379b	69ac43da-85c8-42b9-bbbe-e4fa5c161583	4e923995-0e57-4430-a1d6-cca9b9261775	presente	\N	2026-05-07 21:24:52.994818+00
1107532e-a912-44ab-96ed-3c6fa4f9de08	69ac43da-85c8-42b9-bbbe-e4fa5c161583	0cf09e84-be38-4adf-8e74-44937461fc46	presente	\N	2026-05-07 21:24:53.214133+00
e9911251-1a9a-49a1-9122-a176b24d6489	69ac43da-85c8-42b9-bbbe-e4fa5c161583	9084565c-58dd-4e35-8793-a9cf198117b3	presente	\N	2026-05-07 21:24:53.424353+00
42edc878-c6a9-4894-bdb6-e77bef32a2bb	69ac43da-85c8-42b9-bbbe-e4fa5c161583	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	presente	\N	2026-05-07 21:24:53.61625+00
b7215275-a73e-4708-8696-e55792fa9cd5	9427ca32-4050-4a2d-a628-8560b316d1bf	032a6335-5776-4677-8881-99db2cef9fe2	presente	\N	2026-05-08 00:42:17.250682+00
a03ec653-574e-4bef-bf9b-fd1a26285cf6	9427ca32-4050-4a2d-a628-8560b316d1bf	dac41f00-64e7-40b8-a207-31f1ee2718c0	presente	\N	2026-05-08 00:42:51.272957+00
90adf691-216e-440f-a434-5a9bf115322e	9427ca32-4050-4a2d-a628-8560b316d1bf	0a02892e-8476-44da-90e8-384c064e6040	presente	\N	2026-05-08 00:43:34.476301+00
c9e4b77c-df5b-4f2e-8a53-b59f8d2d89b4	9427ca32-4050-4a2d-a628-8560b316d1bf	bce0ddee-4001-45e9-b323-719f80dc4f6d	presente	\N	2026-05-08 00:44:17.382524+00
9a622e0b-3210-4b66-8f68-e11abb4da4be	9427ca32-4050-4a2d-a628-8560b316d1bf	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	presente	\N	2026-05-08 00:43:30.918136+00
09bc7531-d7a7-4a08-8321-8587c1d1ba91	9427ca32-4050-4a2d-a628-8560b316d1bf	4e923995-0e57-4430-a1d6-cca9b9261775	presente	\N	2026-05-08 00:45:37.644801+00
9fba89a4-c47a-47bb-b6d2-3d0068d9d7fb	9427ca32-4050-4a2d-a628-8560b316d1bf	531392ff-60c0-471d-af30-5e58bc80e860	presente	\N	2026-05-08 00:45:50.571668+00
7a91febc-4bed-41af-a716-9a6b46f8949f	9427ca32-4050-4a2d-a628-8560b316d1bf	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	presente	\N	2026-05-08 00:46:05.851797+00
99de6bf1-2b22-489f-8a42-1409dfd0be9c	9427ca32-4050-4a2d-a628-8560b316d1bf	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	presente	\N	2026-05-08 00:46:43.566179+00
83dda032-a49b-4c04-824c-bbcb9b81b7b8	9427ca32-4050-4a2d-a628-8560b316d1bf	e8b3c430-2162-413b-8560-9e3a43e3577e	presente	\N	2026-05-08 00:46:53.915369+00
c325c24a-9d54-49d0-85d1-8ed3d9e9d696	9427ca32-4050-4a2d-a628-8560b316d1bf	2d709409-7b44-403d-a315-b8bb826aa8ca	presente	\N	2026-05-08 00:47:12.13558+00
df153bd6-c568-42f5-a19b-e97b85215338	9427ca32-4050-4a2d-a628-8560b316d1bf	19e004a1-c1f2-4ca5-91d2-4c095058cb84	presente	\N	2026-05-08 00:44:16.825164+00
b41dd2f8-12d1-43a7-a32b-b14be2b22f47	9427ca32-4050-4a2d-a628-8560b316d1bf	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	presente	\N	2026-05-08 00:49:33.107775+00
75babce8-c404-4d4c-a5bf-bde1367cc4b2	9427ca32-4050-4a2d-a628-8560b316d1bf	d048a636-8a14-4fcd-aa3e-891cca899b32	presente	\N	2026-05-08 00:49:39.987302+00
93fe97fc-5338-4456-ae48-0ea167bcf5b4	9427ca32-4050-4a2d-a628-8560b316d1bf	0cf09e84-be38-4adf-8e74-44937461fc46	presente	\N	2026-05-08 00:49:46.774306+00
\.


--
-- Data for Name: attendance_sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."attendance_sessions" ("id", "course_id", "session_date", "title", "created_by", "created_at", "check_in_open") FROM stdin;
69ac43da-85c8-42b9-bbbe-e4fa5c161583	0e375073-e9f2-4fda-a295-53407e3d5879	2026-04-01	Clase 1	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-05-07 21:24:45.316351+00	f
9427ca32-4050-4a2d-a628-8560b316d1bf	0e375073-e9f2-4fda-a295-53407e3d5879	2026-05-07	\N	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-05-07 07:47:39.208761+00	f
\.


--
-- Data for Name: code_executions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."code_executions" ("id", "submission_id", "question_id", "user_id", "language", "source_code", "stdin", "stdout", "stderr", "exit_code", "execution_time_ms", "status", "created_at") FROM stdin;
ac5e6a91-cce6-4e05-bf87-485100684c68	49a4b8f9-f667-4a4b-aefe-eb1c8123d8cd	6eb2087a-28da-4911-a1f5-1a56d72f4c7e	4e923995-0e57-4430-a1d6-cca9b9261775	java	class motor{\r\n    private string tipo;\r\n    private int potencia;\r\n    prblic motor (string tipo , int potencia){\r\n        this.tipo=tipo;\r\n        this potencia=potencia;\r\n    }\r\n    public string gettipo (){\r\n        return tipo;\r\n    }\r\n    public int getpotencia(){\r\n        return potencia\r\n    }\r\n    public void informacion(){\r\n        system.out.printIn ("TIPO DE MOTOR"+ tipo);\r\n         system.out.printIn ("POTENCIA "+ potencia);\r\n    }\r\n}\r\nclass vehiculo {\r\n    private Motor motor;\r\n    public vehiculo (string tipoMotor , int potencia){\r\n        this.motor=new Motor (tipoMotor,potencia);\r\n    }\r\n    public void mostar(){\r\n        motor.mostar();\r\n    }\r\n}\r\npublic class Main {\r\n    public static void main (string [] arg){\r\n        vehiculo v = new vehiculo (" gasolina ", 200);\r\n        v.mostar();\r\n    }\r\n}		[Simulación] Código java recibido (825 caracteres). Configure JDOODLE_CLIENT_ID para ejecución real.\n		0	100	completed	2026-05-01 01:10:49.641205+00
1b45159d-36b0-4614-b270-82d5f1c64a81	49a4b8f9-f667-4a4b-aefe-eb1c8123d8cd	6eb2087a-28da-4911-a1f5-1a56d72f4c7e	4e923995-0e57-4430-a1d6-cca9b9261775	java	class motor{\r\n    private string tipo;\r\n    private int potencia;\r\n    prblic motor (string tipo , int potencia){\r\n        this.tipo=tipo;\r\n        this potencia=potencia;\r\n    }\r\n    public string gettipo (){\r\n        return tipo;\r\n    }\r\n    public int getpotencia(){\r\n        return potencia\r\n    }\r\n    public void informacion(){\r\n        system.out.printIn ("TIPO DE MOTOR"+ tipo);\r\n         system.out.printIn ("POTENCIA "+ potencia);\r\n    }\r\n}\r\nclass vehiculo {\r\n    private Motor motor;\r\n    public vehiculo (string tipoMotor , int potencia){\r\n        this.motor=new Motor (tipoMotor,potencia);\r\n    }\r\n    public void mostar(){\r\n        motor.mostar();\r\n    }\r\n}\r\npublic class Main {\r\n    public static void main (string [] arg){\r\n        vehiculo v = new vehiculo (" gasolina ", 200);\r\n        v.mostar();\r\n    }\r\n}		[Simulación] Código java recibido (825 caracteres). Configure JDOODLE_CLIENT_ID para ejecución real.\n		0	100	completed	2026-05-01 01:11:08.159044+00
4cf7cf9f-9924-4f51-b3ea-77c46d2b497d	49a4b8f9-f667-4a4b-aefe-eb1c8123d8cd	6eb2087a-28da-4911-a1f5-1a56d72f4c7e	4e923995-0e57-4430-a1d6-cca9b9261775	java	class motor{\r\n    private string tipo;\r\n    private int potencia;\r\n    prblic motor (string tipo , int potencia){\r\n        this.tipo=tipo;\r\n        this potencia=potencia;\r\n    }\r\n    public string gettipo (){\r\n        return tipo;\r\n    }\r\n    public int getpotencia(){\r\n        return potencia\r\n    }\r\n    public void informacion(){\r\n        system.out.printIn ("TIPO DE MOTOR"+ tipo);\r\n         system.out.printIn ("POTENCIA "+ potencia);\r\n    }\r\n}\r\nclass vehiculo {\r\n    private Motor motor;\r\n    public vehiculo (string tipoMotor , int potencia){\r\n        this.motor=new Motor (tipoMotor,potencia);\r\n    }\r\n    public void mostar(){\r\n        motor.mostar();\r\n    }\r\n}\r\npublic class Main {\r\n    public static void main (string [] arg){\r\n        vehiculo v = new vehiculo (" gasolina ", 200);\r\n        v.mostar();\r\n    }\r\n}		[Simulación] Código java recibido (825 caracteres). Configure JDOODLE_CLIENT_ID para ejecución real.\n		0	100	completed	2026-05-01 01:11:26.260845+00
cf44a1dd-879a-40f9-81d3-2c80f16f83f0	f467f41a-aa10-49ce-acba-38fa6159f55a	6eb2087a-28da-4911-a1f5-1a56d72f4c7e	2b2cb673-f574-4f99-b152-c4f9c438ab0c	java	class Motor {\r\n    String type;\r\n    int potencia;\r\n    public Motor (String tipo, int potencia){\r\n        System.out.printil("Tipo de motor : " + tipo);\r\n        System.out.printil("Potencia : " + tipo);\r\n    }\r\n}\r\nclass Vehiculo {\r\n    Motor motor;\r\n    public Vehiculo(Motor motor){\r\n        this.motor=motor;\r\n    }\r\n    public void mostrarMotor(){\r\n        motor.mostrarMotor();\r\n    }\r\n}\r\n\r\npublic class Main{\r\n    public static void main(String[] args){\r\n        Motor motor = new \r\n        Motor("Gasolina", 130);\r\n        Vehiculo Vehiculo = new \r\n        Vehiculo(motor);\r\n        Vehiculo.mostrarMotor();\r\n    }\r\n}		[Simulación] Código java recibido (625 caracteres). Configure JDOODLE_CLIENT_ID para ejecución real.\n		0	100	completed	2026-05-01 01:12:22.564764+00
b9d76bc2-130c-45d2-9478-b97c16226a70	47088e95-0dca-49ac-a217-8d5ce1a44931	6eb2087a-28da-4911-a1f5-1a56d72f4c7e	2d709409-7b44-403d-a315-b8bb826aa8ca	java	class Motor{\r\n    public String tipo;\r\n    public int potencia;\r\n    public Motor {\r\n        this.tipo = tipo;\r\n        this.potencia = potencia;\r\n    }\r\n    public String getTipo(){return tipo;}\r\n    public int getPontencia(){return potencia;}\r\n}\r\npublic class vehiculo{\r\n    private Motor motor;\r\n\r\n}			Error: No se encontró el método main. Asegúrate de incluir 'public static void main(String[] args)'.	1	50	error	2026-05-01 01:12:29.819791+00
1020d4c4-4c59-4df1-9c5d-2319b61dcec4	fa2bef15-a9ca-4f61-85b7-9ae629f015a4	6eb2087a-28da-4911-a1f5-1a56d72f4c7e	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	java	class Motor {\r\n    private String tipo;\r\n    private int potencia;\r\n\r\n    public Motor (String tipo, int potencia){\r\n        this.tipo = tipo;\r\n        this.potencia = potencia;\r\n    }\r\n    public String getTipo(){\r\n        return tipo;\r\n    }\r\n    public int getPotencia(){\r\n        return potencia;\r\n    }\r\n    public void mostrarInfo(){\r\n        System.out.println("Tipo de motor: "+ tipo);\r\n        System.out.println("potencia: " + potencia + "HP");\r\n    }\r\n}			Error: No se encontró el método main. Asegúrate de incluir 'public static void main(String[] args)'.	1	50	error	2026-05-01 01:12:54.455792+00
3ecf4f0b-2f9b-44fd-b7aa-73e59bcbf387	c7026ae1-c2dc-4882-8993-fa68f829f5cd	6eb2087a-28da-4911-a1f5-1a56d72f4c7e	0a02892e-8476-44da-90e8-384c064e6040	java	class Motor{\r\n\r\n    private String Tipo;\r\n    private int Potencia;\r\n    \r\n    public Motor(String Tipo, int Potencia){\r\n        this.Tipo = Tipo;\r\n        this.Potencia = Potencia\r\n    }\r\n\r\n    public String getTipo(){\r\n        return Tipo;\r\n    }\r\n\r\n    public int getPotencia(){\r\n        return Potencia;\r\n    }\r\n}\r\n\r\nclass Vehiculo{\r\n    private Motor motor;\r\n\r\n    public Vehiculo(String tipoMotor, int potenciaMotor){\r\n        this.motor = new Motor(tipoMotor, potenciaMotor);\r\n    }\r\n    public void informacionMotor{\r\n        System.out.println("Tipo de motor: " + motor.getTipo());\r\n        System.out.println("Potencia del motor: " + motor.getPotencia() + "HP");\r\n    }\r\n    public static void main(String[] args){\r\n        Vehiculo auto = new Vehiculo("gasolina", 150);\r\n        auto.informacionMotor();\r\n    }\r\n}		Potencia del motor: " + motor.getPotencia() + "HP\n		0	100	completed	2026-05-01 01:14:49.665537+00
\.


--
-- Data for Name: course_enrollments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."course_enrollments" ("id", "course_id", "user_id", "created_at") FROM stdin;
2391c2a4-0138-4601-ac63-146a91d00516	c0eee9f7-9d38-4208-9a89-01e0a2af1de1	9084565c-58dd-4e35-8793-a9cf198117b3	2026-05-05 03:08:47.843382+00
18c59e01-736c-47b1-9566-45631c64defc	0e375073-e9f2-4fda-a295-53407e3d5879	9084565c-58dd-4e35-8793-a9cf198117b3	2026-05-05 03:59:27.525889+00
df2f2b32-e544-402a-9c5a-d8dd82f55d7f	1c434f52-c2f5-4e45-92f0-e6a67511165f	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-05-08 00:46:13.569303+00
a4402d25-177c-4ecc-9ec1-36e1da6f11c3	0e375073-e9f2-4fda-a295-53407e3d5879	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-04-26 02:48:42.54119+00
76174e35-2ac8-4454-bf37-65c1e505ed1c	3bc78e41-0ebb-44a0-8ee5-117cc1e13ac4	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-05-08 00:46:15.050584+00
497ee34e-2250-4e4a-84ed-e6c0f75657eb	0e375073-e9f2-4fda-a295-53407e3d5879	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	2026-04-26 04:19:11.445107+00
d39f5e21-60f0-46c6-b49a-fb89c1d40f71	0e375073-e9f2-4fda-a295-53407e3d5879	0cf09e84-be38-4adf-8e74-44937461fc46	2026-04-26 04:19:12.046804+00
75db93a8-9304-45fd-8d3c-9d8f68da9378	0e375073-e9f2-4fda-a295-53407e3d5879	4e923995-0e57-4430-a1d6-cca9b9261775	2026-04-26 04:19:12.528027+00
36496a3f-df16-4d2a-b869-c49e1ddae38c	0e375073-e9f2-4fda-a295-53407e3d5879	0a02892e-8476-44da-90e8-384c064e6040	2026-04-26 04:19:12.969889+00
c461b27b-6a61-4cf3-a0a5-504711949565	0e375073-e9f2-4fda-a295-53407e3d5879	032a6335-5776-4677-8881-99db2cef9fe2	2026-04-26 04:19:13.428011+00
bfc57536-df5d-4a3b-a89a-3edc6dceaebe	0e375073-e9f2-4fda-a295-53407e3d5879	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	2026-04-26 04:19:13.868056+00
911e6328-271a-4c10-ad1f-2095a6388d95	0e375073-e9f2-4fda-a295-53407e3d5879	d048a636-8a14-4fcd-aa3e-891cca899b32	2026-04-26 04:19:14.316503+00
95acf799-2c27-483f-a832-697d897105d2	0e375073-e9f2-4fda-a295-53407e3d5879	531392ff-60c0-471d-af30-5e58bc80e860	2026-04-26 04:19:14.764143+00
2153db03-cf7c-4ff0-a3be-26b7e62bfb68	0e375073-e9f2-4fda-a295-53407e3d5879	2d709409-7b44-403d-a315-b8bb826aa8ca	2026-04-26 04:19:15.19079+00
ffbb773b-bf43-45f2-b671-4ab01f2c797e	0e375073-e9f2-4fda-a295-53407e3d5879	e5d5a97e-19e2-42a9-88fa-916eba925885	2026-04-26 04:19:15.675828+00
01533e39-0f2e-4f11-9827-5310e95d2109	0e375073-e9f2-4fda-a295-53407e3d5879	19e004a1-c1f2-4ca5-91d2-4c095058cb84	2026-04-26 04:19:16.126721+00
0181ba44-ddac-4e62-bd9e-a40e9803873a	0e375073-e9f2-4fda-a295-53407e3d5879	bce0ddee-4001-45e9-b323-719f80dc4f6d	2026-04-26 04:19:16.592007+00
7f5f699c-3ca2-4b6f-9992-72d50ddcd8d7	0e375073-e9f2-4fda-a295-53407e3d5879	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	2026-04-26 04:19:17.06412+00
6666524c-1a6d-4676-b339-ab020ba56169	0e375073-e9f2-4fda-a295-53407e3d5879	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	2026-04-26 04:19:17.539317+00
43802d5b-6e08-4889-a936-3d13b6d7e1f0	0e375073-e9f2-4fda-a295-53407e3d5879	2b2cb673-f574-4f99-b152-c4f9c438ab0c	2026-04-26 04:19:17.992531+00
fc5b26b1-8a91-4ba7-a619-4a15fd3703bc	0e375073-e9f2-4fda-a295-53407e3d5879	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	2026-04-26 04:19:18.4197+00
a7b915f0-00f9-40fc-be7c-50691dff43b4	0e375073-e9f2-4fda-a295-53407e3d5879	dac41f00-64e7-40b8-a207-31f1ee2718c0	2026-04-26 04:19:18.878929+00
f8775d5c-9d68-4ebc-a455-4495f82474f3	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-04-26 16:00:01.378558+00
e576e35d-ca58-49cc-868c-b2f91c1dbd5e	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	2026-04-26 16:00:01.378558+00
a172f7aa-1811-43db-ae2e-dfd85b443062	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	0cf09e84-be38-4adf-8e74-44937461fc46	2026-04-26 16:00:01.378558+00
df135815-9925-4358-bea2-0f5d0ea95a5b	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	4e923995-0e57-4430-a1d6-cca9b9261775	2026-04-26 16:00:01.378558+00
f8727131-c962-41c9-9e09-6e7303d069ce	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	0a02892e-8476-44da-90e8-384c064e6040	2026-04-26 16:00:01.378558+00
0fa4ee61-6956-4554-a25a-f6d0eaa1781b	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	032a6335-5776-4677-8881-99db2cef9fe2	2026-04-26 16:00:01.378558+00
81dd2c01-dcbc-43e3-85cd-c1a6c5e54ece	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	2026-04-26 16:00:01.378558+00
22f2bf4e-2b03-4477-92a2-584601ef304c	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	d048a636-8a14-4fcd-aa3e-891cca899b32	2026-04-26 16:00:01.378558+00
d06c0df5-49e6-4b45-8562-97a92dd6ea5b	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	531392ff-60c0-471d-af30-5e58bc80e860	2026-04-26 16:00:01.378558+00
d9cfd19f-18e7-4094-a37c-61e7cb68c615	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	2d709409-7b44-403d-a315-b8bb826aa8ca	2026-04-26 16:00:01.378558+00
615ce53e-64c2-430c-8de2-d73a852622f9	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	e5d5a97e-19e2-42a9-88fa-916eba925885	2026-04-26 16:00:01.378558+00
5187c4f6-3ee3-42b8-8b84-aa91884533ed	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	19e004a1-c1f2-4ca5-91d2-4c095058cb84	2026-04-26 16:00:01.378558+00
82b1ee91-4e75-435c-8eab-f283a506f610	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	bce0ddee-4001-45e9-b323-719f80dc4f6d	2026-04-26 16:00:01.378558+00
8d935f28-a235-4c3b-a84c-9067d384f3a3	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	2026-04-26 16:00:01.378558+00
6065709b-34e6-40d7-bd17-70a2879e9fda	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	2026-04-26 16:00:01.378558+00
dd208170-6975-4572-9cea-5643c4bf7275	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	2b2cb673-f574-4f99-b152-c4f9c438ab0c	2026-04-26 16:00:01.378558+00
bd6eb7f3-4ad4-4bf1-9629-47a91f9a4e49	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	2026-04-26 16:00:01.378558+00
d13bf367-30e8-4f82-aed5-c1b7a91e2836	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	dac41f00-64e7-40b8-a207-31f1ee2718c0	2026-04-26 16:00:01.378558+00
523683d9-3c0c-43a9-85d6-26f32da8d4b1	c0eee9f7-9d38-4208-9a89-01e0a2af1de1	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-05-03 23:41:36.726649+00
\.


--
-- Data for Name: course_grading_config; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."course_grading_config" ("course_id", "final_project_weight", "coursework_weight", "updated_at") FROM stdin;
\.


--
-- Data for Name: course_grading_weights; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."course_grading_weights" ("id", "course_id", "component", "weight", "created_at") FROM stdin;
\.


--
-- Data for Name: course_teachers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."course_teachers" ("id", "course_id", "user_id", "created_at") FROM stdin;
8591f4cb-7e0d-4fe4-84ba-542cc142d28e	0e375073-e9f2-4fda-a295-53407e3d5879	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-04-26 16:14:55.251317+00
4c015fdf-12c4-434e-a5e3-bc5a83fe93c7	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-04-26 16:14:59.514442+00
065282a6-231e-456e-8b9b-fe9c466b1ba1	c0eee9f7-9d38-4208-9a89-01e0a2af1de1	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-05-03 23:41:23.604797+00
\.


--
-- Data for Name: courses; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."courses" ("id", "name", "description", "created_at", "updated_at", "period", "start_date", "end_date", "grade_scale_min", "grade_scale_max", "exam_weight", "workshop_weight", "passing_grade", "attendance_weight", "language", "max_exam_attempts", "project_weight") FROM stdin;
c0eee9f7-9d38-4208-9a89-01e0a2af1de1	Pruebas	UNIAJ 2026-1	2026-05-03 23:41:17.144503+00	2026-05-03 23:41:17.144503+00	2026-1	2026-03-04	2026-06-17	0	5	35	20	3	25	es	1	20
0e375073-e9f2-4fda-a295-53407e3d5879	Programación II	UNIAJ 2026-1	2026-04-26 02:48:39.457008+00	2026-05-07 22:08:03.098419+00	2026-1	2026-03-04	2026-06-17	0	5	35	20	3	25	es	1	20
1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	Seminario de Sistemas	UNIAJ 2026-1	2026-04-26 16:00:00.550921+00	2026-05-07 22:10:43.990222+00	2026-1	2026-03-04	2026-06-17	0	5	35	20	3	25	es	1	20
1c434f52-c2f5-4e45-92f0-e6a67511165f	Trabajo Integrador I	\N	2026-05-08 00:46:11.871882+00	2026-05-08 00:46:11.871882+00	\N	\N	\N	0	5	50	50	3	0	es	1	0
3bc78e41-0ebb-44a0-8ee5-117cc1e13ac4	Bases de Datos	\N	2026-05-08 00:46:12.218875+00	2026-05-08 00:46:12.218875+00	\N	\N	\N	0	5	50	50	3	0	es	1	0
\.


--
-- Data for Name: exam_assignments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."exam_assignments" ("id", "exam_id", "user_id", "created_at") FROM stdin;
48b55330-a9b5-4442-80f7-d425b4680355	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-05-01 00:46:17.20483+00
6bef50a7-a537-4c44-a362-cbab909b5f01	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	2026-05-01 00:46:17.20483+00
46a2e191-b671-4b29-adb8-6d1af5215e8e	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	0cf09e84-be38-4adf-8e74-44937461fc46	2026-05-01 00:46:17.20483+00
475c1422-8f17-4f6a-ac8c-b14e2dc98fbe	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	4e923995-0e57-4430-a1d6-cca9b9261775	2026-05-01 00:46:17.20483+00
39e5317f-2a75-47ad-bbaf-8c8e68e1682a	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	0a02892e-8476-44da-90e8-384c064e6040	2026-05-01 00:46:17.20483+00
ecc05c74-c16e-4cdc-93f8-93b19df33cc9	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	032a6335-5776-4677-8881-99db2cef9fe2	2026-05-01 00:46:17.20483+00
789d6d2a-b2c3-472c-9908-acf78e62c328	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	2026-05-01 00:46:17.20483+00
db8ccf4a-54c4-4b72-91dd-9dafacfbcb55	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	d048a636-8a14-4fcd-aa3e-891cca899b32	2026-05-01 00:46:17.20483+00
a3c0662c-0e3f-4f04-b38c-22b3d0a806d1	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	531392ff-60c0-471d-af30-5e58bc80e860	2026-05-01 00:46:17.20483+00
f0823174-7e69-4bdc-96a0-85277cb2f4c7	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	2d709409-7b44-403d-a315-b8bb826aa8ca	2026-05-01 00:46:17.20483+00
f4785b9c-78eb-4161-802c-67722646af8f	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	e5d5a97e-19e2-42a9-88fa-916eba925885	2026-05-01 00:46:17.20483+00
44260876-ad02-4f76-af57-943a6f359130	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	19e004a1-c1f2-4ca5-91d2-4c095058cb84	2026-05-01 00:46:17.20483+00
cd8aa144-cfde-4075-b116-607a8eb0346e	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	bce0ddee-4001-45e9-b323-719f80dc4f6d	2026-05-01 00:46:17.20483+00
b2fd5d31-06d1-4218-886f-d51163d91343	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	2026-05-01 00:46:17.20483+00
8aa70eea-7808-4a66-9b4c-751bb00284a3	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	2026-05-01 00:46:17.20483+00
c775db25-9f62-4cfa-af50-7c3565fac958	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	2b2cb673-f574-4f99-b152-c4f9c438ab0c	2026-05-01 00:46:17.20483+00
e4485366-f516-4e00-986a-313ad7198ad2	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	2026-05-01 00:46:17.20483+00
66b083d7-9b98-4995-b885-a6b986b53b19	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	dac41f00-64e7-40b8-a207-31f1ee2718c0	2026-05-01 00:46:17.20483+00
f4df678d-b5dc-40b7-964b-716d1a4338d5	e3a8370d-66de-4a14-bf5d-762309aa7d99	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	2026-05-03 17:52:57.549688+00
a114be5c-0384-4c7a-b084-624bc08b93a2	e3a8370d-66de-4a14-bf5d-762309aa7d99	0cf09e84-be38-4adf-8e74-44937461fc46	2026-05-03 17:52:57.549688+00
7dcf2781-21cf-4bdc-98a5-c8374c866139	e3a8370d-66de-4a14-bf5d-762309aa7d99	4e923995-0e57-4430-a1d6-cca9b9261775	2026-05-03 17:52:57.549688+00
f158d84b-00dd-46dd-ad32-a0941f5ddd40	e3a8370d-66de-4a14-bf5d-762309aa7d99	0a02892e-8476-44da-90e8-384c064e6040	2026-05-03 17:52:57.549688+00
699f630f-2bbe-40b0-8fb7-ad82cb21daef	e3a8370d-66de-4a14-bf5d-762309aa7d99	032a6335-5776-4677-8881-99db2cef9fe2	2026-05-03 17:52:57.549688+00
7495f787-800e-41d2-842b-c955d6d8fb29	e3a8370d-66de-4a14-bf5d-762309aa7d99	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	2026-05-03 17:52:57.549688+00
32768970-fb77-44c8-905e-74661e592b47	e3a8370d-66de-4a14-bf5d-762309aa7d99	d048a636-8a14-4fcd-aa3e-891cca899b32	2026-05-03 17:52:57.549688+00
18a4b039-5945-405b-9118-589bf10d0fe2	e3a8370d-66de-4a14-bf5d-762309aa7d99	531392ff-60c0-471d-af30-5e58bc80e860	2026-05-03 17:52:57.549688+00
7baaf96a-978a-4678-ad9f-7ebf0ccd7e32	e3a8370d-66de-4a14-bf5d-762309aa7d99	2d709409-7b44-403d-a315-b8bb826aa8ca	2026-05-03 17:52:57.549688+00
86ce247f-4fab-4e44-8e4b-2cc51e39ea25	e3a8370d-66de-4a14-bf5d-762309aa7d99	e5d5a97e-19e2-42a9-88fa-916eba925885	2026-05-03 17:52:57.549688+00
a147f115-4d5f-4512-bffb-5fd0ca266bd5	e3a8370d-66de-4a14-bf5d-762309aa7d99	19e004a1-c1f2-4ca5-91d2-4c095058cb84	2026-05-03 17:52:57.549688+00
e3eca118-50e8-4d2d-b3d7-fee4e5bd643f	e3a8370d-66de-4a14-bf5d-762309aa7d99	bce0ddee-4001-45e9-b323-719f80dc4f6d	2026-05-03 17:52:57.549688+00
f637e5ce-e56b-4d1b-855a-78de94166b6a	e3a8370d-66de-4a14-bf5d-762309aa7d99	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	2026-05-03 17:52:57.549688+00
9d8d8f3c-f7b2-4ea6-a8d7-6a1093907430	e3a8370d-66de-4a14-bf5d-762309aa7d99	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	2026-05-03 17:52:57.549688+00
0e439e9b-e580-4331-96a4-edd90e44d474	e3a8370d-66de-4a14-bf5d-762309aa7d99	2b2cb673-f574-4f99-b152-c4f9c438ab0c	2026-05-03 17:52:57.549688+00
5e534626-01f9-4521-abbe-42204d3bd4bb	e3a8370d-66de-4a14-bf5d-762309aa7d99	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	2026-05-03 17:52:57.549688+00
72fb3454-7da8-48ee-9820-2fbd2101ebec	e3a8370d-66de-4a14-bf5d-762309aa7d99	dac41f00-64e7-40b8-a207-31f1ee2718c0	2026-05-03 17:52:57.549688+00
963850d9-a4e9-4967-a18f-d3a3cda1dc28	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-05-03 23:41:57.954125+00
5054fde1-6d39-4e35-b089-08e58d2e881d	2c29880e-df95-4650-9653-3f6b72cc7632	9084565c-58dd-4e35-8793-a9cf198117b3	2026-05-05 03:09:14.470501+00
5fcdf580-22b4-4930-83db-437aa22631e3	9ab4413a-f0e3-448d-a070-536cc466197e	9084565c-58dd-4e35-8793-a9cf198117b3	2026-05-06 16:56:17.623177+00
964f79de-53d7-4949-aa5b-405aae1a7618	9ab4413a-f0e3-448d-a070-536cc466197e	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-05-06 16:56:17.623177+00
5eb75afa-d8c1-44b6-805c-a9c256cae39d	9ab4413a-f0e3-448d-a070-536cc466197e	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	2026-05-06 16:56:17.623177+00
ed456590-fc55-48f1-80a0-655db46614a5	9ab4413a-f0e3-448d-a070-536cc466197e	0cf09e84-be38-4adf-8e74-44937461fc46	2026-05-06 16:56:17.623177+00
00516a1f-ae82-4cb8-8aae-69cd63b34844	9ab4413a-f0e3-448d-a070-536cc466197e	4e923995-0e57-4430-a1d6-cca9b9261775	2026-05-06 16:56:17.623177+00
76a45383-1178-4599-9e95-45bcb7368205	9ab4413a-f0e3-448d-a070-536cc466197e	0a02892e-8476-44da-90e8-384c064e6040	2026-05-06 16:56:17.623177+00
0dd66131-aea6-496a-9bf9-c42c12d26999	9ab4413a-f0e3-448d-a070-536cc466197e	032a6335-5776-4677-8881-99db2cef9fe2	2026-05-06 16:56:17.623177+00
9613a3d0-2e9d-41fa-8019-4b9c19293fa8	9ab4413a-f0e3-448d-a070-536cc466197e	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	2026-05-06 16:56:17.623177+00
62f287c9-8f77-49c4-8274-c7d64e5ddf27	9ab4413a-f0e3-448d-a070-536cc466197e	d048a636-8a14-4fcd-aa3e-891cca899b32	2026-05-06 16:56:17.623177+00
c2f99b31-ee0a-4827-b0fd-139beec10384	9ab4413a-f0e3-448d-a070-536cc466197e	531392ff-60c0-471d-af30-5e58bc80e860	2026-05-06 16:56:17.623177+00
7dd4fe91-7b9b-4a3b-9180-2e35b83df863	9ab4413a-f0e3-448d-a070-536cc466197e	2d709409-7b44-403d-a315-b8bb826aa8ca	2026-05-06 16:56:17.623177+00
d70815b7-e92b-4ee7-bcdb-027f26835a71	9ab4413a-f0e3-448d-a070-536cc466197e	e5d5a97e-19e2-42a9-88fa-916eba925885	2026-05-06 16:56:17.623177+00
9c55cea8-6ca2-4ae6-9f76-be57c33a87e6	9ab4413a-f0e3-448d-a070-536cc466197e	19e004a1-c1f2-4ca5-91d2-4c095058cb84	2026-05-06 16:56:17.623177+00
ac9dc390-e0fd-4805-8381-bfe100beec8b	9ab4413a-f0e3-448d-a070-536cc466197e	bce0ddee-4001-45e9-b323-719f80dc4f6d	2026-05-06 16:56:17.623177+00
1bea69b3-f2b2-4a4b-b6a7-ca1aa64b38ec	9ab4413a-f0e3-448d-a070-536cc466197e	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	2026-05-06 16:56:17.623177+00
d18ae8ae-934b-457c-82e2-c9f2c21f2ed4	9ab4413a-f0e3-448d-a070-536cc466197e	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	2026-05-06 16:56:17.623177+00
5f7fd76a-10ce-40a5-8386-5ca23df9dfb4	9ab4413a-f0e3-448d-a070-536cc466197e	2b2cb673-f574-4f99-b152-c4f9c438ab0c	2026-05-06 16:56:17.623177+00
d557898a-8d2e-4df0-be7f-fd6e78294779	9ab4413a-f0e3-448d-a070-536cc466197e	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	2026-05-06 16:56:17.623177+00
28e1f012-3b5d-49e5-8a8f-10e1f0ace76c	9ab4413a-f0e3-448d-a070-536cc466197e	dac41f00-64e7-40b8-a207-31f1ee2718c0	2026-05-06 16:56:17.623177+00
1a431e03-684e-4239-bf85-1b0f1e4cd279	2cb32a39-c941-4db8-bc80-b43f884b6ad2	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-05-06 22:22:18.066461+00
aa465015-6879-450f-b673-624530558c51	2cb32a39-c941-4db8-bc80-b43f884b6ad2	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	2026-05-06 22:22:18.066461+00
8bc8711a-ec3b-4fbb-8728-7f5deaf80159	2cb32a39-c941-4db8-bc80-b43f884b6ad2	4e923995-0e57-4430-a1d6-cca9b9261775	2026-05-06 22:22:18.066461+00
d9acf21d-e51d-4ee5-bf3b-5485d526b0fc	2cb32a39-c941-4db8-bc80-b43f884b6ad2	0a02892e-8476-44da-90e8-384c064e6040	2026-05-06 22:22:18.066461+00
ba4f44b1-e2c5-4c31-bf83-0ad3e7e5bfde	2cb32a39-c941-4db8-bc80-b43f884b6ad2	032a6335-5776-4677-8881-99db2cef9fe2	2026-05-06 22:22:18.066461+00
926a65c6-3dc7-4289-9d2e-4d998d4f9706	2cb32a39-c941-4db8-bc80-b43f884b6ad2	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	2026-05-06 22:22:18.066461+00
5427c1f1-0fda-4fce-85fb-788a9478885f	2cb32a39-c941-4db8-bc80-b43f884b6ad2	d048a636-8a14-4fcd-aa3e-891cca899b32	2026-05-06 22:22:18.066461+00
9222c0a8-2611-41ce-945d-11dc20fcf327	2cb32a39-c941-4db8-bc80-b43f884b6ad2	531392ff-60c0-471d-af30-5e58bc80e860	2026-05-06 22:22:18.066461+00
169b50ae-72c5-463c-b78c-e143343b7b25	2cb32a39-c941-4db8-bc80-b43f884b6ad2	2d709409-7b44-403d-a315-b8bb826aa8ca	2026-05-06 22:22:18.066461+00
0605bfda-69d5-4886-897b-878ac47b7ba7	2cb32a39-c941-4db8-bc80-b43f884b6ad2	e5d5a97e-19e2-42a9-88fa-916eba925885	2026-05-06 22:22:18.066461+00
824ff435-3266-44ba-bd43-ab87011e161f	2cb32a39-c941-4db8-bc80-b43f884b6ad2	19e004a1-c1f2-4ca5-91d2-4c095058cb84	2026-05-06 22:22:18.066461+00
0571fd16-1719-4dcb-bef1-2571c5d4cc0b	2cb32a39-c941-4db8-bc80-b43f884b6ad2	bce0ddee-4001-45e9-b323-719f80dc4f6d	2026-05-06 22:22:18.066461+00
424ad663-faf3-41c2-8983-ab54e9fb11d3	2cb32a39-c941-4db8-bc80-b43f884b6ad2	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	2026-05-06 22:22:18.066461+00
3bc6da8a-29d7-42ca-907a-4fba3fc71530	2cb32a39-c941-4db8-bc80-b43f884b6ad2	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	2026-05-06 22:22:18.066461+00
9f9c32df-1e61-460a-b49c-f2e9ffda390e	2cb32a39-c941-4db8-bc80-b43f884b6ad2	2b2cb673-f574-4f99-b152-c4f9c438ab0c	2026-05-06 22:22:18.066461+00
c2b175f6-d7a4-429d-ac35-4f80fd98af6e	2cb32a39-c941-4db8-bc80-b43f884b6ad2	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	2026-05-06 22:22:18.066461+00
0568bc9c-3f7e-4675-b4d0-7790758a3573	2cb32a39-c941-4db8-bc80-b43f884b6ad2	dac41f00-64e7-40b8-a207-31f1ee2718c0	2026-05-06 22:22:18.066461+00
be06bdcc-9a02-4530-a80f-41653fb71227	2cb32a39-c941-4db8-bc80-b43f884b6ad2	0cf09e84-be38-4adf-8e74-44937461fc46	2026-05-06 22:22:18.066461+00
5db0caf7-9577-4b9f-8030-66692345e1a5	d8df0c5f-2fea-4abc-97d1-983118d93068	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-05-07 17:26:53.378856+00
193730e4-9fbd-44b1-91b6-4d982f3088df	d8df0c5f-2fea-4abc-97d1-983118d93068	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	2026-05-07 17:26:53.378856+00
b770684d-d8e6-4c53-a66b-085ce7ecb52b	d8df0c5f-2fea-4abc-97d1-983118d93068	0cf09e84-be38-4adf-8e74-44937461fc46	2026-05-07 17:26:53.378856+00
a577fe6e-2f86-48fa-b131-a83888021ab3	d8df0c5f-2fea-4abc-97d1-983118d93068	4e923995-0e57-4430-a1d6-cca9b9261775	2026-05-07 17:26:53.378856+00
b0bc3867-01af-4f20-a659-6450e93fa81f	d8df0c5f-2fea-4abc-97d1-983118d93068	0a02892e-8476-44da-90e8-384c064e6040	2026-05-07 17:26:53.378856+00
2a4d88a2-d7f9-4f64-a5bb-babcbedeb717	d8df0c5f-2fea-4abc-97d1-983118d93068	032a6335-5776-4677-8881-99db2cef9fe2	2026-05-07 17:26:53.378856+00
14e78dfa-e2c9-4c39-aff4-caa5c235ea55	d8df0c5f-2fea-4abc-97d1-983118d93068	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	2026-05-07 17:26:53.378856+00
3be365dc-91c9-4020-b533-00462dc69dab	d8df0c5f-2fea-4abc-97d1-983118d93068	d048a636-8a14-4fcd-aa3e-891cca899b32	2026-05-07 17:26:53.378856+00
7971cd1e-21db-4935-bcca-4f40c4bdb5c8	d8df0c5f-2fea-4abc-97d1-983118d93068	531392ff-60c0-471d-af30-5e58bc80e860	2026-05-07 17:26:53.378856+00
c627329a-304a-450e-aeeb-541271fbedd6	d8df0c5f-2fea-4abc-97d1-983118d93068	2d709409-7b44-403d-a315-b8bb826aa8ca	2026-05-07 17:26:53.378856+00
8d3dcdad-22d7-4f12-b923-afd49215faa7	d8df0c5f-2fea-4abc-97d1-983118d93068	e5d5a97e-19e2-42a9-88fa-916eba925885	2026-05-07 17:26:53.378856+00
ef8b3814-3dee-486b-a11c-a1df8c0b522a	d8df0c5f-2fea-4abc-97d1-983118d93068	19e004a1-c1f2-4ca5-91d2-4c095058cb84	2026-05-07 17:26:53.378856+00
d0e36e74-bf78-4360-a39e-d96dfbc83a85	d8df0c5f-2fea-4abc-97d1-983118d93068	bce0ddee-4001-45e9-b323-719f80dc4f6d	2026-05-07 17:26:53.378856+00
173f0862-faa3-4016-80b3-8c0f4d659fdd	d8df0c5f-2fea-4abc-97d1-983118d93068	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	2026-05-07 17:26:53.378856+00
b3cd3af1-f9c5-4489-8f4a-2ed05ca53e4e	d8df0c5f-2fea-4abc-97d1-983118d93068	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	2026-05-07 17:26:53.378856+00
d2f367da-2d1b-496a-b94e-38c7ed019648	d8df0c5f-2fea-4abc-97d1-983118d93068	2b2cb673-f574-4f99-b152-c4f9c438ab0c	2026-05-07 17:26:53.378856+00
4459d618-7762-4042-8af7-344be49677c1	d8df0c5f-2fea-4abc-97d1-983118d93068	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	2026-05-07 17:26:53.378856+00
14557fab-1d8c-47a4-8f6a-b9b140ec07d3	d8df0c5f-2fea-4abc-97d1-983118d93068	dac41f00-64e7-40b8-a207-31f1ee2718c0	2026-05-07 17:26:53.378856+00
ab1887ed-159a-4099-906e-854a8236e438	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	9084565c-58dd-4e35-8793-a9cf198117b3	2026-05-08 01:02:03.851816+00
926fd751-1e9e-4cce-b610-2ee13b35bad6	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-05-08 01:02:03.851816+00
91dbe395-2e72-4e4f-a344-98b645bda065	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	2026-05-08 01:02:03.851816+00
82202bcf-ddbc-4790-944d-3e639990eba3	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	0cf09e84-be38-4adf-8e74-44937461fc46	2026-05-08 01:02:03.851816+00
bf8e41f3-679a-47b5-b4b0-eea9680d42e6	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	4e923995-0e57-4430-a1d6-cca9b9261775	2026-05-08 01:02:03.851816+00
fdc859e6-b6f2-4f86-b65b-84cbef9bb67a	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	0a02892e-8476-44da-90e8-384c064e6040	2026-05-08 01:02:03.851816+00
77c73bdb-8917-4aea-a504-9cd7df223851	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	032a6335-5776-4677-8881-99db2cef9fe2	2026-05-08 01:02:03.851816+00
ce7e4385-c351-4ebc-9b2f-de42bca56c1c	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	2026-05-08 01:02:03.851816+00
e32265ce-e7df-46ed-a794-57e5f65fc02b	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	d048a636-8a14-4fcd-aa3e-891cca899b32	2026-05-08 01:02:03.851816+00
29fa453f-55dc-420f-96e4-788ddb2f6180	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	531392ff-60c0-471d-af30-5e58bc80e860	2026-05-08 01:02:03.851816+00
27e393f5-cc9e-4237-badf-4a716ed82a45	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	2d709409-7b44-403d-a315-b8bb826aa8ca	2026-05-08 01:02:03.851816+00
86797423-adf4-422a-b55f-e8c94a35072d	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	e5d5a97e-19e2-42a9-88fa-916eba925885	2026-05-08 01:02:03.851816+00
de70fca8-2948-4dd1-983b-87f7e026dfd6	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	19e004a1-c1f2-4ca5-91d2-4c095058cb84	2026-05-08 01:02:03.851816+00
5a894a04-696f-481b-b70a-25d2125001ad	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	bce0ddee-4001-45e9-b323-719f80dc4f6d	2026-05-08 01:02:03.851816+00
9e6499e3-6470-43f1-97ba-6ce8ac7d5722	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	2026-05-08 01:02:03.851816+00
275350de-41a2-47f6-93bd-91a9225e8d85	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	2026-05-08 01:02:03.851816+00
092f0a6f-8c5d-46a7-9484-baa17ac2135f	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	2b2cb673-f574-4f99-b152-c4f9c438ab0c	2026-05-08 01:02:03.851816+00
c61b273d-b4e7-4eb2-a6f3-c8d7c69f3c18	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	2026-05-08 01:02:03.851816+00
3c4e0f2e-20d2-409e-bb82-9c0c7880d22c	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	dac41f00-64e7-40b8-a207-31f1ee2718c0	2026-05-08 01:02:03.851816+00
\.


--
-- Data for Name: exam_notes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."exam_notes" ("id", "exam_id", "user_id", "content", "status", "rejection_reason", "reviewed_by", "reviewed_at", "created_at", "updated_at") FROM stdin;
c0c65560-fd6b-4913-84e5-812f09e9f0a7	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	e8b3c430-2162-413b-8560-9e3a43e3577e	--- o -> estoaa	rechazada	aa	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-05-01 02:45:40.061+00	2026-05-01 00:56:12.651512+00	2026-05-01 02:45:40.59933+00
74ae3e54-2df2-4e72-ad32-e2e7e256cbb1	e3a8370d-66de-4a14-bf5d-762309aa7d99	2b2cb673-f574-4f99-b152-c4f9c438ab0c	DELETE FROM user	pendiente	\N	\N	\N	2026-05-08 01:51:03.090577+00	2026-05-08 01:51:03.090577+00
8291ab83-1e8a-474c-b020-735a49c94a61	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e	Para la relacion de blbla	rechazada	t	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-05-08 16:40:26.557+00	2026-05-03 23:45:21.089061+00	2026-05-08 16:40:25.519613+00
\.


--
-- Data for Name: exam_timer_controls; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."exam_timer_controls" ("id", "exam_id", "target_user_id", "action", "extra_seconds", "created_by", "created_at") FROM stdin;
fbe28e87-1e93-4fbd-9155-8f22c89dd87e	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	add_time	300	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-05-08 01:24:46.644624+00
\.


--
-- Data for Name: exams; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."exams" ("id", "course_id", "created_by", "title", "description", "start_time", "end_time", "time_limit_minutes", "navigation_type", "shuffle_enabled", "parent_exam_id", "created_at", "updated_at", "max_attempts", "cut_id", "weight", "schedule_type", "retry_mode", "is_external", "max_warnings") FROM stdin;
ccc41a3c-261f-466c-913a-ca4d9c18e1d0	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	e8b3c430-2162-413b-8560-9e3a43e3577e	Quiz - Diagrama de Clases	\N	2026-05-01 00:45:00+00	2026-05-01 02:00:00+00	75	libre	f	\N	2026-05-01 00:46:02.445549+00	2026-05-04 22:49:33.014991+00	1	0325ea4e-9c44-457b-b5e1-a675bf65c147	1	normal	last	f	3
9ab4413a-f0e3-448d-a070-536cc466197e	0e375073-e9f2-4fda-a295-53407e3d5879	e8b3c430-2162-413b-8560-9e3a43e3577e	Parcial I - Programacion II	ArrayList	2026-04-17 02:00:00+00	2026-04-17 02:00:00+00	60	libre	f	\N	2026-05-06 16:56:16.630898+00	2026-05-06 16:56:16.630898+00	\N	2fff384e-ebc6-4eb5-989d-e6c2be763c6f	1	normal	last	t	3
e3a8370d-66de-4a14-bf5d-762309aa7d99	0e375073-e9f2-4fda-a295-53407e3d5879	e8b3c430-2162-413b-8560-9e3a43e3577e	Parcial II - Programacion II	HashMap, HashSet	2026-05-14 23:00:00+00	2026-05-15 00:30:00+00	90	libre	f	\N	2026-05-03 17:52:56.585751+00	2026-05-06 17:37:00.261266+00	\N	0325ea4e-9c44-457b-b5e1-a675bf65c147	1	normal	last	f	3
2c29880e-df95-4650-9653-3f6b72cc7632	c0eee9f7-9d38-4208-9a89-01e0a2af1de1	e8b3c430-2162-413b-8560-9e3a43e3577e	Test Sincronico	\N	2026-05-03 23:41:00+00	2026-05-10 23:41:00+00	60	libre	f	\N	2026-05-03 23:41:57.213524+00	2026-05-07 16:08:22.640556+00	\N	\N	1	normal	last	f	3
d8df0c5f-2fea-4abc-97d1-983118d93068	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	e8b3c430-2162-413b-8560-9e3a43e3577e	Parcial I - Seminario de Sistemas	\N	2026-04-17 17:26:00+00	2026-04-17 17:26:00+00	60	libre	f	\N	2026-05-07 17:26:52.229663+00	2026-05-07 17:26:52.229663+00	\N	0aa6d62c-f231-42da-a2db-82a2acdb49b0	1	normal	last	t	3
174074b0-5e6f-4c2c-8dde-05b1bfe712dd	0e375073-e9f2-4fda-a295-53407e3d5879	e8b3c430-2162-413b-8560-9e3a43e3577e	Quiz - HashMap & Hashset	Hash	2026-05-08 01:01:00+00	2026-05-08 03:00:00+00	119	libre	f	\N	2026-05-08 01:02:02.980064+00	2026-05-08 01:51:00.34658+00	\N	0325ea4e-9c44-457b-b5e1-a675bf65c147	1	normal	last	f	3
2cb32a39-c941-4db8-bc80-b43f884b6ad2	0e375073-e9f2-4fda-a295-53407e3d5879	e8b3c430-2162-413b-8560-9e3a43e3577e	Parcial II - Seminario de Sistemas	Diagrama de Clases y Secuencia	2026-05-21 23:00:00+00	2026-05-22 00:00:00+00	60	libre	f	\N	2026-05-03 17:52:56.585751+00	2026-05-08 16:14:49.805317+00	\N	0325ea4e-9c44-457b-b5e1-a675bf65c147	10	normal	last	f	3
\.


--
-- Data for Name: feedback_comments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."feedback_comments" ("id", "thread_id", "user_id", "body", "created_at", "author_role") FROM stdin;
aba76bb6-8944-45cb-94d6-929e022a8bcb	0baa9274-d74b-49c4-b1ab-b66a495a3d05	e8b3c430-2162-413b-8560-9e3a43e3577e	No estoy de acuerdo	2026-05-04 22:46:46.533189+00	student
5f7116e1-be83-4851-81dc-0f21dacec87e	0baa9274-d74b-49c4-b1ab-b66a495a3d05	e8b3c430-2162-413b-8560-9e3a43e3577e	No considero que este bien	2026-05-04 23:08:17.078792+00	student
db1d6ca6-da8f-43cf-8538-c1bf99158490	0baa9274-d74b-49c4-b1ab-b66a495a3d05	e8b3c430-2162-413b-8560-9e3a43e3577e	Yo creo que si esta bien	2026-05-05 00:29:54.103874+00	student
e38a973a-4b35-484d-8ae9-13bab65eec8a	b4f1d818-bb0f-4aae-b635-9f184a8f126d	e8b3c430-2162-413b-8560-9e3a43e3577e	No estoy de acuerdo	2026-05-05 00:57:06.018544+00	student
8c891a25-2479-49fb-b9ea-175dc85f6942	b4f1d818-bb0f-4aae-b635-9f184a8f126d	e8b3c430-2162-413b-8560-9e3a43e3577e	Yo sii	2026-05-05 00:58:26.16827+00	teacher
270ed3bf-1ee3-4539-9dfd-f06152b5fa1c	b4f1d818-bb0f-4aae-b635-9f184a8f126d	e8b3c430-2162-413b-8560-9e3a43e3577e	hh	2026-05-05 00:58:52.749499+00	student
c8a3f642-3c4e-44d5-b5c2-7b9f9f9d35b1	b4f1d818-bb0f-4aae-b635-9f184a8f126d	e8b3c430-2162-413b-8560-9e3a43e3577e	testt	2026-05-05 02:59:17.860623+00	teacher
dcf4a2b2-6b55-447b-a57f-bbd40adb1071	4320de8c-70ea-422e-8505-2a8be9407547	e8b3c430-2162-413b-8560-9e3a43e3577e	Si	2026-05-05 03:03:51.77065+00	student
e11d6acc-2c17-4072-a345-875ccc2e0276	bccfd1a7-b38b-441f-91d1-afad53f6b7b1	9084565c-58dd-4e35-8793-a9cf198117b3	aa	2026-05-05 03:11:30.965051+00	student
044ffd81-a356-40ac-beff-a30a5be6aa4b	e1b80ef6-f585-426b-bba7-4e0087015bed	9084565c-58dd-4e35-8793-a9cf198117b3	No estoy de acuerdo	2026-05-05 03:38:13.61018+00	student
65898618-afa2-4bed-a54a-e1dbab27630a	e1b80ef6-f585-426b-bba7-4e0087015bed	e8b3c430-2162-413b-8560-9e3a43e3577e	esta mal!	2026-05-05 03:57:00.430612+00	teacher
5bace572-cd36-458e-9a4a-ebd92033718d	e1b80ef6-f585-426b-bba7-4e0087015bed	9084565c-58dd-4e35-8793-a9cf198117b3	editado	2026-05-05 03:56:03.672951+00	student
007390ab-7af3-432b-b56e-a21a869845bd	0eb426b2-b935-4512-b037-24e7d06ac08c	9084565c-58dd-4e35-8793-a9cf198117b3	aaa	2026-05-05 04:14:25.111238+00	student
eb5ed2b5-7b8d-483a-a1c3-07c9c12a409a	0eb426b2-b935-4512-b037-24e7d06ac08c	9084565c-58dd-4e35-8793-a9cf198117b3	no estoy de acuerdo	2026-05-05 04:29:50.509031+00	student
2322433c-6dff-4b43-aa60-cf74d30e51bf	0eb426b2-b935-4512-b037-24e7d06ac08c	e8b3c430-2162-413b-8560-9e3a43e3577e	AAA	2026-05-05 04:30:38.308995+00	teacher
09248254-ebac-44f7-bfce-9d9b4129ebad	0eb426b2-b935-4512-b037-24e7d06ac08c	9084565c-58dd-4e35-8793-a9cf198117b3	aa	2026-05-05 04:34:14.940462+00	student
ae131208-3406-4f37-b834-f8b5eae7fbb4	a93bd832-0dab-4778-aa65-b32d38bb6eb5	9084565c-58dd-4e35-8793-a9cf198117b3	aa	2026-05-05 04:41:49.253185+00	student
a2c23741-3fc7-4450-ba3e-2cc0f080d2ab	48a2a0d3-7f2a-4523-88ff-28e9c543651f	9084565c-58dd-4e35-8793-a9cf198117b3	aa	2026-05-05 04:42:08.267437+00	student
f49a1dd7-b8a1-43fc-8309-2028a9e0ba6b	a93bd832-0dab-4778-aa65-b32d38bb6eb5	9084565c-58dd-4e35-8793-a9cf198117b3	zzz	2026-05-05 04:52:47.55701+00	student
7911f19a-07c9-42f2-a6cb-390fcccb3113	4320de8c-70ea-422e-8505-2a8be9407547	e8b3c430-2162-413b-8560-9e3a43e3577e	he	2026-05-05 04:57:32.651718+00	teacher
edac4b06-3ad9-4c97-ba99-4d1c312bb2b2	a93bd832-0dab-4778-aa65-b32d38bb6eb5	e8b3c430-2162-413b-8560-9e3a43e3577e	aa	2026-05-05 04:58:27.466684+00	teacher
94c9e55a-51fb-477f-972a-c0ebd431b573	a93bd832-0dab-4778-aa65-b32d38bb6eb5	9084565c-58dd-4e35-8793-a9cf198117b3	aas	2026-05-05 04:58:56.768513+00	student
dde74eb4-1de9-446b-97ca-51388d447e14	a93bd832-0dab-4778-aa65-b32d38bb6eb5	9084565c-58dd-4e35-8793-a9cf198117b3	aaa	2026-05-05 04:59:15.508256+00	student
3cb56a66-caf7-4f56-a9ef-30995e6cca45	a93bd832-0dab-4778-aa65-b32d38bb6eb5	9084565c-58dd-4e35-8793-a9cf198117b3	aa	2026-05-05 04:59:37.828213+00	student
2e73296b-4b18-47cf-aa21-64f33b215231	a93bd832-0dab-4778-aa65-b32d38bb6eb5	9084565c-58dd-4e35-8793-a9cf198117b3	aa	2026-05-05 05:00:02.638124+00	student
eb97dd66-f8b0-4ea1-af35-11db93b3ccf4	a93bd832-0dab-4778-aa65-b32d38bb6eb5	9084565c-58dd-4e35-8793-a9cf198117b3	aa	2026-05-05 05:08:41.099656+00	student
eab87503-f60c-436b-8d53-17b3ae56b6cb	f50e3a2b-3c5d-4f91-8bcc-75f0fcb972ea	e8b3c430-2162-413b-8560-9e3a43e3577e	no estoy de acuerdo con esto	2026-05-05 19:06:18.497036+00	student
36c70f39-a887-47ce-b369-771320d8a49d	f50e3a2b-3c5d-4f91-8bcc-75f0fcb972ea	e8b3c430-2162-413b-8560-9e3a43e3577e	asi es!	2026-05-05 19:06:44.062252+00	teacher
3436d94c-8ddc-4ec3-97f7-17b55805abe8	9293629a-3abc-4a13-9746-a6106a536e88	e8b3c430-2162-413b-8560-9e3a43e3577e	No estoy de acuerdo	2026-05-06 17:04:13.879447+00	student
034e2916-5b9b-4dd0-864a-0980c9ccf9b9	9293629a-3abc-4a13-9746-a6106a536e88	e8b3c430-2162-413b-8560-9e3a43e3577e	pos si	2026-05-06 17:04:38.492036+00	teacher
25cd292f-7105-40d5-9464-8a187e947ed6	51a1634a-a182-4089-b73a-98ad71a29f8e	dac41f00-64e7-40b8-a207-31f1ee2718c0	// Main method required for Java runner posiblemente dijo ia por esto :v jajajajajjaa	2026-05-07 13:11:12.518348+00	student
4df0b802-3aa1-42a9-b66d-b3961b30fc5f	5617d71f-ce4b-4e57-ac72-0ed86f4e3993	dac41f00-64e7-40b8-a207-31f1ee2718c0	literal se quejo por la simplicidad :l	2026-05-07 13:14:57.457809+00	student
1de15d95-535e-451e-babd-f0bba0a8c426	006220a3-8aba-419c-a8d7-8c517ac489a9	e8b3c430-2162-413b-8560-9e3a43e3577e	Profe la respuesta es correcta porque bla bla	2026-05-08 00:39:32.302789+00	student
a7789292-6931-414f-84a1-b4bc5f8afaf8	006220a3-8aba-419c-a8d7-8c517ac489a9	e8b3c430-2162-413b-8560-9e3a43e3577e	Si tienes razon	2026-05-08 00:39:57.122442+00	teacher
87ad3300-4c8f-4e6a-91a6-37413f2c73ff	6ab0ef36-b41c-4a87-8cec-6746826d1f8d	dac41f00-64e7-40b8-a207-31f1ee2718c0	si funca, y sirve con lo que pide :(	2026-05-08 01:50:45.91146+00	student
fd4472bb-7407-464e-b338-095a62da3cc2	868072c6-c8ab-415e-9cac-83398e69d303	dac41f00-64e7-40b8-a207-31f1ee2718c0	si, me comi un ; y un : pero fue por la premura :( no deja copiar y pegar	2026-05-08 01:51:41.336726+00	student
e5eefa4f-5510-4094-af97-93a4b6441fa3	868072c6-c8ab-415e-9cac-83398e69d303	dac41f00-64e7-40b8-a207-31f1ee2718c0	inject query :l :l :l?	2026-05-08 01:51:59.966747+00	student
886068c7-028d-405a-a1ac-e3841c1948d9	e37c131e-bb7a-4a33-9fa7-5f61f90b87d3	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	El segundo no me quiso funcionar porque no puse bien las importaciones:\n\nEl error\nimport java.until.HashMap;\nimport java.until.HashSet;\n\nComo debio ponerse:\nimport java.util.HashMap;\nimport java.util.HashSet;	2026-05-08 03:02:27.935277+00	student
dd39a650-5e46-4be9-99a9-fe02bf42c62a	e37c131e-bb7a-4a33-9fa7-5f61f90b87d3	e8b3c430-2162-413b-8560-9e3a43e3577e	Pero aqui no sale ninguna respuesta	2026-05-08 14:35:02.461923+00	teacher
0a86afbf-582a-4d49-a244-916ff04eceef	868072c6-c8ab-415e-9cac-83398e69d303	e8b3c430-2162-413b-8560-9e3a43e3577e	La calificacion la veo adecuada porque al final sin el ; no compila	2026-05-08 14:36:21.566975+00	teacher
2cf62d27-be5a-4fc7-98bc-40478fc91753	6ab0ef36-b41c-4a87-8cec-6746826d1f8d	e8b3c430-2162-413b-8560-9e3a43e3577e	Si tienes este caso:\n\nHashSet<ArrayList<Integer>> conjuntos = new HashSet<>();\n\nArrayList<Integer> listaA = new ArrayList<>();\nlistaA.add(5); // El 5 está en la listaA\n\nArrayList<Integer> listaB = new ArrayList<>();\nlistaB.add(8); // El 8 está en la listaB\n\nconjuntos.add(listaA);\nconjuntos.add(listaB);\n\nSystem.out.println(contieneNumero(conjuntos, 8));\n\nSi el bucle for revisa listaA primero, buscará el 8 ahí. Como no lo encuentra, ejecutará tu return false y el programa se detendrá. Dirá que el 8 no existe, porque tu código se rinde si no encuentra el número en el primer intento.	2026-05-08 14:51:29.246541+00	teacher
\.


--
-- Data for Name: feedback_threads; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."feedback_threads" ("id", "parent_kind", "question_id", "submission_id", "closed", "closed_at", "closed_by", "created_at") FROM stdin;
0baa9274-d74b-49c4-b1ab-b66a495a3d05	exam	1c1b1c30-8496-4867-81d4-16471ab1a42e	f55cd206-02f6-4005-8e0d-a7020e82a533	f	\N	\N	2026-05-04 22:46:46.223767+00
b4f1d818-bb0f-4aae-b635-9f184a8f126d	exam	1c1b1c30-8496-4867-81d4-16471ab1a42e	ad1b02d3-cf57-4eeb-bcdd-671e6e8527d3	f	\N	\N	2026-05-05 00:57:05.747222+00
4320de8c-70ea-422e-8505-2a8be9407547	exam	1c1b1c30-8496-4867-81d4-16471ab1a42e	047737aa-e0d3-4574-a6df-c8773edabf69	f	\N	\N	2026-05-05 03:03:51.534628+00
bccfd1a7-b38b-441f-91d1-afad53f6b7b1	exam	1c1b1c30-8496-4867-81d4-16471ab1a42e	99e9c6fe-9a2f-4ba5-9e72-a28a176804f5	f	\N	\N	2026-05-05 03:11:30.642213+00
0eb426b2-b935-4512-b037-24e7d06ac08c	exam	88f93771-0b0f-412e-bd22-1ba074817bfb	63d03cc7-f7ec-48bc-9246-4c32b93f0722	f	\N	\N	2026-05-05 04:14:24.79859+00
e1b80ef6-f585-426b-bba7-4e0087015bed	exam	1c1b1c30-8496-4867-81d4-16471ab1a42e	63d03cc7-f7ec-48bc-9246-4c32b93f0722	f	\N	\N	2026-05-05 03:38:13.406171+00
a93bd832-0dab-4778-aa65-b32d38bb6eb5	exam	1c1b1c30-8496-4867-81d4-16471ab1a42e	50e3564c-67a2-43d1-9a32-5a13f681fd03	f	\N	\N	2026-05-05 04:41:49.033188+00
48a2a0d3-7f2a-4523-88ff-28e9c543651f	exam	88f93771-0b0f-412e-bd22-1ba074817bfb	50e3564c-67a2-43d1-9a32-5a13f681fd03	f	\N	\N	2026-05-05 04:42:08.076453+00
f50e3a2b-3c5d-4f91-8bcc-75f0fcb972ea	exam	88f93771-0b0f-412e-bd22-1ba074817bfb	52a0089d-b45d-488c-a682-cbb7016c4095	f	\N	\N	2026-05-05 19:06:18.235189+00
9293629a-3abc-4a13-9746-a6106a536e88	exam	1c1b1c30-8496-4867-81d4-16471ab1a42e	5610b804-5d9f-4620-831f-cbc2d07764fa	f	\N	\N	2026-05-06 17:04:13.550892+00
51a1634a-a182-4089-b73a-98ad71a29f8e	project	69800d3e-dcff-474e-a4ee-836676d7dd27	dcc1741b-966a-41ce-b24c-8dcea07076e5	f	\N	\N	2026-05-07 13:11:12.154357+00
5617d71f-ce4b-4e57-ac72-0ed86f4e3993	project	98146289-46b6-46c8-ba0c-a60c3f81b936	dcc1741b-966a-41ce-b24c-8dcea07076e5	f	\N	\N	2026-05-07 13:14:57.181409+00
006220a3-8aba-419c-a8d7-8c517ac489a9	exam	1c1b1c30-8496-4867-81d4-16471ab1a42e	27f5fb82-79e8-4755-9eff-83be17337e54	f	\N	\N	2026-05-08 00:39:31.86827+00
6ab0ef36-b41c-4a87-8cec-6746826d1f8d	exam	70255d55-f4e9-4ee3-a2f7-474cc955a9a2	63f721dc-3dc5-43cf-a10e-88ea107e7e38	f	\N	\N	2026-05-08 01:50:45.562111+00
e37c131e-bb7a-4a33-9fa7-5f61f90b87d3	exam	70255d55-f4e9-4ee3-a2f7-474cc955a9a2	ecaa5dc3-58d2-413d-9a2a-0f3036407825	f	\N	\N	2026-05-08 03:02:27.452025+00
868072c6-c8ab-415e-9cac-83398e69d303	exam	88862e8e-d725-40ed-b4f0-51b0494c5b32	63f721dc-3dc5-43cf-a10e-88ea107e7e38	t	2026-05-08 14:36:27.939+00	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-05-08 01:51:41.118689+00
\.


--
-- Data for Name: grade_cut_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."grade_cut_items" ("id", "cut_id", "item_type", "exam_id", "workshop_id", "project_title", "weight", "created_at", "project_id") FROM stdin;
\.


--
-- Data for Name: grade_cuts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."grade_cuts" ("id", "course_id", "name", "position", "start_date", "end_date", "weight", "created_at", "updated_at", "exam_weight", "workshop_weight", "attendance_weight", "project_weight") FROM stdin;
55cdf83b-d189-49fe-8142-fab845b34b1a	0e375073-e9f2-4fda-a295-53407e3d5879	Corte 3	2	2026-05-20	2026-06-17	40.00	2026-04-26 15:51:56.907092+00	2026-05-07 22:40:17.174301+00	15	0	5	20
30178ec5-3d0a-4620-ad9b-0c9296fc028c	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	Corte 3	2	2026-05-20	2026-06-17	40.00	2026-05-03 22:43:20.779754+00	2026-05-07 22:40:17.174301+00	15	0	5	20
2fff384e-ebc6-4eb5-989d-e6c2be763c6f	0e375073-e9f2-4fda-a295-53407e3d5879	Corte 1	0	2026-03-04	2026-04-08	30.00	2026-04-26 15:51:56.463183+00	2026-05-07 22:40:17.174301+00	10	10	10	0
0325ea4e-9c44-457b-b5e1-a675bf65c147	0e375073-e9f2-4fda-a295-53407e3d5879	Corte 2	1	2026-04-15	2026-05-13	30.00	2026-04-26 15:51:56.692972+00	2026-05-07 22:40:17.174301+00	10	10	10	0
0aa6d62c-f231-42da-a2db-82a2acdb49b0	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	Corte 1	0	2026-03-04	2026-04-08	30.00	2026-05-03 22:43:19.972947+00	2026-05-07 22:40:17.174301+00	10	10	10	0
4f61f900-9fce-4480-8fa7-0637c5ad4011	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	Corte 2	1	2026-04-15	2026-05-13	30.00	2026-05-03 22:43:20.435635+00	2026-05-07 22:40:17.174301+00	10	10	10	0
\.


--
-- Data for Name: notifications; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."notifications" ("id", "user_id", "title", "body", "kind", "link", "read", "created_at", "exam_id", "related_user_id") FROM stdin;
95112c71-6eeb-49c2-be52-24ff07c8001b	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-04-26 16:16:22.257168+00	\N	\N
30abdd7b-1bbe-4eec-978c-872d948a510e	0cf09e84-be38-4adf-8e74-44937461fc46	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-04-26 16:16:22.257168+00	\N	\N
120c1380-eeca-4a69-b59d-4a3d39093e6f	2d709409-7b44-403d-a315-b8bb826aa8ca	Nuevo taller disponible	Se ha publicado el taller "Taller # 1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-03 16:48:31.936948+00	\N	\N
495275e4-05d2-458a-bed3-9a5533d56089	9084565c-58dd-4e35-8793-a9cf198117b3	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-06 18:27:48.168113+00	\N	\N
2376c4a2-fd97-4b5c-9b15-5db0113637b3	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-06 18:27:48.168113+00	\N	\N
a3e1eb24-2e3f-4c2b-95bc-afb18112946f	0cf09e84-be38-4adf-8e74-44937461fc46	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-06 18:27:48.168113+00	\N	\N
6deeb803-d1e9-4262-afe2-b60661a61d57	e5d5a97e-19e2-42a9-88fa-916eba925885	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-04-26 16:16:22.257168+00	\N	\N
30cc95a8-3c7d-44be-b3f1-61824453943d	e8b3c430-2162-413b-8560-9e3a43e3577e	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-06 18:27:48.168113+00	\N	\N
5d6516f1-3625-48ef-a3b6-cb500869d8f3	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	Nuevo taller disponible	Se ha publicado el taller "Taller # 1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-03 16:48:31.936948+00	\N	\N
12204346-678f-40f5-a945-7b5a2edc8b96	2b2cb673-f574-4f99-b152-c4f9c438ab0c	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-04-26 16:16:22.257168+00	\N	\N
45764fb0-c95c-4a01-91df-d4c160a16b0f	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-04-26 16:16:22.257168+00	\N	\N
726ae1d6-4326-4840-b28c-605b405e970a	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-04-26 16:16:22.257168+00	\N	\N
0d15630d-77ba-47a5-98ed-cd6bc18aa438	e8b3c430-2162-413b-8560-9e3a43e3577e	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-04-26 16:16:22.257168+00	\N	\N
1181641a-d5ac-4142-a30e-4b4b74efd683	dac41f00-64e7-40b8-a207-31f1ee2718c0	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-04-26 16:16:22.257168+00	\N	\N
3b001bf7-c0c4-41fd-86d1-863f4469c488	19e004a1-c1f2-4ca5-91d2-4c095058cb84	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-04-26 16:16:22.257168+00	\N	\N
e75bab44-1910-4a57-8015-71050b61dd2c	032a6335-5776-4677-8881-99db2cef9fe2	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-04-26 16:16:22.257168+00	\N	\N
e8458190-fae9-47f0-835d-f25221d8c81a	d048a636-8a14-4fcd-aa3e-891cca899b32	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-04-26 16:16:22.257168+00	\N	\N
07f42bd6-f797-432c-acea-b24ab26c828a	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-04-26 16:16:22.257168+00	\N	\N
ac67d44e-4aa3-47b3-8ca7-1cdbaddf400b	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-04-26 16:16:22.257168+00	\N	\N
6a54c5c2-1d3a-45c0-9552-ba74cf4e182f	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen asignado	Se te ha asignado el examen "Test"	exam	/app/student/exams	t	2026-04-28 02:58:58.445992+00	\N	\N
81d97d2d-383f-4ab2-8668-018e7e0d23e1	bce0ddee-4001-45e9-b323-719f80dc4f6d	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-04-26 16:16:22.257168+00	\N	\N
1583c7af-c816-4963-a437-2dd7558e553e	4e923995-0e57-4430-a1d6-cca9b9261775	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-04-26 16:16:22.257168+00	\N	\N
cfab89a6-7ff5-4517-94d3-b03f92e6f054	2d709409-7b44-403d-a315-b8bb826aa8ca	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-04-26 16:16:22.257168+00	\N	\N
24066870-c893-42de-a536-9339d1a52889	531392ff-60c0-471d-af30-5e58bc80e860	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-04-26 16:16:22.257168+00	\N	\N
83e18581-baba-406e-b142-5db05469f7c9	0a02892e-8476-44da-90e8-384c064e6040	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-04-26 16:16:22.257168+00	\N	\N
9ea52c33-5fa5-4ca3-930b-e0dd43939659	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen marcado como sospechoso	Tu intento del examen "Quiz - Diagrama de Clases" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-05-01 01:06:52.534268+00	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	e8b3c430-2162-413b-8560-9e3a43e3577e
3f36d2a6-40b4-4dc6-a8a7-fc526d5d687a	4e923995-0e57-4430-a1d6-cca9b9261775	Nuevo taller disponible	Se ha publicado el taller "Taller # 1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:31.936948+00	\N	\N
fda27f56-3430-4b23-b067-3049fe412431	0a02892e-8476-44da-90e8-384c064e6040	Nuevo taller disponible	Se ha publicado el taller "Taller # 1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:31.936948+00	\N	\N
4eb102a8-349b-4192-8d47-203afcf38bdb	032a6335-5776-4677-8881-99db2cef9fe2	Nuevo taller disponible	Se ha publicado el taller "Taller # 1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:31.936948+00	\N	\N
7ba97d24-b6de-48ab-a941-e25e4abbc758	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	Nuevo taller disponible	Se ha publicado el taller "Taller # 1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:31.936948+00	\N	\N
fef1d174-47fc-46a5-95d5-dc74cf74f05c	d048a636-8a14-4fcd-aa3e-891cca899b32	Nuevo taller disponible	Se ha publicado el taller "Taller # 1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:31.936948+00	\N	\N
5bedf9f3-9f9b-4551-8559-2fc23b0ce78f	531392ff-60c0-471d-af30-5e58bc80e860	Nuevo taller disponible	Se ha publicado el taller "Taller # 1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:31.936948+00	\N	\N
dfa01efc-549d-4e3c-a43e-a8e8c5f58034	e5d5a97e-19e2-42a9-88fa-916eba925885	Nuevo taller disponible	Se ha publicado el taller "Taller # 1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:31.936948+00	\N	\N
e36505eb-8875-4c2b-be22-adf31392bb4f	19e004a1-c1f2-4ca5-91d2-4c095058cb84	Nuevo taller disponible	Se ha publicado el taller "Taller # 1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:31.936948+00	\N	\N
7a598672-b4cb-432f-a65e-e38188a57897	bce0ddee-4001-45e9-b323-719f80dc4f6d	Nuevo taller disponible	Se ha publicado el taller "Taller # 1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:31.936948+00	\N	\N
eb065d4c-708d-404b-842d-1419de761dcd	2b2cb673-f574-4f99-b152-c4f9c438ab0c	Nuevo taller disponible	Se ha publicado el taller "Taller # 1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:31.936948+00	\N	\N
67e5668a-51b5-4383-b01a-6886f1aac1bd	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	Nuevo taller disponible	Se ha publicado el taller "Taller # 1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:31.936948+00	\N	\N
ebb6ade4-ea83-45cb-9468-1abfe09d96f7	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: tes · Pruebas	Andrés (Master) hizo un comentario en la pregunta 1 (intento 1).	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632?student=e8b3c430-2162-413b-8560-9e3a43e3577e	t	2026-05-05 19:06:18.760007+00	\N	\N
08beca40-9d24-4829-820f-9488b129487e	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: tes · Pruebas	Andrés (Master) respondió a tu retroalimentación en la pregunta 1 (intento 1).	feedback	/app/student/review/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-05 19:06:44.249615+00	\N	\N
9a1c7d20-f715-4d0f-a816-dcdce1373093	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Andrés (Master) fue suspendido del examen "Test" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. retroceso — 01:17:35 p. m. (pregunta 1)\n2. retroceso — 01:17:46 p. m. (pregunta 1)\n3. retroceso — 01:17:59 p. m. (pregunta 2)	exam_integrity_staff	/app/teacher/monitor/b8dd2363-5e6c-473a-bbfd-9c0915a64417	t	2026-04-28 18:17:59.289009+00	\N	e8b3c430-2162-413b-8560-9e3a43e3577e
83f2adc3-19e3-41b4-a301-f55c739f010a	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen marcado como sospechoso	Tu intento del examen "Test" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-04-28 18:17:59.289009+00	\N	e8b3c430-2162-413b-8560-9e3a43e3577e
c96e6bd1-9a60-4ea7-9003-fab3441236b9	4e923995-0e57-4430-a1d6-cca9b9261775	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-06 18:27:48.168113+00	\N	\N
758a364e-b71f-4406-87d6-2d2dec82b9bc	0a02892e-8476-44da-90e8-384c064e6040	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-06 18:27:48.168113+00	\N	\N
42f46e8f-5476-4f15-a7b4-f41d8eafd93d	032a6335-5776-4677-8881-99db2cef9fe2	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-06 18:27:48.168113+00	\N	\N
7b229afd-9f1c-41e0-b3fd-0c62ad788bf2	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-06 18:27:48.168113+00	\N	\N
53ebb637-dbcd-4d6e-9166-18f29ef9749a	d048a636-8a14-4fcd-aa3e-891cca899b32	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-06 18:27:48.168113+00	\N	\N
79df9801-3e4f-4f29-8da6-07f948be9e84	531392ff-60c0-471d-af30-5e58bc80e860	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-06 18:27:48.168113+00	\N	\N
27e29092-f1ad-4fb5-b5ea-078e7b25b609	e5d5a97e-19e2-42a9-88fa-916eba925885	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-06 18:27:48.168113+00	\N	\N
408b7b75-ffc8-4051-b2bf-71caf5743c8b	19e004a1-c1f2-4ca5-91d2-4c095058cb84	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-06 18:27:48.168113+00	\N	\N
8217d61d-d3e9-4ea0-93e1-e834cd506f4b	bce0ddee-4001-45e9-b323-719f80dc4f6d	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-06 18:27:48.168113+00	\N	\N
ad5be396-db11-4014-a1a7-f68c026d0d3c	2b2cb673-f574-4f99-b152-c4f9c438ab0c	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-06 18:27:48.168113+00	\N	\N
113c1d32-c880-4b92-931c-5326ceb7c0a8	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-06 18:27:48.168113+00	\N	\N
24603df0-79de-4128-ba47-5cd477892ded	d048a636-8a14-4fcd-aa3e-891cca899b32	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-06 22:22:19.429173+00	\N	\N
0ba6d683-89d5-44dd-8b85-8f4d9026197d	19e004a1-c1f2-4ca5-91d2-4c095058cb84	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-06 22:22:20.185162+00	\N	\N
78c8c008-cdb3-4280-a4cd-d1761dae5b95	9084565c-58dd-4e35-8793-a9cf198117b3	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-06 22:22:21.684473+00	\N	\N
cebe7f42-ad84-4339-a825-14fb7374cb7d	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	t	2026-05-06 22:22:18.253751+00	\N	\N
b018f4b3-da2c-42e4-b6cd-035ac55192bb	2d709409-7b44-403d-a315-b8bb826aa8ca	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-06 18:27:48.168113+00	\N	\N
50047b71-fd77-4e81-88f9-1d2e08aa8075	531392ff-60c0-471d-af30-5e58bc80e860	Taller actualizado	Se actualizó el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-07 22:17:55.028937+00	\N	\N
b7e06276-c86a-4e15-a403-9d9dc919b5df	e5d5a97e-19e2-42a9-88fa-916eba925885	Taller actualizado	Se actualizó el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-07 22:17:55.028937+00	\N	\N
b7704c81-ff53-4275-8fde-e8eb24f86bdd	19e004a1-c1f2-4ca5-91d2-4c095058cb84	Taller actualizado	Se actualizó el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-07 22:17:55.028937+00	\N	\N
1cd21a16-4ba8-4820-8b7d-2963668cde2e	bce0ddee-4001-45e9-b323-719f80dc4f6d	Taller actualizado	Se actualizó el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-07 22:17:55.028937+00	\N	\N
cbb38d97-7569-4b67-bfd1-88bbcdab1cc2	2b2cb673-f574-4f99-b152-c4f9c438ab0c	Taller actualizado	Se actualizó el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-07 22:17:55.028937+00	\N	\N
4073287e-4695-4441-81b4-b1788b6c2cd5	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	Taller actualizado	Se actualizó el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-07 22:17:55.028937+00	\N	\N
1d29def7-eb8c-4d73-9fbb-c55c861bd78b	2b2cb673-f574-4f99-b152-c4f9c438ab0c	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 22:18:16.381842+00	\N	\N
6cdb1c7f-4b42-4757-b04a-4afd388f110f	dac41f00-64e7-40b8-a207-31f1ee2718c0	Taller actualizado	Se actualizó el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-07 22:17:55.028937+00	\N	\N
a7dfb7a9-7ef5-4ec7-9d5f-c94ebcea6ee8	dac41f00-64e7-40b8-a207-31f1ee2718c0	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-06 18:27:48.168113+00	\N	\N
b83162df-08b2-45e3-8abf-cb46874efc4e	dac41f00-64e7-40b8-a207-31f1ee2718c0	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	t	2026-05-06 22:22:21.323352+00	\N	\N
1bdfce0f-2423-4039-816e-ed397f8d45d1	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-07 22:18:16.381842+00	\N	\N
dc94f31a-1568-4b2a-9d67-aac77a4ab340	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	Taller actualizado	Se actualizó el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-07 22:17:55.028937+00	\N	\N
0db5b915-bf4d-45cb-8d8b-a272c87781aa	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-06 18:27:48.168113+00	\N	\N
d26586b4-2421-497e-b894-6000f457eb94	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Nuevo taller disponible	Se ha publicado el taller "Taller #3  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-06 18:27:48.168113+00	\N	\N
9d4a4449-1ee2-4778-b6dc-85e47a2a2662	2d709409-7b44-403d-a315-b8bb826aa8ca	Taller actualizado	Se actualizó el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-07 22:17:55.028937+00	\N	\N
96d51a9c-bc6e-44d6-b930-0ba7a65a3723	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Andrés (Master) fue suspendido del examen "tes" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. Salida de pantalla completa — 02:03:27 p. m.\n2. Salida de pantalla completa — 02:05:42 p. m.\n3. Salida de pantalla completa — 02:05:45 p. m.	exam_integrity_staff	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-05 19:05:45.885008+00	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e
750c512e-543a-4ca6-8739-d9199dc73c81	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen marcado como sospechoso	Tu intento del examen "tes" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-05-05 19:05:45.885008+00	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e
11cc104c-3f15-4cf2-9c86-85c0673b4f02	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Andrés (Master) fue suspendido del examen "tes" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. Salida de pantalla completa — 02:04:02 p. m.\n2. Salida de pestaña/ventana — 02:04:52 p. m.\n3. Salida de pestaña/ventana — 02:04:54 p. m.	exam_integrity_staff	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-06 19:04:55.675264+00	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e
6b20ce0b-6bb6-43ba-bb83-54defc0948da	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen marcado como sospechoso	Tu intento del examen "tes" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-05-06 19:04:55.675264+00	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e
8ae6d30a-8d0a-4345-94b4-eb8cb7e06688	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-06 22:22:18.450626+00	\N	\N
59b785b8-047c-47d8-abdb-c35bef0854d6	032a6335-5776-4677-8881-99db2cef9fe2	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-06 22:22:19.036122+00	\N	\N
67f0fcef-d114-4f37-bd5d-1b933bf0365f	2b2cb673-f574-4f99-b152-c4f9c438ab0c	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-06 22:22:20.962383+00	\N	\N
4fc47645-528d-4428-acf8-307d89105ad2	e8b3c430-2162-413b-8560-9e3a43e3577e	Proyecto: VetCare — Sistema de Gestión Veterinaria · Programación II	Aguado Becerra Juan Sebastian hizo un comentario en la pregunta 6.	feedback	/app/teacher/projects?id=6e7c4db6-8dd5-416b-a965-731ed86545b9&student=dac41f00-64e7-40b8-a207-31f1ee2718c0	t	2026-05-07 13:14:57.773836+00	\N	\N
1a42793c-739e-4918-bb95-30e89f129a3b	e8b3c430-2162-413b-8560-9e3a43e3577e	Proyecto: VetCare — Sistema de Gestión Veterinaria · Programación II	Aguado Becerra Juan Sebastian hizo un comentario en la pregunta 4.	feedback	/app/teacher/projects?id=6e7c4db6-8dd5-416b-a965-731ed86545b9&student=dac41f00-64e7-40b8-a207-31f1ee2718c0	t	2026-05-07 13:11:12.81583+00	\N	\N
3f6699bc-7bb6-40a2-9cfc-10df51c19701	9084565c-58dd-4e35-8793-a9cf198117b3	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 22:18:16.381842+00	\N	\N
33c90448-361a-4b4f-9538-846d215ff605	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Andrés (Master) fue suspendido del examen "Test" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. retroceso — 11:38:29 a. m. (pregunta 1)\n2. retroceso — 11:59:28 a. m. (pregunta 1)\n3. retroceso — 11:59:43 a. m. (pregunta 1)	exam_integrity_staff	/app/teacher/monitor/b8dd2363-5e6c-473a-bbfd-9c0915a64417	t	2026-04-28 16:59:44.221965+00	\N	e8b3c430-2162-413b-8560-9e3a43e3577e
885e4644-0144-4b3a-a8bc-5cdb982cde14	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen marcado como sospechoso	Tu intento del examen "Test" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-04-28 16:59:44.221965+00	\N	e8b3c430-2162-413b-8560-9e3a43e3577e
9534ab9b-ed15-456c-a81a-0b5ae18ad07a	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Andrés (Master) fue suspendido del examen "Test" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. retroceso — 12:00:48 p. m. (pregunta 1)\n2. retroceso — 12:00:55 p. m. (pregunta 1)\n3. Salida de pestaña/ventana — 12:19:32 p. m.	exam_integrity_staff	/app/teacher/monitor/b8dd2363-5e6c-473a-bbfd-9c0915a64417	t	2026-04-28 17:19:33.019429+00	\N	e8b3c430-2162-413b-8560-9e3a43e3577e
d645aef1-b1c7-4b77-935f-69b94805eb50	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen marcado como sospechoso	Tu intento del examen "Test" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-04-28 17:19:33.019429+00	\N	e8b3c430-2162-413b-8560-9e3a43e3577e
b965fecc-f23c-446d-96ce-9f26099d014a	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Andrés (Master) fue suspendido del examen "Test" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. retroceso — 12:46:23 p. m. (pregunta 1)\n2. retroceso — 12:46:27 p. m. (pregunta 1)\n3. retroceso — 12:46:29 p. m. (pregunta 1)	exam_integrity_staff	/app/teacher/monitor/b8dd2363-5e6c-473a-bbfd-9c0915a64417	t	2026-04-28 17:46:30.319351+00	\N	e8b3c430-2162-413b-8560-9e3a43e3577e
93ef69dd-7525-443c-ade2-34e17bfd5fdd	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen marcado como sospechoso	Tu intento del examen "Test" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-04-28 17:46:30.319351+00	\N	e8b3c430-2162-413b-8560-9e3a43e3577e
74427e66-1f1b-4431-b4f9-42b83640b397	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 22:18:16.381842+00	\N	\N
7c18e946-338d-49b5-83a5-311e850c6cbf	0cf09e84-be38-4adf-8e74-44937461fc46	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 22:18:16.381842+00	\N	\N
32f3a251-9d19-4a79-8767-705f8ba5b84b	4e923995-0e57-4430-a1d6-cca9b9261775	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 22:18:16.381842+00	\N	\N
d489380c-b6e3-4da8-87c5-6751cdfa65a4	0a02892e-8476-44da-90e8-384c064e6040	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 22:18:16.381842+00	\N	\N
7f400a08-fb2b-430f-a8a3-b1cb9cf8acbb	032a6335-5776-4677-8881-99db2cef9fe2	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 22:18:16.381842+00	\N	\N
11915420-bcd5-47cc-bfcc-ab991dad9a35	e8b3c430-2162-413b-8560-9e3a43e3577e	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-07 22:18:16.381842+00	\N	\N
3d735a26-50a5-4e36-bcdc-b558e0fcd2aa	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Andrés (Master) fue suspendido del examen "Test" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. retroceso — 01:09:01 p. m. (pregunta 1)\n2. retroceso — 01:09:06 p. m. (pregunta 1)\n3. Salida de pestaña/ventana — 01:09:07 p. m.	exam_integrity_staff	/app/teacher/monitor/b8dd2363-5e6c-473a-bbfd-9c0915a64417	t	2026-04-28 18:09:07.708311+00	\N	e8b3c430-2162-413b-8560-9e3a43e3577e
945a2b4a-b124-42a7-9366-fa526c2ef6d9	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen marcado como sospechoso	Tu intento del examen "Test" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-04-28 18:09:07.708311+00	\N	e8b3c430-2162-413b-8560-9e3a43e3577e
84962114-b3e7-4946-a22b-65f7b32e5099	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Andrés (Master) fue suspendido del examen "Test" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. retroceso — 01:16:36 p. m. (pregunta 1)\n2. retroceso — 01:16:54 p. m. (pregunta 1)\n3. retroceso — 01:16:57 p. m. (pregunta 1)	exam_integrity_staff	/app/teacher/monitor/b8dd2363-5e6c-473a-bbfd-9c0915a64417	t	2026-04-28 18:16:57.344373+00	\N	e8b3c430-2162-413b-8560-9e3a43e3577e
86f80ceb-eae2-4b8a-8889-b2cd99ce1492	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen marcado como sospechoso	Tu intento del examen "Test" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-04-28 18:16:57.344373+00	\N	e8b3c430-2162-413b-8560-9e3a43e3577e
f386d983-d807-46c9-9610-79222a8c4091	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Andrés (Master) fue suspendido del examen "Test" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. retroceso — 01:18:26 p. m. (pregunta 1)\n2. Salida de pestaña/ventana — 01:18:29 p. m.\n3. retroceso — 01:18:53 p. m. (pregunta 1)	exam_integrity_staff	/app/teacher/monitor/b8dd2363-5e6c-473a-bbfd-9c0915a64417	t	2026-04-28 18:18:54.174198+00	\N	e8b3c430-2162-413b-8560-9e3a43e3577e
64c290af-0511-4430-b7f9-9900ebb751c5	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen marcado como sospechoso	Tu intento del examen "Test" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-04-28 18:18:54.174198+00	\N	e8b3c430-2162-413b-8560-9e3a43e3577e
bd50af6d-3ca8-4c38-be76-d9890a83e3f8	4e923995-0e57-4430-a1d6-cca9b9261775	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-06 22:22:18.657983+00	\N	\N
140ea2f7-50e4-40c8-9e2d-1d69bd4fb0c3	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	Examen asignado	Se te ha asignado el examen "Quiz - Diagrama de Clases"	exam	/app/student/exams	f	2026-05-01 00:46:17.88736+00	\N	\N
3dee9e80-c810-411b-8de5-3fe93c1b2a6b	0cf09e84-be38-4adf-8e74-44937461fc46	Examen asignado	Se te ha asignado el examen "Quiz - Diagrama de Clases"	exam	/app/student/exams	f	2026-05-01 00:46:18.088003+00	\N	\N
3a478194-885a-4d74-9137-af71faeca0c1	4e923995-0e57-4430-a1d6-cca9b9261775	Examen asignado	Se te ha asignado el examen "Quiz - Diagrama de Clases"	exam	/app/student/exams	f	2026-05-01 00:46:18.3504+00	\N	\N
0c6361b9-d8e8-4552-b6e3-2abd709038a6	531392ff-60c0-471d-af30-5e58bc80e860	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-06 22:22:19.620677+00	\N	\N
81adf40c-17da-4f2a-92ce-5fd1bce07cd8	032a6335-5776-4677-8881-99db2cef9fe2	Examen asignado	Se te ha asignado el examen "Quiz - Diagrama de Clases"	exam	/app/student/exams	f	2026-05-01 00:46:18.725592+00	\N	\N
0b93e750-a34f-492c-8809-3a0b0fd8e818	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	Examen asignado	Se te ha asignado el examen "Quiz - Diagrama de Clases"	exam	/app/student/exams	f	2026-05-01 00:46:18.908335+00	\N	\N
ee1fc95c-a5f6-4490-9106-17c5df292194	d048a636-8a14-4fcd-aa3e-891cca899b32	Examen asignado	Se te ha asignado el examen "Quiz - Diagrama de Clases"	exam	/app/student/exams	f	2026-05-01 00:46:19.096693+00	\N	\N
56f4aa6a-41b4-4cb8-8401-4e2709ae10ae	531392ff-60c0-471d-af30-5e58bc80e860	Examen asignado	Se te ha asignado el examen "Quiz - Diagrama de Clases"	exam	/app/student/exams	f	2026-05-01 00:46:19.275794+00	\N	\N
6c4a46f0-88f3-4509-b008-c7ebdc215367	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Examen asignado	Se te ha asignado el examen "Quiz - Diagrama de Clases"	exam	/app/student/exams	t	2026-05-01 00:46:20.299755+00	\N	\N
66f6018c-c4a0-47e6-ae3d-0127844845e1	e5d5a97e-19e2-42a9-88fa-916eba925885	Examen asignado	Se te ha asignado el examen "Quiz - Diagrama de Clases"	exam	/app/student/exams	f	2026-05-01 00:46:19.614312+00	\N	\N
05bc7079-b945-4f33-84c2-1c1cde727d43	19e004a1-c1f2-4ca5-91d2-4c095058cb84	Examen asignado	Se te ha asignado el examen "Quiz - Diagrama de Clases"	exam	/app/student/exams	f	2026-05-01 00:46:19.788557+00	\N	\N
090c4fd2-d6bb-4f59-adbe-981d8138ff32	bce0ddee-4001-45e9-b323-719f80dc4f6d	Examen asignado	Se te ha asignado el examen "Quiz - Diagrama de Clases"	exam	/app/student/exams	f	2026-05-01 00:46:19.961398+00	\N	\N
ab3638ce-5490-4ddf-8cfb-8fae6774623c	2b2cb673-f574-4f99-b152-c4f9c438ab0c	Examen asignado	Se te ha asignado el examen "Quiz - Diagrama de Clases"	exam	/app/student/exams	f	2026-05-01 00:46:20.469597+00	\N	\N
c6b558af-3913-4755-9bc7-29029f254c43	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	Examen asignado	Se te ha asignado el examen "Quiz - Diagrama de Clases"	exam	/app/student/exams	f	2026-05-01 00:46:20.641134+00	\N	\N
faa4ff43-9608-4bce-bfc9-765cf67f76f3	2d709409-7b44-403d-a315-b8bb826aa8ca	Examen asignado	Se te ha asignado el examen "Quiz - Diagrama de Clases"	exam	/app/student/exams	t	2026-05-01 00:46:19.442861+00	\N	\N
91e66a73-6845-47f8-ad0f-607d08d1869b	0a02892e-8476-44da-90e8-384c064e6040	Examen asignado	Se te ha asignado el examen "Quiz - Diagrama de Clases"	exam	/app/student/exams	t	2026-05-01 00:46:18.554399+00	\N	\N
3e7775a3-33a4-4b93-9ff3-b89f01407b32	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen asignado	Se te ha asignado el examen "Quiz - Diagrama de Clases"	exam	/app/student/exams	t	2026-05-01 00:46:17.481973+00	\N	\N
9fa2264e-a5e8-40ab-b72a-dcd1f7127855	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Andrés (Master) fue suspendido del examen "Quiz - Diagrama de Clases" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. Salida de pestaña/ventana — 07:53:48 p. m.\n2. Salida de pestaña/ventana — 07:53:51 p. m.\n3. Salida de pestaña/ventana — 07:53:54 p. m.	exam_integrity_staff	/app/teacher/monitor/ccc41a3c-261f-466c-913a-ca4d9c18e1d0	t	2026-05-01 00:53:55.765814+00	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	e8b3c430-2162-413b-8560-9e3a43e3577e
8a040436-f7cf-4e6d-8706-1c0252efcaba	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen marcado como sospechoso	Tu intento del examen "Quiz - Diagrama de Clases" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-05-01 00:53:55.765814+00	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	e8b3c430-2162-413b-8560-9e3a43e3577e
bf33e729-530b-4a95-97fa-927199fec3dd	dac41f00-64e7-40b8-a207-31f1ee2718c0	Examen asignado	Se te ha asignado el examen "Quiz - Diagrama de Clases"	exam	/app/student/exams	t	2026-05-01 00:46:20.809066+00	\N	\N
55245a72-c745-400c-9a8c-27405f44ba6d	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Andrés (Master) fue suspendido del examen "Quiz - Diagrama de Clases" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. Salida de pestaña/ventana — 08:06:39 p. m.\n2. Salida de pestaña/ventana — 08:06:45 p. m.\n3. Salida de pestaña/ventana — 08:06:51 p. m.	exam_integrity_staff	/app/teacher/monitor/ccc41a3c-261f-466c-913a-ca4d9c18e1d0	t	2026-05-01 01:06:52.534268+00	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	e8b3c430-2162-413b-8560-9e3a43e3577e
8769f469-ed7f-49be-8bf9-a1eb235d3350	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen asignado	Se te ha asignado el examen "test"	exam	/app/student/exams	t	2026-05-01 02:30:42.748622+00	\N	\N
d0e98157-87fd-44f0-8c6e-9100931336af	0cf09e84-be38-4adf-8e74-44937461fc46	Examen asignado	Se te ha asignado el examen "Copia de Quiz - Diagrama de Clases"	exam	/app/student/exams	f	2026-05-01 03:08:57.717134+00	\N	\N
b28c40f0-26ba-48db-803d-6db0414a1f29	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	Nuevo taller disponible	Se ha publicado el taller "Taller # 1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:31.936948+00	\N	\N
1020195e-93e8-4189-ab8f-a19f56d0d339	0cf09e84-be38-4adf-8e74-44937461fc46	Nuevo taller disponible	Se ha publicado el taller "Taller # 1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:31.936948+00	\N	\N
759cd92e-b8fd-4429-b174-8a3f1bab5a56	2d709409-7b44-403d-a315-b8bb826aa8ca	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-03 16:48:42.073177+00	\N	\N
4c3a0e1d-2f7b-4a16-a764-582c5ff6733d	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:42.073177+00	\N	\N
f8caf6e9-b146-4759-9a0b-f90daad4b7e1	0cf09e84-be38-4adf-8e74-44937461fc46	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:42.073177+00	\N	\N
5ddc485c-ec4e-4ae3-a4a3-f6f5a44a7653	4e923995-0e57-4430-a1d6-cca9b9261775	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:42.073177+00	\N	\N
e1fbcd58-d410-4910-9dbb-807d368d1105	0a02892e-8476-44da-90e8-384c064e6040	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:42.073177+00	\N	\N
1b48be3d-39ac-4be0-841c-a90db0088130	032a6335-5776-4677-8881-99db2cef9fe2	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:42.073177+00	\N	\N
7465a742-dc1d-4c4c-8af3-e274c7494502	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:42.073177+00	\N	\N
caf57db3-fcc1-4f73-9b74-82bff00e8226	d048a636-8a14-4fcd-aa3e-891cca899b32	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:42.073177+00	\N	\N
50f53e1b-0828-484a-8e19-7584b41d88c1	531392ff-60c0-471d-af30-5e58bc80e860	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:42.073177+00	\N	\N
e4a45e37-5931-48d9-a39d-fb78e77302a8	e5d5a97e-19e2-42a9-88fa-916eba925885	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:42.073177+00	\N	\N
6d555404-6cb8-426a-919d-5b8323f6768c	19e004a1-c1f2-4ca5-91d2-4c095058cb84	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:42.073177+00	\N	\N
f72682a5-e723-4689-a4ca-313feefcd59b	bce0ddee-4001-45e9-b323-719f80dc4f6d	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:42.073177+00	\N	\N
668f3cef-f32e-46be-9d45-efc387e1f9f8	2b2cb673-f574-4f99-b152-c4f9c438ab0c	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:42.073177+00	\N	\N
b3422cb8-f898-4fee-aee5-fc8753940dec	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 16:48:42.073177+00	\N	\N
24b98903-c69f-4248-9928-019f8714747e	2d709409-7b44-403d-a315-b8bb826aa8ca	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	t	2026-05-03 17:58:59.528921+00	\N	\N
f8fcb5f5-b73f-47c7-b7a0-60ff000fa57c	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	f	2026-05-03 17:58:57.905287+00	\N	\N
4b599c23-8439-4ace-b6b2-b273f4937f8a	4e923995-0e57-4430-a1d6-cca9b9261775	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	f	2026-05-03 17:58:58.136096+00	\N	\N
86646e10-c1cf-4536-a525-675b48bdb61c	0a02892e-8476-44da-90e8-384c064e6040	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	f	2026-05-03 17:58:58.367897+00	\N	\N
51764b28-8c9c-4e14-8dd5-931595c2a558	032a6335-5776-4677-8881-99db2cef9fe2	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	f	2026-05-03 17:58:58.605725+00	\N	\N
919fa713-97f7-4673-b3a5-d5351a8f02b6	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	f	2026-05-03 17:58:58.832166+00	\N	\N
b1dbaf8b-8583-4be8-b646-6760c0a15a0c	d048a636-8a14-4fcd-aa3e-891cca899b32	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	f	2026-05-03 17:58:59.060308+00	\N	\N
4b134ea9-aae8-486f-9ff1-70f2c0c3d020	531392ff-60c0-471d-af30-5e58bc80e860	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	f	2026-05-03 17:58:59.292438+00	\N	\N
5295f355-e632-4260-87ba-c17b13bd4dd2	e5d5a97e-19e2-42a9-88fa-916eba925885	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	f	2026-05-03 17:58:59.767213+00	\N	\N
73bf1cdd-b10c-4097-a903-38d3195060ca	19e004a1-c1f2-4ca5-91d2-4c095058cb84	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	f	2026-05-03 17:59:00.003133+00	\N	\N
073a93d8-38dd-4cb5-b1a8-8db5f1836578	bce0ddee-4001-45e9-b323-719f80dc4f6d	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	f	2026-05-03 17:59:00.237964+00	\N	\N
db0dd236-d5d8-468f-8d35-366231be69f9	2b2cb673-f574-4f99-b152-c4f9c438ab0c	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	f	2026-05-03 17:59:00.935671+00	\N	\N
6944a85a-5058-4e02-aeff-ab14eec4fb58	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	f	2026-05-03 17:59:01.16818+00	\N	\N
2709734b-4dbe-4eb9-b1bb-0ac2c0efdf6f	0cf09e84-be38-4adf-8e74-44937461fc46	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	f	2026-05-03 17:59:01.637498+00	\N	\N
56db652c-1045-4b60-b8d1-4f2f7c14e48b	e8b3c430-2162-413b-8560-9e3a43e3577e	Nuevo taller disponible	Se ha publicado el taller "Taller # 1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-03 16:48:31.936948+00	\N	\N
ee74049b-16ed-4c03-b9b6-c485771f0b0b	e8b3c430-2162-413b-8560-9e3a43e3577e	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-03 16:48:42.073177+00	\N	\N
da54c732-0c14-443d-b3a5-317367605bd9	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	t	2026-05-03 17:58:55.444317+00	\N	\N
c6622402-b9cb-4839-8a65-cd19aa230548	0a02892e-8476-44da-90e8-384c064e6040	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-06 22:22:18.84928+00	\N	\N
b7338fe7-fccb-4603-a18b-afdc416cd3fb	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-06 22:22:19.236419+00	\N	\N
be0e79c7-3591-459f-beaf-c117389b3730	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	t	2026-05-03 17:59:00.472161+00	\N	\N
fd788b92-a8db-47fe-8fa9-a19b5dd24026	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-03 16:48:42.073177+00	\N	\N
4906d84b-41e0-4b84-b7c7-0265821bc38d	dac41f00-64e7-40b8-a207-31f1ee2718c0	Nuevo taller disponible	Se ha publicado el taller "Taller # 1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-03 16:48:31.936948+00	\N	\N
8bb0a661-f84b-4ddd-b5f2-7b16067f7aa9	dac41f00-64e7-40b8-a207-31f1ee2718c0	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-03 16:48:42.073177+00	\N	\N
a11eedb8-d4e6-4d6e-9288-05b42a6b5a42	dac41f00-64e7-40b8-a207-31f1ee2718c0	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	t	2026-05-03 17:59:01.404415+00	\N	\N
07453a26-c880-46ec-ae9c-9cab3f8a022e	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-03 16:48:42.073177+00	\N	\N
1744d79e-b0c0-43b1-ab29-5c7d36eb7e98	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	t	2026-05-03 17:58:57.676611+00	\N	\N
3fdb0064-af1f-4e80-bcf4-56b2c73d4ca6	2d709409-7b44-403d-a315-b8bb826aa8ca	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-03 22:48:56.178512+00	\N	\N
ca870fb9-e8d9-4fba-a368-ca560f934538	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 22:48:56.178512+00	\N	\N
d7a435fb-1f89-407c-a30c-1054a1df9af3	0cf09e84-be38-4adf-8e74-44937461fc46	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 22:48:56.178512+00	\N	\N
a3d3838f-970a-4b38-8039-7c1f1535f80b	4e923995-0e57-4430-a1d6-cca9b9261775	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 22:48:56.178512+00	\N	\N
34f26388-28d3-4852-bcfc-7c2f29bf1b69	0a02892e-8476-44da-90e8-384c064e6040	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 22:48:56.178512+00	\N	\N
b0c50639-7a36-4e81-a8c5-471f6d0e660a	032a6335-5776-4677-8881-99db2cef9fe2	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 22:48:56.178512+00	\N	\N
95ff7577-2174-4f5e-aca3-cb182ce6ca73	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 22:48:56.178512+00	\N	\N
a43fbb4d-bd97-4068-9cd9-9e8411ff2852	d048a636-8a14-4fcd-aa3e-891cca899b32	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 22:48:56.178512+00	\N	\N
5db6001d-ff00-49d1-a16c-c5f999a2d080	531392ff-60c0-471d-af30-5e58bc80e860	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 22:48:56.178512+00	\N	\N
c649a6bb-4a82-456d-9cb1-d7169ab6296f	e5d5a97e-19e2-42a9-88fa-916eba925885	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 22:48:56.178512+00	\N	\N
786cf097-c1e0-4545-81b1-e22486b1e842	19e004a1-c1f2-4ca5-91d2-4c095058cb84	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 22:48:56.178512+00	\N	\N
67c500d8-c036-4130-bf2f-0cfd85127648	bce0ddee-4001-45e9-b323-719f80dc4f6d	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 22:48:56.178512+00	\N	\N
184b81d5-5001-448d-8fd9-05451b3ae25e	2b2cb673-f574-4f99-b152-c4f9c438ab0c	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 22:48:56.178512+00	\N	\N
b3a4d595-9508-4934-98f0-78143a74cb3e	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-03 22:48:56.178512+00	\N	\N
efdef07e-0a3a-45ac-9ec1-3cdaa1f87ab0	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-03 22:48:56.178512+00	\N	\N
34d0d077-e0a4-4810-9f67-1915473fe511	e8b3c430-2162-413b-8560-9e3a43e3577e	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-03 22:48:56.178512+00	\N	\N
fdb7831e-aef2-4660-ae31-6fdf96496e7e	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Andrés (Master) fue suspendido del examen "tes" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. Salida de pantalla completa — 06:47:29 p. m.\n2. Salida de pestaña/ventana — 06:48:48 p. m.\n3. Salida de pantalla completa — 06:49:43 p. m.	exam_integrity_staff	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-03 23:49:44.13847+00	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e
842f50d1-712d-414a-b97a-8ab84082356e	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen marcado como sospechoso	Tu intento del examen "tes" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-05-03 23:49:44.13847+00	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e
5a79e509-45a6-4a09-bb9e-269c8b8600f4	dac41f00-64e7-40b8-a207-31f1ee2718c0	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-03 22:48:56.178512+00	\N	\N
3e9d8232-6dfb-4777-af31-a1f443ed0154	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Nuevo taller disponible	Se ha publicado el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-03 22:48:56.178512+00	\N	\N
e32c9cdf-19d2-4c57-b57a-a05429feb49b	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Andrés (Master) fue suspendido del examen "tes" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. Salida de pestaña/ventana — 05:24:50 p. m.\n2. Salida de pestaña/ventana — 05:25:02 p. m.\n3. Salida de pestaña/ventana — 05:25:40 p. m.	exam_integrity_staff	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-04 22:25:40.638159+00	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e
78c696ce-2070-489c-bf6e-36bcaa705034	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen marcado como sospechoso	Tu intento del examen "tes" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-05-04 22:25:40.638159+00	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e
d12a8de8-81aa-424e-b779-e2707f19b211	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Andrés (Master) fue suspendido del examen "tes" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. Salida de pestaña/ventana — 10:01:07 p. m.\n2. Salida de pantalla completa — 10:02:15 p. m.\n3. Salida de pantalla completa — 10:02:22 p. m.	exam_integrity_staff	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-05 03:02:22.913152+00	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e
43d39bd7-1dc9-4d83-b9b4-019c3ff2bdda	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen marcado como sospechoso	Tu intento del examen "tes" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-05-05 03:02:22.913152+00	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e
5d1e8445-cca7-484d-a97a-dd10c7c87305	e8b3c430-2162-413b-8560-9e3a43e3577e	Nuevo comentario del estudiante	Un estudiante respondió a la retroalimentación de una pregunta.	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-05 03:11:31.263906+00	\N	\N
443b8bbc-b151-40a9-95ba-ee9d3064f3d2	e8b3c430-2162-413b-8560-9e3a43e3577e	Nuevo comentario del estudiante	Un estudiante respondió a la retroalimentación de una pregunta.	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-05 03:38:13.801516+00	\N	\N
13747735-5ad5-4211-9524-cc984da95a99	e8b3c430-2162-413b-8560-9e3a43e3577e	Nuevo comentario del estudiante	Un estudiante respondió a la retroalimentación de una pregunta.	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-05 03:39:16.267748+00	\N	\N
cfc68707-2447-4734-bc0b-ed8f561d26a5	e8b3c430-2162-413b-8560-9e3a43e3577e	Nuevo comentario en tes	Test respondió a la retroalimentación.	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632?student=9084565c-58dd-4e35-8793-a9cf198117b3	t	2026-05-05 03:41:04.931015+00	\N	\N
2372e95d-b1b2-41d4-b4af-b9f28194d7d3	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: tes · Pruebas	Test hizo un comentario en la pregunta 1 (intento 1).	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632?student=9084565c-58dd-4e35-8793-a9cf198117b3	t	2026-05-05 03:56:04.003914+00	\N	\N
7ca1b63b-aeec-4870-8b38-ba5fbe0f4358	9084565c-58dd-4e35-8793-a9cf198117b3	Examen asignado	Se te ha asignado el examen "tes"	exam	/app/student/exams	t	2026-05-05 03:09:14.776178+00	\N	\N
84c86958-a1d6-4358-99da-7ccd691c94c6	9084565c-58dd-4e35-8793-a9cf198117b3	Examen: tes · Pruebas	Andrés (Master) respondió a tu retroalimentación en la pregunta 1 (intento 1).	feedback	/app/student/review/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-05 03:57:00.672693+00	\N	\N
2f77bba6-e290-4d43-9ef5-652fffe95a8d	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: tes · Pruebas	Andrés (Master) hizo un comentario en la pregunta 1 (intento 1).	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632?student=e8b3c430-2162-413b-8560-9e3a43e3577e	t	2026-05-06 17:04:14.244502+00	\N	\N
929b1d89-0afd-4a79-b61b-c885eaafe5a9	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Andrés (Master) fue suspendido del examen "tes" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. Salida de pantalla completa — 04:44:13 p. m.\n2. Salida de pantalla completa — 04:45:40 p. m.\n3. Salida de pantalla completa — 04:45:44 p. m.	exam_integrity_staff	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-06 21:45:45.6717+00	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e
7defc96b-4271-4293-9e55-e944d8433b84	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen marcado como sospechoso	Tu intento del examen "tes" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-05-06 21:45:45.6717+00	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e
0345bb8c-272a-4b9c-b117-d853fd210a79	bce0ddee-4001-45e9-b323-719f80dc4f6d	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-06 22:22:20.3819+00	\N	\N
05203965-7d2f-4fd3-a605-34e12652a38b	2d709409-7b44-403d-a315-b8bb826aa8ca	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	t	2026-05-06 22:22:19.822716+00	\N	\N
60b9bf46-35d6-4826-81df-500440144ced	9084565c-58dd-4e35-8793-a9cf198117b3	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 17:52:36.432979+00	\N	\N
25075005-ef05-47be-9589-a75b6f3cbdfc	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 17:52:36.432979+00	\N	\N
bde1f2dc-1b73-48a8-bc58-a6cb4a390bf0	0cf09e84-be38-4adf-8e74-44937461fc46	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 17:52:36.432979+00	\N	\N
be3a78bb-e02a-4fcf-aef7-7aae348ae58f	4e923995-0e57-4430-a1d6-cca9b9261775	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 17:52:36.432979+00	\N	\N
1ae67645-2326-46a8-971c-6add9e153efa	0a02892e-8476-44da-90e8-384c064e6040	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 17:52:36.432979+00	\N	\N
f2550c50-5bc9-442b-9f0f-e4d946fbecd6	032a6335-5776-4677-8881-99db2cef9fe2	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 17:52:36.432979+00	\N	\N
bcbfa645-4eb1-45b4-ade4-33c3873900c3	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 17:52:36.432979+00	\N	\N
5c804b7b-a609-4b77-9dec-1f1859c93527	d048a636-8a14-4fcd-aa3e-891cca899b32	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 17:52:36.432979+00	\N	\N
b683c979-58d7-4591-943a-3840b41d4b1b	531392ff-60c0-471d-af30-5e58bc80e860	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 17:52:36.432979+00	\N	\N
914dcab3-6e0d-429f-a6dc-7437148d18af	e5d5a97e-19e2-42a9-88fa-916eba925885	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 17:52:36.432979+00	\N	\N
3e3c8304-b7f7-451b-bc3a-9b00b82279cc	19e004a1-c1f2-4ca5-91d2-4c095058cb84	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 17:52:36.432979+00	\N	\N
dbbd0f10-b656-4ac0-83c6-74c96c956bb5	bce0ddee-4001-45e9-b323-719f80dc4f6d	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 17:52:36.432979+00	\N	\N
c56fbe42-2806-4ac9-8bc9-59eb53e6f313	2b2cb673-f574-4f99-b152-c4f9c438ab0c	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 17:52:36.432979+00	\N	\N
6db1fdbf-056f-42c1-a6aa-c8998eaa204b	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 17:52:36.432979+00	\N	\N
5830a73b-b25a-4f77-86d6-91a4dd28efa9	e8b3c430-2162-413b-8560-9e3a43e3577e	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-07 17:52:36.432979+00	\N	\N
9cb4a1c6-4a49-4d44-b4af-3db262bfb515	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 22:18:16.381842+00	\N	\N
be96938e-43c8-4a09-b3b6-57b7e1fc82c6	d048a636-8a14-4fcd-aa3e-891cca899b32	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 22:18:16.381842+00	\N	\N
298dbd2b-3cba-4805-af14-7561e1144404	531392ff-60c0-471d-af30-5e58bc80e860	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 22:18:16.381842+00	\N	\N
555c9585-7ff2-45a1-a5a6-9bd0b7ebf880	e5d5a97e-19e2-42a9-88fa-916eba925885	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 22:18:16.381842+00	\N	\N
19674105-97b9-4ee5-a538-4c347a98a268	19e004a1-c1f2-4ca5-91d2-4c095058cb84	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 22:18:16.381842+00	\N	\N
c2529998-b052-433c-b0e1-213a7ba0805d	dac41f00-64e7-40b8-a207-31f1ee2718c0	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-07 17:52:36.432979+00	\N	\N
63d81564-fb65-4a57-a48e-9878ae3aec5d	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-07 17:52:36.432979+00	\N	\N
e61b23d5-d0a1-4487-94bc-cad1859b6ff7	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-07 17:52:36.432979+00	\N	\N
4c91f044-d1a0-4e10-ab4d-406849925972	2d709409-7b44-403d-a315-b8bb826aa8ca	Nuevo taller disponible	Se ha publicado el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-07 17:52:36.432979+00	\N	\N
45703f95-387a-4a39-a02d-9ce68cb23316	2d709409-7b44-403d-a315-b8bb826aa8ca	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-07 22:18:16.381842+00	\N	\N
43608764-3817-4873-a7dd-6c1e43df8ba5	9084565c-58dd-4e35-8793-a9cf198117b3	Examen: tes · Pruebas	El docente cerró la conversación de retroalimentación en la pregunta 1 (intento 1).	feedback	/app/student/review/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-05 03:58:30.799186+00	\N	\N
5ca56006-fbc4-4629-a33f-0703922ebe52	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Andrés (Master) fue suspendido del examen "tes" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. Salida de pestaña/ventana — 12:01:12 p. m.\n2. Salida de pestaña/ventana — 12:02:00 p. m.\n3. Salida de pantalla completa — 12:03:12 p. m.	exam_integrity_staff	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-06 17:03:13.479382+00	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e
0a9f37fb-173d-435f-aff8-a9368efc8ee9	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: tes · Pruebas	Test hizo un comentario en la pregunta 1 (intento 1).	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632?student=9084565c-58dd-4e35-8793-a9cf198117b3	t	2026-05-05 04:14:25.439471+00	\N	\N
3990bc3c-19c6-4118-a825-2426b3f5d123	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen marcado como sospechoso	Tu intento del examen "tes" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-05-06 17:03:13.479382+00	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e
9b74bacc-a294-4213-b621-2e60df7d56be	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: tes · Pruebas	Andrés (Master) respondió a tu retroalimentación en la pregunta 1 (intento 1).	feedback	/app/student/review/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-06 17:04:38.710038+00	\N	\N
0114a89e-d623-4b9d-837a-2a3669d5abdd	9084565c-58dd-4e35-8793-a9cf198117b3	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-06 22:22:09.21664+00	\N	\N
3e4fa062-7a21-4fd9-9444-ab9a50262730	e5d5a97e-19e2-42a9-88fa-916eba925885	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-06 22:22:20.001215+00	\N	\N
0dda7487-6c57-4b37-9b03-3669c7f01624	9084565c-58dd-4e35-8793-a9cf198117b3	Examen: tes · Pruebas	Andrés (Master) respondió a tu retroalimentación en la pregunta 1 (intento 1).	feedback	/app/student/review/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-05 04:30:38.715146+00	\N	\N
8a3cde38-82ef-43cf-b9a8-2dbbb8b8c1cd	9084565c-58dd-4e35-8793-a9cf198117b3	Examen: tes · Pruebas	El docente reabrió la conversación de retroalimentación en la pregunta 1 (intento 1).	feedback	/app/student/review/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-05 04:35:41.984427+00	\N	\N
8c7c27c9-1510-4f8f-8406-b3d32cd9d832	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: tes · Pruebas	Test hizo un comentario en la pregunta 1 (intento 1).	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632?student=9084565c-58dd-4e35-8793-a9cf198117b3	t	2026-05-05 04:29:50.804553+00	\N	\N
2ecd63b0-73d0-4b5e-a98c-eb767d78f33f	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: tes · Pruebas	Test hizo un comentario en la pregunta 1 (intento 1).	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632?student=9084565c-58dd-4e35-8793-a9cf198117b3	t	2026-05-05 04:34:15.142752+00	\N	\N
ccdc26ff-88c6-4593-af02-91d34960a020	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-06 22:22:21.140569+00	\N	\N
4256f173-96e3-45a3-9795-3ff23640ed8d	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: tes · Pruebas	Test hizo un comentario en la pregunta 1 (intento 1).	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632?student=9084565c-58dd-4e35-8793-a9cf198117b3	t	2026-05-05 04:41:49.4658+00	\N	\N
290213ec-92d8-4072-b550-63f152e714fc	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: tes · Pruebas	Test hizo un comentario en la pregunta 1 (intento 1).	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632?student=9084565c-58dd-4e35-8793-a9cf198117b3	t	2026-05-05 04:42:08.464926+00	\N	\N
ad5bc126-e31f-4ba1-ad49-d7855989d603	0cf09e84-be38-4adf-8e74-44937461fc46	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-06 22:22:21.505856+00	\N	\N
6ba8dd2f-48ee-4041-9efb-d40589cd23a3	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: tes · Pruebas	Test hizo un comentario en la pregunta 1 (intento 1).	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632?student=9084565c-58dd-4e35-8793-a9cf198117b3	t	2026-05-05 04:52:47.796929+00	\N	\N
c4a1a224-0058-47b3-aab0-3faf028e2c1c	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: tes · Pruebas	Andrés (Master) respondió a tu retroalimentación en la pregunta 1 (intento 1).	feedback	/app/student/review/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-05 04:57:32.888648+00	\N	\N
be1948b2-ab04-41c0-89c0-cf29b70d58cb	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	Taller actualizado	Se actualizó el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-07 22:17:55.028937+00	\N	\N
c1787204-868e-40a6-9a7d-2120f54d7cd8	0cf09e84-be38-4adf-8e74-44937461fc46	Taller actualizado	Se actualizó el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-07 22:17:55.028937+00	\N	\N
a9ea71ab-6994-4a00-80a5-13303181d790	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: tes · Pruebas	Test hizo un comentario en la pregunta 1 (intento 1).	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632?student=9084565c-58dd-4e35-8793-a9cf198117b3	t	2026-05-05 04:58:56.985188+00	\N	\N
54ce6457-71a0-4505-b060-75a53160c4fb	4e923995-0e57-4430-a1d6-cca9b9261775	Taller actualizado	Se actualizó el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-07 22:17:55.028937+00	\N	\N
c395ee33-6e25-495f-a2e1-5c989b9e2fdb	0a02892e-8476-44da-90e8-384c064e6040	Taller actualizado	Se actualizó el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-07 22:17:55.028937+00	\N	\N
94a4515e-9666-4a73-9aaa-54e9c78f8933	032a6335-5776-4677-8881-99db2cef9fe2	Taller actualizado	Se actualizó el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-07 22:17:55.028937+00	\N	\N
196083a6-b4c0-4794-9421-58c3446b092e	9084565c-58dd-4e35-8793-a9cf198117b3	Examen: tes · Pruebas	Andrés (Master) respondió a tu retroalimentación en la pregunta 1 (intento 1).	feedback	/app/student/review/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-05 04:58:27.695844+00	\N	\N
d709356b-05da-44cd-b22c-d1e9a5ba5f59	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	Taller actualizado	Se actualizó el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-07 22:17:55.028937+00	\N	\N
b8f296c4-7d4e-44e7-96c6-28c498505d27	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: tes · Pruebas	Test hizo un comentario en la pregunta 1 (intento 1).	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632?student=9084565c-58dd-4e35-8793-a9cf198117b3	t	2026-05-05 04:59:15.713337+00	\N	\N
ec405112-0408-4f23-88d7-91817b430aa5	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: tes · Pruebas	Test hizo un comentario en la pregunta 1 (intento 1).	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632?student=9084565c-58dd-4e35-8793-a9cf198117b3	t	2026-05-05 04:59:38.033627+00	\N	\N
c3b7f052-b323-4485-9412-7c846d1f28dc	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: tes · Pruebas	Test hizo un comentario en la pregunta 1 (intento 1).	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632?student=9084565c-58dd-4e35-8793-a9cf198117b3	t	2026-05-05 05:00:02.831284+00	\N	\N
26d6a642-de7a-4c5b-9055-223bb5dde9d6	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: tes · Pruebas	Test hizo un comentario en la pregunta 1 (intento 1).	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632?student=9084565c-58dd-4e35-8793-a9cf198117b3	t	2026-05-05 05:08:41.298276+00	\N	\N
38798022-5731-49ae-b239-728ab7a99c67	d048a636-8a14-4fcd-aa3e-891cca899b32	Taller actualizado	Se actualizó el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	f	2026-05-07 22:17:55.028937+00	\N	\N
734d5016-5bf7-4900-9431-ef7edc018ca9	e8b3c430-2162-413b-8560-9e3a43e3577e	Taller actualizado	Se actualizó el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-07 22:17:55.028937+00	\N	\N
1ddb77b9-816d-4904-887e-ba0dc9dd3795	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	t	2026-05-06 22:22:20.779323+00	\N	\N
16321e5a-5ca7-4e34-9575-4ab04b743116	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-07 22:18:16.381842+00	\N	\N
d264e238-8ab4-4c82-ac77-6733c9d5a3d4	bce0ddee-4001-45e9-b323-719f80dc4f6d	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-07 22:18:16.381842+00	\N	\N
4fdf1abe-11f5-4c37-8986-3f117123dbba	dac41f00-64e7-40b8-a207-31f1ee2718c0	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-07 22:18:16.381842+00	\N	\N
3f61ab1f-d44b-43d2-bd71-f4f95e51ee4f	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: Test Sincronico · Pruebas	Andrés (Master) hizo un comentario en la pregunta 1 (intento 1).	feedback	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632?student=e8b3c430-2162-413b-8560-9e3a43e3577e	t	2026-05-08 00:39:32.74026+00	\N	\N
1258badf-472e-4ddc-ab42-47e5526b3342	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	Examen asignado	Se te ha asignado el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	t	2026-05-06 22:22:20.563865+00	\N	\N
893d1615-fd64-4b02-8ad3-291624c604fe	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	Examen asignado	Se te ha asignado el examen "Quiz - Diagrama de Clases"	exam	/app/student/exams	t	2026-05-01 00:46:20.13028+00	\N	\N
6a17d223-b7be-48df-9fb0-e53130ff7187	9084565c-58dd-4e35-8793-a9cf198117b3	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:02:04.184318+00	\N	\N
5cb56e65-b90b-4e8f-90bf-ba330a0432f8	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:02:04.184318+00	\N	\N
2a15cd5a-111f-4409-b77e-b5ae9b956091	0cf09e84-be38-4adf-8e74-44937461fc46	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:02:04.184318+00	\N	\N
e520e345-6437-41f5-8e7d-2e91aa648cb5	4e923995-0e57-4430-a1d6-cca9b9261775	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:02:04.184318+00	\N	\N
f28c636c-8d9d-4446-8139-b7f59b9dac45	0a02892e-8476-44da-90e8-384c064e6040	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:02:04.184318+00	\N	\N
26b8407c-5b5f-4454-8ffb-277ac7bc5e4c	032a6335-5776-4677-8881-99db2cef9fe2	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:02:04.184318+00	\N	\N
a60a2463-4542-4c06-94ef-9aa13bfa4967	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:02:04.184318+00	\N	\N
37650773-508f-4268-9c8c-3ac02cce3fb3	d048a636-8a14-4fcd-aa3e-891cca899b32	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:02:04.184318+00	\N	\N
e8ee191c-f639-4293-9194-cbdabc442312	531392ff-60c0-471d-af30-5e58bc80e860	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:02:04.184318+00	\N	\N
bf0e0cd3-5bf6-4887-935f-e1043074dc21	e5d5a97e-19e2-42a9-88fa-916eba925885	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:02:04.184318+00	\N	\N
93d2eb02-67c3-481a-a8f7-fc13578f0728	19e004a1-c1f2-4ca5-91d2-4c095058cb84	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:02:04.184318+00	\N	\N
2c9a205e-a8b1-4a19-a7a6-d9eb138e9aad	bce0ddee-4001-45e9-b323-719f80dc4f6d	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:02:04.184318+00	\N	\N
f7f75033-e9e1-4e0e-a15c-6446bff3d440	2b2cb673-f574-4f99-b152-c4f9c438ab0c	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:02:04.184318+00	\N	\N
f259bf4b-90df-4402-b806-53ab8ccfed6d	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:02:04.184318+00	\N	\N
ffe7cb23-0f54-4c63-bded-dee8cd1ba9ba	dac41f00-64e7-40b8-a207-31f1ee2718c0	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:02:04.184318+00	\N	\N
0f0224fa-c9fe-49d6-bfbf-3619a04bb17a	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	t	2026-05-08 01:02:04.184318+00	\N	\N
c6d86c05-93ab-4767-ac03-722dc168a1e6	9084565c-58dd-4e35-8793-a9cf198117b3	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:03:35.374854+00	\N	\N
301b698c-8f17-4d05-ab68-d3a583fd9c69	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:03:35.374854+00	\N	\N
68b94f9f-d4be-46cf-993d-6bef21d186a6	0cf09e84-be38-4adf-8e74-44937461fc46	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:03:35.374854+00	\N	\N
1f8c2e8b-f2ad-436c-b4ac-b4951da49391	4e923995-0e57-4430-a1d6-cca9b9261775	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:03:35.374854+00	\N	\N
371556d2-23e8-48b2-83e1-c8596f752200	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Andrés (Master) fue suspendido del examen "Test Sincronico" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. Salida de pestaña/ventana — 07:15:21 p. m.\n2. Salida de pestaña/ventana — 07:15:36 p. m.\n3. Salida de pestaña/ventana — 07:22:42 p. m.	exam_integrity_staff	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-08 00:22:44.765382+00	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e
530f9025-06f4-483d-b93a-6d5efcb50015	e8b3c430-2162-413b-8560-9e3a43e3577e	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	t	2026-05-08 01:02:04.184318+00	\N	\N
30b0ae3e-fdc9-45bd-b0bb-d48243731989	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	t	2026-05-08 01:02:04.184318+00	\N	\N
7d081889-5697-4103-98ef-6c305fdb6bcd	2d709409-7b44-403d-a315-b8bb826aa8ca	Nuevo examen disponible	Se ha publicado el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	t	2026-05-08 01:02:04.184318+00	\N	\N
be516bd7-24c1-4f6a-bc19-626ef322a7b0	0a02892e-8476-44da-90e8-384c064e6040	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:03:35.374854+00	\N	\N
58fe2e09-9c8a-45d7-8482-ab63035b2c48	032a6335-5776-4677-8881-99db2cef9fe2	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:03:35.374854+00	\N	\N
8dba7c5c-de2f-4caa-b721-6b0632545ba5	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:03:35.374854+00	\N	\N
799211fd-b299-456d-b689-b30a64dc1abc	d048a636-8a14-4fcd-aa3e-891cca899b32	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:03:35.374854+00	\N	\N
eb79097f-2608-4d8d-8dc5-dacb129e78ca	531392ff-60c0-471d-af30-5e58bc80e860	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:03:35.374854+00	\N	\N
ce22e71f-94a7-497e-9d05-9749b90422a6	e5d5a97e-19e2-42a9-88fa-916eba925885	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:03:35.374854+00	\N	\N
1ef68ba0-2f5c-41b8-a781-53177c562b1b	19e004a1-c1f2-4ca5-91d2-4c095058cb84	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:03:35.374854+00	\N	\N
c9ba98c0-6c88-4580-b32c-375b0f835df3	bce0ddee-4001-45e9-b323-719f80dc4f6d	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:03:35.374854+00	\N	\N
0acf8bd5-2c72-4c6a-b6fc-10850dbcf585	2b2cb673-f574-4f99-b152-c4f9c438ab0c	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:03:35.374854+00	\N	\N
4263d016-baf5-4d5f-a70e-8d8e5e5013a4	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:03:35.374854+00	\N	\N
7813ec9b-d2d0-4771-aa2f-e71e1d49fb2e	dac41f00-64e7-40b8-a207-31f1ee2718c0	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:03:35.374854+00	\N	\N
e0a33a44-a5da-445b-9285-d8b1b0a542af	531392ff-60c0-471d-af30-5e58bc80e860	Examen marcado como sospechoso	Tu intento del examen "Quiz - HashMap & Hashset" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	f	2026-05-08 01:09:03.206456+00	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	531392ff-60c0-471d-af30-5e58bc80e860
ac052f44-4cb6-40eb-a126-68b456a9a040	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen marcado como sospechoso	Tu intento del examen "Test Sincronico" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-05-08 00:22:44.765382+00	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e
f1c0c126-a126-4183-9a70-26d687f184c2	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: Test Sincronico · Pruebas	Andrés (Master) respondió a tu retroalimentación en la pregunta 1 (intento 1).	feedback	/app/student/review/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-08 00:39:57.371169+00	\N	\N
854e76ec-9739-4154-b30b-2a5dd46bc047	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Andrés (Master) fue suspendido del examen "Test Sincronico" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. Salida de pestaña/ventana — 07:59:38 p. m.\n2. Salida de pantalla completa — 07:59:44 p. m.\n3. Salida de pestaña/ventana — 07:59:57 p. m.	exam_integrity_staff	/app/teacher/monitor/2c29880e-df95-4650-9653-3f6b72cc7632	t	2026-05-08 01:00:00.928445+00	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e
5614481e-1560-4669-b458-ea9a8a5f44f6	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen marcado como sospechoso	Tu intento del examen "Test Sincronico" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-05-08 01:00:00.928445+00	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e
b6b01793-99bd-4c4d-922d-f4f035a064dd	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	t	2026-05-08 01:03:35.374854+00	\N	\N
92799670-75cf-4da7-b59d-d0ed29abf5c3	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Mera Manrique Yan Andres fue suspendido del examen "Quiz - HashMap & Hashset" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. Salida de pestaña/ventana — 08:05:59 p. m.\n2. Salida de pestaña/ventana — 08:06:23 p. m.\n3. Salida de pestaña/ventana — 08:09:00 p. m.	exam_integrity_staff	/app/teacher/monitor/174074b0-5e6f-4c2c-8dde-05b1bfe712dd	t	2026-05-08 01:09:03.206456+00	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	531392ff-60c0-471d-af30-5e58bc80e860
bc203628-0744-47e2-b9ea-e88f15b0a918	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Calvo Verdugo Cristian Camilo fue suspendido del examen "Quiz - HashMap & Hashset" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. Salida de pestaña/ventana — 08:17:46 p. m.\n2. Salida de pestaña/ventana — 08:19:54 p. m.\n3. Salida de pestaña/ventana — 08:21:01 p. m.	exam_integrity_staff	/app/teacher/monitor/174074b0-5e6f-4c2c-8dde-05b1bfe712dd	t	2026-05-08 01:21:02.889032+00	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	b5074b3a-eb95-43dd-9224-bd3db8c27ef8
463f7fac-938b-4409-8748-e8993ee503d0	2b2cb673-f574-4f99-b152-c4f9c438ab0c	Examen marcado como sospechoso	Tu intento del examen "Quiz - HashMap & Hashset" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	f	2026-05-08 01:41:30.064781+00	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	2b2cb673-f574-4f99-b152-c4f9c438ab0c
8bd1321f-dc16-475c-a221-cbc1b677760e	bce0ddee-4001-45e9-b323-719f80dc4f6d	Examen marcado como sospechoso	Tu intento del examen "Quiz - HashMap & Hashset" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	f	2026-05-08 01:41:36.139196+00	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	bce0ddee-4001-45e9-b323-719f80dc4f6d
7420c705-16a5-47c1-acb0-bb32bb07b4b1	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Alonso Dominguez Juan Carlos fue suspendido del examen "Quiz - HashMap & Hashset" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. Salida de pestaña/ventana — 08:32:48 p. m.\n2. Salida de pestaña/ventana — 08:41:01 p. m.\n3. Salida de pestaña/ventana — 08:41:28 p. m.	exam_integrity_staff	/app/teacher/monitor/174074b0-5e6f-4c2c-8dde-05b1bfe712dd	t	2026-05-08 01:41:30.064781+00	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	2b2cb673-f574-4f99-b152-c4f9c438ab0c
21c4dbaa-1e83-4c3c-8617-4fc99b73b981	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Nuevo taller disponible	Se ha publicado el taller "Taller # 1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-03 16:48:31.936948+00	\N	\N
0e127350-882a-46e1-bbe7-99c093f43068	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Taller actualizado	Se actualizó el taller "Taller #1 - Diagrama de Clases con Mermaid"	workshop	/app/student/workshops	t	2026-05-07 22:17:55.028937+00	\N	\N
26e8b9cc-473c-4d87-be79-dad990dcaebf	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-07 22:18:16.381842+00	\N	\N
844ebb45-a947-4b1e-9c42-15989bf047c4	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	t	2026-05-08 01:03:35.374854+00	\N	\N
5ba425a7-bf32-4330-8350-492651a63086	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	t	2026-05-08 01:03:35.374854+00	\N	\N
7e8ffc17-5f49-45cf-a776-9758cde9555d	2d709409-7b44-403d-a315-b8bb826aa8ca	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	t	2026-05-08 01:03:35.374854+00	\N	\N
31d2985f-fa3d-4a0c-b712-d0c5c5f735a7	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: Quiz - HashMap & Hashset · Programación II	Aguado Becerra Juan Sebastian hizo un comentario en la pregunta 2 (intento 1).	feedback	/app/teacher/monitor/174074b0-5e6f-4c2c-8dde-05b1bfe712dd?student=dac41f00-64e7-40b8-a207-31f1ee2718c0	t	2026-05-08 01:50:46.206965+00	\N	\N
496d4afe-ed56-4d90-9875-ec16ff96b45f	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen sospechoso	Cruz Marines Samuel David fue suspendido del examen "Quiz - HashMap & Hashset" por superar el límite de 3 advertencias.\n\nAcciones detectadas:\n1. Salida de pantalla completa — 08:28:34 p. m.\n2. Salida de pestaña/ventana — 08:41:33 p. m.\n3. Salida de pantalla completa — 08:41:34 p. m.	exam_integrity_staff	/app/teacher/monitor/174074b0-5e6f-4c2c-8dde-05b1bfe712dd	t	2026-05-08 01:41:36.139196+00	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	bce0ddee-4001-45e9-b323-719f80dc4f6d
2df3ca1a-25dc-457b-bb5c-21e96734700e	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Examen asignado	Se te ha asignado el examen "Copia de Parcial II - Programacion II"	exam	/app/student/exams	t	2026-05-03 17:59:00.711069+00	\N	\N
dc402ca9-f5ea-4fce-9c5f-e52a55e2c710	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Examen marcado como sospechoso	Tu intento del examen "Quiz - HashMap & Hashset" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.	exam_integrity_student	/app/student/exams	t	2026-05-08 01:21:02.889032+00	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	b5074b3a-eb95-43dd-9224-bd3db8c27ef8
1d693478-5900-453c-8ab5-428ba2fafe36	9084565c-58dd-4e35-8793-a9cf198117b3	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:51:00.592128+00	\N	\N
708b292a-83b3-492b-b2b0-26a5ddfa2598	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:51:00.592128+00	\N	\N
d578aab2-7159-44e9-8987-de2df09d90f6	4e923995-0e57-4430-a1d6-cca9b9261775	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:51:00.592128+00	\N	\N
b2afd28b-f491-4d01-8ce9-1f6ed96714ff	0a02892e-8476-44da-90e8-384c064e6040	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:51:00.592128+00	\N	\N
4716321b-5685-4709-a7c4-a8815937e7d9	032a6335-5776-4677-8881-99db2cef9fe2	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:51:00.592128+00	\N	\N
f4de8a69-c64b-48c3-960d-1cd918c5d106	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:51:00.592128+00	\N	\N
b14b5970-e879-42cd-8798-e120083e6886	d048a636-8a14-4fcd-aa3e-891cca899b32	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:51:00.592128+00	\N	\N
a19d19ae-b74c-416d-99d5-83fdf8174241	531392ff-60c0-471d-af30-5e58bc80e860	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:51:00.592128+00	\N	\N
e487b348-c043-4168-b7da-d32f6e1c6404	e5d5a97e-19e2-42a9-88fa-916eba925885	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:51:00.592128+00	\N	\N
fe323ba8-a994-421a-abcc-34206b5b4bff	19e004a1-c1f2-4ca5-91d2-4c095058cb84	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:51:00.592128+00	\N	\N
31765695-7e59-4760-b9fb-72ea77c6f50f	bce0ddee-4001-45e9-b323-719f80dc4f6d	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:51:00.592128+00	\N	\N
7a3d7ee2-d65b-4d68-a586-a267abebda42	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:51:00.592128+00	\N	\N
43c44f35-87c8-4d80-be4b-a9de858fd3f5	2b2cb673-f574-4f99-b152-c4f9c438ab0c	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:51:00.592128+00	\N	\N
7a5b013f-1ee7-4e18-8b7e-9144b4326c60	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:51:00.592128+00	\N	\N
abe8ca7b-2200-438d-96b9-7be0db199b22	dac41f00-64e7-40b8-a207-31f1ee2718c0	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	f	2026-05-08 01:51:00.592128+00	\N	\N
971edf1f-ee68-4ce9-b500-63d4ff209f5f	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	t	2026-05-08 01:51:00.592128+00	\N	\N
6d68cc19-b67e-45b0-84ff-0c805995d70e	9084565c-58dd-4e35-8793-a9cf198117b3	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-08 01:52:40.965253+00	\N	\N
e083a3f7-fef0-4556-8563-8ae3d9c51e0d	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-08 01:52:40.965253+00	\N	\N
5030c4f2-fce0-44c4-be6d-fc42264642f1	4e923995-0e57-4430-a1d6-cca9b9261775	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-08 01:52:40.965253+00	\N	\N
94dc1323-335d-4595-a027-6d6f1abb4b8b	0a02892e-8476-44da-90e8-384c064e6040	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-08 01:52:40.965253+00	\N	\N
dd93f000-2cb8-4628-a32b-07c83ab10743	032a6335-5776-4677-8881-99db2cef9fe2	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-08 01:52:40.965253+00	\N	\N
e09ff5c4-8207-45ec-a2a3-845d146f9484	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-08 01:52:40.965253+00	\N	\N
98e82df8-9b3d-4b43-9fde-a9af461154a0	d048a636-8a14-4fcd-aa3e-891cca899b32	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-08 01:52:40.965253+00	\N	\N
a6b3faba-777a-41d2-87e7-f2cd41debbfd	531392ff-60c0-471d-af30-5e58bc80e860	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-08 01:52:40.965253+00	\N	\N
03f7c07c-38ea-4570-8ce8-bc1820a5a2b4	e5d5a97e-19e2-42a9-88fa-916eba925885	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-08 01:52:40.965253+00	\N	\N
3c1138c0-8bae-462b-9f5d-6a9fc69ae8bf	19e004a1-c1f2-4ca5-91d2-4c095058cb84	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-08 01:52:40.965253+00	\N	\N
f276eed2-6489-438a-9976-beb5de1bf8c3	bce0ddee-4001-45e9-b323-719f80dc4f6d	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-08 01:52:40.965253+00	\N	\N
27344401-105f-46f8-be1b-84927233eefd	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-08 01:52:40.965253+00	\N	\N
7c2216b3-ef51-4e6f-b283-437f89ea2513	2b2cb673-f574-4f99-b152-c4f9c438ab0c	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-08 01:52:40.965253+00	\N	\N
511bef11-61de-4fd7-b284-8bf8973ae5fc	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-08 01:52:40.965253+00	\N	\N
07b93984-4354-47dd-a8cf-dcf01e1d19c2	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-08 01:52:40.965253+00	\N	\N
5a7d5607-d0bf-482f-b98f-6eee4bef50f6	0cf09e84-be38-4adf-8e74-44937461fc46	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-08 01:52:40.965253+00	\N	\N
80a3af33-fde1-4c48-a26f-3d08ed97ca12	0cf09e84-be38-4adf-8e74-44937461fc46	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	t	2026-05-08 01:51:00.592128+00	\N	\N
d56ed473-a28c-4e49-9704-553c5f3bdb5c	2d709409-7b44-403d-a315-b8bb826aa8ca	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-08 01:52:40.965253+00	\N	\N
422703c0-8dfb-4bee-8694-d37acf6d9ac4	2d709409-7b44-403d-a315-b8bb826aa8ca	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	t	2026-05-08 01:51:00.592128+00	\N	\N
33f1d80d-9443-44da-8ff6-b977bf4b6907	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: Quiz - HashMap & Hashset · Programación II	Aguado Becerra Juan Sebastian hizo un comentario en la pregunta 1 (intento 1).	feedback	/app/teacher/monitor/174074b0-5e6f-4c2c-8dde-05b1bfe712dd?student=dac41f00-64e7-40b8-a207-31f1ee2718c0	t	2026-05-08 01:51:41.567103+00	\N	\N
235e03f8-255a-463a-b766-5995ca3ca2f4	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen actualizado	Se actualizó el examen "Quiz - HashMap & Hashset"	exam	/app/student/exams	t	2026-05-08 01:51:00.592128+00	\N	\N
b22a6193-b999-4085-89bc-ee09f6db9af6	e8b3c430-2162-413b-8560-9e3a43e3577e	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	t	2026-05-08 01:52:40.965253+00	\N	\N
5cffd44b-d04b-4f73-9ff1-49a9d35a1ad7	dac41f00-64e7-40b8-a207-31f1ee2718c0	Taller actualizado	Se actualizó el taller "Taller #2  - HashSet & HashMap"	workshop	/app/student/workshops	f	2026-05-08 01:52:40.965253+00	\N	\N
89cf22b8-04b2-4db1-af7c-45465329e772	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: Quiz - HashMap & Hashset · Programación II	Calvo Verdugo Cristian Camilo hizo un comentario en la pregunta 2 (intento 1).	feedback	/app/teacher/monitor/174074b0-5e6f-4c2c-8dde-05b1bfe712dd?student=b5074b3a-eb95-43dd-9224-bd3db8c27ef8	t	2026-05-08 03:02:28.420465+00	\N	\N
c6557888-04ca-40e9-9b2f-a0945dee0c87	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Examen: Quiz - HashMap & Hashset · Programación II	Andrés (Master) respondió a tu retroalimentación en la pregunta 2 (intento 1).	feedback	/app/student/review/174074b0-5e6f-4c2c-8dde-05b1bfe712dd	f	2026-05-08 14:35:02.808663+00	\N	\N
bcc6d305-43c2-40a4-ab47-82009adf38b5	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen: Quiz - HashMap & Hashset · Programación II	Aguado Becerra Juan Sebastian hizo un comentario en la pregunta 1 (intento 1).	feedback	/app/teacher/monitor/174074b0-5e6f-4c2c-8dde-05b1bfe712dd?student=dac41f00-64e7-40b8-a207-31f1ee2718c0	t	2026-05-08 01:52:00.2301+00	\N	\N
e522c4e8-e0ea-4ead-aedb-9d7f8f840c03	dac41f00-64e7-40b8-a207-31f1ee2718c0	Examen: Quiz - HashMap & Hashset · Programación II	Andrés (Master) respondió a tu retroalimentación en la pregunta 1 (intento 1).	feedback	/app/student/review/174074b0-5e6f-4c2c-8dde-05b1bfe712dd	f	2026-05-08 14:36:21.787216+00	\N	\N
6da6f748-6d13-4363-a845-bc65a53e50af	dac41f00-64e7-40b8-a207-31f1ee2718c0	Examen: Quiz - HashMap & Hashset · Programación II	El docente cerró la conversación de retroalimentación en la pregunta 1 (intento 1).	feedback	/app/student/review/174074b0-5e6f-4c2c-8dde-05b1bfe712dd	f	2026-05-08 14:36:27.656847+00	\N	\N
6462d7f8-4148-400b-b094-f603947a4072	dac41f00-64e7-40b8-a207-31f1ee2718c0	Examen: Quiz - HashMap & Hashset · Programación II	Andrés (Master) respondió a tu retroalimentación en la pregunta 2 (intento 1).	feedback	/app/student/review/174074b0-5e6f-4c2c-8dde-05b1bfe712dd	f	2026-05-08 14:51:29.596301+00	\N	\N
db913acb-5910-4b9e-bf1c-c98cde74e512	9084565c-58dd-4e35-8793-a9cf198117b3	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-08 16:14:50.094675+00	\N	\N
42efb5c5-f5be-4c81-832f-6b9692ac9b1d	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-08 16:14:50.094675+00	\N	\N
3549c7f3-f4dc-4f8c-a8aa-6f55fb76de4a	0cf09e84-be38-4adf-8e74-44937461fc46	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-08 16:14:50.094675+00	\N	\N
28d6d5ac-eaae-4d4e-9205-ebed98b61e3a	4e923995-0e57-4430-a1d6-cca9b9261775	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-08 16:14:50.094675+00	\N	\N
42ffa2ba-465c-4fff-95e3-941032debb6b	0a02892e-8476-44da-90e8-384c064e6040	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-08 16:14:50.094675+00	\N	\N
25ab3e4f-08ba-425b-830f-0a78a7149ed2	032a6335-5776-4677-8881-99db2cef9fe2	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-08 16:14:50.094675+00	\N	\N
ed7a339e-341e-48c6-a7dd-97624bd1e658	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-08 16:14:50.094675+00	\N	\N
afaecad0-cc43-4eb1-ae45-6cb112101502	d048a636-8a14-4fcd-aa3e-891cca899b32	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-08 16:14:50.094675+00	\N	\N
59e50d1a-b3f9-496a-a117-c5935c609b33	531392ff-60c0-471d-af30-5e58bc80e860	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-08 16:14:50.094675+00	\N	\N
6cf50418-df1d-417a-b4db-99fc9a3919b0	2d709409-7b44-403d-a315-b8bb826aa8ca	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-08 16:14:50.094675+00	\N	\N
5c2f732f-ca3d-419d-a0c5-5710b1810c2e	e5d5a97e-19e2-42a9-88fa-916eba925885	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-08 16:14:50.094675+00	\N	\N
56584fde-e316-4bd6-9c58-c8b4b66de50b	19e004a1-c1f2-4ca5-91d2-4c095058cb84	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-08 16:14:50.094675+00	\N	\N
7e7796c9-c01a-4e0d-857f-cd02c3b86dc8	bce0ddee-4001-45e9-b323-719f80dc4f6d	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-08 16:14:50.094675+00	\N	\N
5df96b30-9654-445b-9976-79489cab120f	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-08 16:14:50.094675+00	\N	\N
d49b9f99-d2e9-41dc-b918-8e236d7afc6a	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-08 16:14:50.094675+00	\N	\N
8963c0dd-7157-4c08-81e0-02d7d42c4777	2b2cb673-f574-4f99-b152-c4f9c438ab0c	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-08 16:14:50.094675+00	\N	\N
7d5ebcb2-89ee-4563-bb90-dcd2fa0e65af	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-08 16:14:50.094675+00	\N	\N
c3a8982d-17e6-4ed5-a5e9-45245a4a38d3	dac41f00-64e7-40b8-a207-31f1ee2718c0	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	f	2026-05-08 16:14:50.094675+00	\N	\N
82d76965-09aa-4ade-ad47-9795725e5de0	e8b3c430-2162-413b-8560-9e3a43e3577e	Examen actualizado	Se actualizó el examen "Parcial II - Seminario de Sistemas"	exam	/app/student/exams	t	2026-05-08 16:14:50.094675+00	\N	\N
\.


--
-- Data for Name: profiles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."profiles" ("id", "full_name", "personal_email", "institutional_email", "created_at", "updated_at") FROM stdin;
e8b3c430-2162-413b-8560-9e3a43e3577e	Andrés (Master)	andres_dfx@hotmail.com	andres_dfx@hotmail.com	2026-04-26 03:05:41.034065+00	2026-04-26 03:05:41.034065+00
ba4c4904-ee75-4e48-bbd1-bfb5792003d8	Velasco Velasco David	davidvelascovelasco361@gmail.com	davidvelasco@estudiante.uniajc.edu.co	2026-04-26 04:19:11.113794+00	2026-04-26 04:19:11.113794+00
4e923995-0e57-4430-a1d6-cca9b9261775	Sanchez Tombe Valentina	vs3004892@gmail.com	vsanchezt@estudiante.uniajc.edu.co	2026-04-26 04:19:12.217289+00	2026-04-26 04:19:12.217289+00
0a02892e-8476-44da-90e8-384c064e6040	Reyes Mompotes Jean Paul	jeanpaulreyes9@gmail.com	jpaulreyes@estudiante.uniajc.edu.co	2026-04-26 04:19:12.703771+00	2026-04-26 04:19:12.703771+00
032a6335-5776-4677-8881-99db2cef9fe2	Murillo Fernandez Leidy Dahiana	leidymf33@gmail.com	ldahianamurillo@estudiante.uniajc.edu.co	2026-04-26 04:19:13.151976+00	2026-04-26 04:19:13.151976+00
cf304ed6-fc61-4b24-a512-17ddc4e2a67c	Murillo Espinosa Angie Paulette	angiepm95@hotmail.com	apmurillo@estudiante.uniajc.edu.co	2026-04-26 04:19:13.59959+00	2026-04-26 04:19:13.59959+00
531392ff-60c0-471d-af30-5e58bc80e860	Mera Manrique Yan Andres	yanmera38@gmail.com	yandresmera@estudiante.uniajc.edu.co	2026-04-26 04:19:14.495836+00	2026-04-26 04:19:14.495836+00
2d709409-7b44-403d-a315-b8bb826aa8ca	Medina Bonilla Julian David	juliiandeiivid3@gmail.com	julianmedina@estudiante.uniajc.edu.co	2026-04-26 04:19:14.923757+00	2026-04-26 04:19:14.923757+00
e5d5a97e-19e2-42a9-88fa-916eba925885	Fonseca Villa John Sebastian	danny_julieth@hotmail.com	jsfonseca@estudiante.uniajc.edu.co	2026-04-26 04:19:15.372584+00	2026-04-26 04:19:15.372584+00
19e004a1-c1f2-4ca5-91d2-4c095058cb84	Diaz Caicedo Rafael Andres	rafael.andres.diaz.caicedo@gmail.com	randresdiaz@estudiante.uniajc.edu.co	2026-04-26 04:19:15.844394+00	2026-04-26 04:19:15.844394+00
bce0ddee-4001-45e9-b323-719f80dc4f6d	Cruz Marines Samuel David	samueldcruz95@gmail.com	sdcruz@estudiante.uniajc.edu.co	2026-04-26 04:19:16.294534+00	2026-04-26 04:19:16.294534+00
2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	Castrillon Cardenas George Michael	michaelcastrillon8@gmail.com	gcastrillon@estudiante.uniajc.edu.co	2026-04-26 04:19:16.768982+00	2026-04-26 04:19:16.768982+00
b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Calvo Verdugo Cristian Camilo	cristiancami2202@gmail.com	ccalvo@estudiante.uniajc.edu.co	2026-04-26 04:19:17.248242+00	2026-04-26 04:19:17.248242+00
2b2cb673-f574-4f99-b152-c4f9c438ab0c	Alonso Dominguez Juan Carlos	carlos.juan.ad@gmail.com	jalonso@estudiante.uniajc.edu.co	2026-04-26 04:19:17.705277+00	2026-04-26 04:19:17.705277+00
25c7499f-7944-40f8-9a72-c1ea5fda7b4f	Alegria Baltan Eyner	eyneralegria92@gmail.com	ealegriab@estudiante.uniajc.edu.co	2026-04-26 04:19:18.152797+00	2026-04-26 04:19:18.152797+00
dac41f00-64e7-40b8-a207-31f1ee2718c0	Aguado Becerra Juan Sebastian	jaguadobecerra@gmail.com	jsaguado@estudiante.uniajc.edu.co	2026-04-26 04:19:18.580195+00	2026-04-26 04:19:18.580195+00
d048a636-8a14-4fcd-aa3e-891cca899b32	Mina Advincula Julio Francisco	champion2406@hotmail.com	jfranciscomina@estudiante.uniajc.edu.co	2026-04-26 04:19:14.037366+00	2026-05-08 01:04:14.080203+00
0cf09e84-be38-4adf-8e74-44937461fc46	Serrano Garcia Joan Sebastian	sebasegar2006@gmail.com	joansserrano@estudiante.uniajc.edu.co	2026-04-26 04:19:11.617171+00	2026-05-01 01:19:33.619663+00
9084565c-58dd-4e35-8793-a9cf198117b3	Test	test@test.com	test@test.com	2026-05-05 03:08:06.970623+00	2026-05-05 03:08:06.970623+00
\.


--
-- Data for Name: project_assignments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."project_assignments" ("id", "project_id", "user_id", "created_at") FROM stdin;
042b5cf2-2f39-4608-834c-373fbaa5d966	6e7c4db6-8dd5-416b-a965-731ed86545b9	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-05-03 19:19:45.43838+00
6d1fe097-6ac3-4fb5-84a7-e87ddfab875e	6e7c4db6-8dd5-416b-a965-731ed86545b9	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	2026-05-03 19:19:45.43838+00
8c4a895a-3e56-437b-834e-f27d068965c6	6e7c4db6-8dd5-416b-a965-731ed86545b9	0cf09e84-be38-4adf-8e74-44937461fc46	2026-05-03 19:19:45.43838+00
eaf65543-ab27-49b7-a7a6-0d223de67fc2	6e7c4db6-8dd5-416b-a965-731ed86545b9	4e923995-0e57-4430-a1d6-cca9b9261775	2026-05-03 19:19:45.43838+00
882a151a-ec04-4049-ab53-6cd9148f9490	6e7c4db6-8dd5-416b-a965-731ed86545b9	0a02892e-8476-44da-90e8-384c064e6040	2026-05-03 19:19:45.43838+00
d237dfb9-22c2-422a-8efd-fb1dedaf13e4	6e7c4db6-8dd5-416b-a965-731ed86545b9	032a6335-5776-4677-8881-99db2cef9fe2	2026-05-03 19:19:45.43838+00
020565be-f90f-46cc-bc12-7c58f3dab091	6e7c4db6-8dd5-416b-a965-731ed86545b9	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	2026-05-03 19:19:45.43838+00
06f5d5d3-b6a2-4a00-835d-3937cce8efe2	6e7c4db6-8dd5-416b-a965-731ed86545b9	d048a636-8a14-4fcd-aa3e-891cca899b32	2026-05-03 19:19:45.43838+00
7ee19bfe-e7c4-41f6-95a1-e08787a56462	6e7c4db6-8dd5-416b-a965-731ed86545b9	531392ff-60c0-471d-af30-5e58bc80e860	2026-05-03 19:19:45.43838+00
c03590f5-f61c-4cdd-8101-b4ebca93b808	6e7c4db6-8dd5-416b-a965-731ed86545b9	2d709409-7b44-403d-a315-b8bb826aa8ca	2026-05-03 19:19:45.43838+00
8f98972f-9dfa-4aec-b951-295b41e57a37	6e7c4db6-8dd5-416b-a965-731ed86545b9	e5d5a97e-19e2-42a9-88fa-916eba925885	2026-05-03 19:19:45.43838+00
f88ee3a7-312e-451f-846f-8599c5279a24	6e7c4db6-8dd5-416b-a965-731ed86545b9	19e004a1-c1f2-4ca5-91d2-4c095058cb84	2026-05-03 19:19:45.43838+00
2840c0a6-3cde-4e1f-804c-001d944e5d16	6e7c4db6-8dd5-416b-a965-731ed86545b9	bce0ddee-4001-45e9-b323-719f80dc4f6d	2026-05-03 19:19:45.43838+00
dec45651-42c8-4307-b746-2a70d536d026	6e7c4db6-8dd5-416b-a965-731ed86545b9	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	2026-05-03 19:19:45.43838+00
ea674111-d79e-45fb-ae5c-b337c30e9886	6e7c4db6-8dd5-416b-a965-731ed86545b9	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	2026-05-03 19:19:45.43838+00
ba04b363-371c-4813-8a75-6bbbb0f696f8	6e7c4db6-8dd5-416b-a965-731ed86545b9	2b2cb673-f574-4f99-b152-c4f9c438ab0c	2026-05-03 19:19:45.43838+00
f1d9657a-4d7d-4dfa-b38d-edcc605d3e4b	6e7c4db6-8dd5-416b-a965-731ed86545b9	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	2026-05-03 19:19:45.43838+00
deb41781-9510-49da-9e8f-ac5111c11606	6e7c4db6-8dd5-416b-a965-731ed86545b9	dac41f00-64e7-40b8-a207-31f1ee2718c0	2026-05-03 19:19:45.43838+00
\.


--
-- Data for Name: project_courses; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."project_courses" ("id", "project_id", "course_id", "created_at") FROM stdin;
a0341a40-08fe-4fe8-90e3-0580953dcf91	6e7c4db6-8dd5-416b-a965-731ed86545b9	0e375073-e9f2-4fda-a295-53407e3d5879	2026-05-03 22:45:03.789296+00
3aa95905-e18b-418e-9bee-0d13b203b2e1	6e7c4db6-8dd5-416b-a965-731ed86545b9	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	2026-05-03 22:45:03.789296+00
\.


--
-- Data for Name: project_files; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."project_files" ("id", "project_id", "position", "title", "description", "expected_rubric", "language", "points", "created_at", "type", "options", "starter_code", "content") FROM stdin;
cb6cfb70-e88b-46e1-8140-63b9b7214472	6e7c4db6-8dd5-416b-a965-731ed86545b9	0	Levantamiento de requisitos	Historias de usuario, alcance y actores del sistema VetCare.	Incluye al menos 6 historias de usuario con criterios de aceptación, alcance claro y actores identificados.	\N	10	2026-05-03 18:00:41.575424+00	abierta	\N	\N	\N
9f9464bc-15f6-44da-8019-38162b636ecb	6e7c4db6-8dd5-416b-a965-731ed86545b9	2	Plan de pruebas (QA)	Casos de prueba documentados (entradas, pasos, resultado esperado).	Mínimo 8 casos cubriendo flujos felices y de error (ej. edad no numérica, archivos corruptos).	\N	10	2026-05-03 18:00:41.575424+00	abierta	\N	\N	\N
a303bc81-4c8f-49b2-aa56-8db02d7d7898	6e7c4db6-8dd5-416b-a965-731ed86545b9	1	Diagramas UML	Diagrama de Casos de Uso y Diagrama de Clases del sistema.	Casos de uso cubren registro de cliente, mascota, cita e historial. Diagrama de clases muestra Cliente, Mascota, Cita con atributos, métodos y relaciones (incluye herencia).	\N	15	2026-05-03 18:00:41.575424+00	diagrama	\N	\N	\N
e270c36e-a739-4901-b64e-957dc8718c58	6e7c4db6-8dd5-416b-a965-731ed86545b9	3	Manual de usuario y arquitectura	Manual de usuario + justificación de la arquitectura elegida.	Manual con capturas, justifica capas/MVC y persistencia en .txt/.csv.	\N	10	2026-05-03 18:00:41.575424+00	abierta	\N	\N	\N
69800d3e-dcff-474e-a4ee-836676d7dd27	6e7c4db6-8dd5-416b-a965-731ed86545b9	4	Código — Modelo POO (Cliente, Mascota, Cita)	Clases del dominio con encapsulamiento y herencia. Demo en main que crea objetos y los lista en una ventana Swing.	Clases bien encapsuladas, uso correcto de herencia, colecciones (List/Map). Compila y la ventana muestra los datos.	java	20	2026-05-03 18:00:41.575424+00	codigo	\N	\N	\N
03c2665e-0c28-499d-b9a5-e8e336488a05	6e7c4db6-8dd5-416b-a965-731ed86545b9	5	Código — GUI principal con manejo de errores	Ventana Swing/JavaFX con formulario de registro de mascota y agenda de citas. Try-catch para entradas inválidas.	GUI funcional, valida edad numérica, no se cierra ante errores, navegación entre vistas.	java	20	2026-05-03 18:00:41.575424+00	java_gui	\N	\N	\N
98146289-46b6-46c8-ba0c-a60c3f81b936	6e7c4db6-8dd5-416b-a965-731ed86545b9	6	Código — Persistencia básica	Lectura/escritura de datos en .txt o .csv al iniciar/cerrar la app, demostrada en una ventana Swing.	Persiste y recupera registros, maneja archivo inexistente, demuestra el ciclo en pantalla.	java_gui	15	2026-05-03 18:00:41.575424+00	codigo	\N	\N	\N
\.


--
-- Data for Name: project_group_members; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."project_group_members" ("group_id", "user_id", "joined_at") FROM stdin;
\.


--
-- Data for Name: project_groups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."project_groups" ("id", "project_id", "name", "signup_code", "created_by", "created_at") FROM stdin;
\.


--
-- Data for Name: project_submission_attachments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."project_submission_attachments" ("id", "project_submission_file_id", "file_name", "storage_path", "mime_type", "size_bytes", "position", "created_at") FROM stdin;
\.


--
-- Data for Name: project_submission_files; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."project_submission_files" ("id", "submission_id", "file_id", "content", "ai_grade", "ai_feedback", "ai_likelihood", "ai_reasons", "created_at", "updated_at", "selected_option", "zip_path") FROM stdin;
c708f8d6-7e5a-43e7-8c02-a92233dd0422	70bb67c4-580f-4f71-add4-abb80a190de0	cb6cfb70-e88b-46e1-8140-63b9b7214472	Proyecto: VetCare — Sistema de Gestión Veterinaria\nObjetivo\n\nDesarrollar un sistema de escritorio para una clínica veterinaria que permita administrar clientes, mascotas y citas médicas de forma organizada y segura.\n\nRequisitos funcionales\nGestión de clientes\nRegistrar clientes.\nConsultar clientes registrados.\nModificar información de clientes.\nEliminar clientes.\nGestión de mascotas\nRegistrar mascotas.\nAsociar mascotas a un cliente.\nConsultar mascotas registradas.\nEditar información de mascotas.\nGestión de citas\nCrear citas veterinarias.\nConsultar citas programadas.\nCancelar citas.\nValidar que la mascota exista antes de asignar cita.\nInterfaz gráfica\nMostrar menú principal.\nFormularios amigables para captura de datos.\nMostrar mensajes de error y confirmación.\nPersistencia\nGuardar información en archivos.\nCargar información al iniciar el sistema.\nRequisitos no funcionales\nEl sistema debe desarrollarse en Java.\nLa interfaz debe usar Swing/AWT.\nEl sistema debe ser fácil de usar.\nDebe manejar errores de entrada de datos.\nDebe tener arquitectura orientada a objetos.\nActores\nActor\tDescripción\nRecepcionista\tRegistra clientes, mascotas y citas\nVeterinario\tConsulta citas y mascotas\nAdministrador\tControl general del sistema	4	La respuesta proporciona una buena base para el levantamiento de requisitos, pero no cumple con la rúbrica al no incluir historias de usuario con criterios de aceptación. Los requisitos funcionales y no funcionales están bien identificados, así como los actores.  Se esperaban 6 historias de usuario con un formato específico que incluye criterios de aceptación.	0.7	La estructura de la respuesta es muy ordenada y completa en sus secciones. La forma en que desglosa los requisitos funcionales y no funcionales, junto con la identificación de actores, es típica de una generación de IA que sigue un patrón predefinido para levantamiento de requisitos. La ausencia de historias de usuario con criterios de aceptación, a pesar de ser un elemento clave de la rúbrica, podría indicar que la IA no priorizó o no entendió completamente ese requisito específico de formato, o que la instrucción inicial no fue lo suficientemente explícita para que la IA generara ese nivel de detalle en las historias de usuario.	2026-05-07 19:21:38.357251+00	2026-05-07 19:21:38.357251+00	\N	\N
b8e75e4c-158a-4985-acbb-3956667f350d	70bb67c4-580f-4f71-add4-abb80a190de0	a303bc81-4c8f-49b2-aa56-8db02d7d7898	classDiagram\n\nclass Cliente{\n    -String nombre\n    -String telefono\n    -String direccion\n    +registrarCliente()\n    +mostrarInformacion()\n}\n\nclass Mascota{\n    -String nombre\n    -String especie\n    -int edad\n    +registrarMascota()\n    +mostrarMascota()\n}\n\nclass Cita{\n    -String fecha\n    -String motivo\n    +crearCita()\n    +mostrarCita()\n}\n\nCliente "1" --> "*" Mascota : posee\nMascota "1" --> "*" Cita : tiene	10	El diagrama de clases es sintácticamente válido y se representa correctamente. Se incluyen atributos, métodos y relaciones entre Cliente, Mascota y Cita. Sin embargo, no se observa herencia en el diagrama y tampoco se aborda la parte de casos de uso ni de historial, solamente la del diagrama de clases.	0.3	La respuesta es un diagrama de clases que es una parte de lo que se pide en el prompt. No cubre los otros puntos. Sin embargo, no es poco común que un estudiante no responda a la totalidad de la pregunta, o que priorice algunos aspectos. La salida parece venir de un estudiante que respondió parcialmente la pregunta.	2026-05-07 19:21:41.471348+00	2026-05-07 19:21:41.471348+00	\N	\N
86dc435c-6c8e-4c51-bfdf-fd6318fa2275	70bb67c4-580f-4f71-add4-abb80a190de0	9f9464bc-15f6-44da-8019-38162b636ecb	Objetivo\n\nValidar el correcto funcionamiento del sistema VetCare.\n\nCasos de prueba\nID\tCaso de prueba\tEntrada\tResultado esperado\nCP-01\tRegistrar cliente\tNombre y teléfono válidos\tCliente registrado\nCP-02\tRegistrar mascota\tMascota con dueño válido\tMascota registrada\nCP-03\tCrear cita\tDatos válidos\tCita creada\nCP-04\tCampos vacíos\tFormulario vacío\tMostrar mensaje de error\nCP-05\tEdad inválida\tLetras en edad\tMostrar excepción\nCP-06\tGuardar datos\tInformación registrada\tArchivo generado\nCP-07\tCargar datos\tArchivo existente\tInformación cargada\nEstrategia QA\nPruebas funcionales.\nPruebas de interfaz.\nValidación de excepciones.\nValidación de persistencia.\nVerificación manual de flujos.	6	La respuesta del estudiante presenta un buen inicio para un plan de pruebas, destacando los casos de prueba y la estrategia de QA. Sin embargo, no cumple completamente con la rúbrica al no alcanzar un mínimo de 8 casos que cubran flujos felices y de error de manera explícita y detallada en su cobertura de datos de prueba. Se identifican 7 casos, uno menos de los requeridos. Además, la descripción de los "flujos de error" es un poco básica y podría expandirse con ejemplos concretos para la entrada de datos (ej. archivos corruptos).	0.6	La estructura y el lenguaje son concisos y organizados, lo cual es común en respuestas generadas por IA. No obstante, el contenido específico y la ligera deficiencia en la cantidad de casos sugieren que podría ser una base generada por IA y luego adaptada o completada por un humano, o bien que ha pasado por el proceso inverso, siendo una respuesta humana que se ha esforzado en ser concisa y clara como lo haría una IA. La falta de un caso concreto "CP-08" en la lista sugiere que no completó la tarea de manera exhaustiva en cuanto a la cantidad solicitada. Los casos de prueba expuestos, aunque útiles, son bastante genéricos y podrían haber sido redactados de manera más específica para un sistema "VetCare".	2026-05-07 19:21:45.489222+00	2026-05-07 19:21:45.489222+00	\N	\N
3409efb7-c7c1-4879-ae90-3bcd35e0f0ef	70bb67c4-580f-4f71-add4-abb80a190de0	69800d3e-dcff-474e-a4ee-836676d7dd27	class Cliente {\r\n    private String nombre;\r\n    private String telefono;\r\n    private String direccion;\r\n\r\n    public Cliente(String nombre, String telefono, String direccion) {\r\n        this.nombre = nombre;\r\n        this.telefono = telefono;\r\n        this.direccion = direccion;\r\n    }\r\n\r\n    public void mostrarInformacion() {\r\n        System.out.println("Cliente: " + nombre);\r\n        System.out.println("Telefono: " + telefono);\r\n        System.out.println("Direccion: " + direccion);\r\n    }\r\n}\r\n\r\nclass Mascota {\r\n    private String nombre;\r\n    private String especie;\r\n    private int edad;\r\n\r\n    public Mascota(String nombre, String especie, int edad) {\r\n        this.nombre = nombre;\r\n        this.especie = especie;\r\n        this.edad = edad;\r\n    }\r\n\r\n    public void mostrarMascota() {\r\n        System.out.println("Mascota: " + nombre);\r\n        System.out.println("Especie: " + especie);\r\n        System.out.println("Edad: " + edad);\r\n    }\r\n}\r\n\r\nclass Cita {\r\n    private String fecha;\r\n    private String motivo;\r\n\r\n    public Cita(String fecha, String motivo) {\r\n        this.fecha = fecha;\r\n        this.motivo = motivo;\r\n    }\r\n\r\n    public void mostrarCita() {\r\n        System.out.println("Fecha: " + fecha);\r\n        System.out.println("Motivo: " + motivo);\r\n    }\r\n}\r\n\r\npublic class VetCarePOO {\r\n    public static void main(String[] args) {\r\n\r\n        Cliente cliente = new Cliente(\r\n            "Sebastian Aguado",\r\n            "3001234567",\r\n            "Cali"\r\n        );\r\n\r\n        Mascota mascota = new Mascota(\r\n            "Max",\r\n            "Perro",\r\n            5\r\n        );\r\n\r\n        Cita cita = new Cita(\r\n            "10/05/2026",\r\n            "Vacunacion"\r\n        );\r\n\r\n        cliente.mostrarInformacion();\r\n        mascota.mostrarMascota();\r\n        cita.mostrarCita();\r\n    }\r\n}	10	El código define las clases Cliente, Mascota y Cita correctamente, con atributos y métodos principales. Sin embargo, no hay encapsulamiento adecuado (faltan getters y setters), no se muestra herencia ni el uso de colecciones, que son puntos clave de la rúbrica. Además, la interacción entre las clases es mínima, lo que no permite un modelo POO completo para un sistema de gestión.	0.6	El código es funcional y bien estructurado, pero omite elementos clave de la rúbrica, lo que podría indicar una respuesta generada rápidamente sin un análisis profundo de los requisitos. La simplicidad del código sugiere que se pudo haber generado por IA.	2026-05-07 19:21:51.887306+00	2026-05-07 19:21:51.887306+00	\N	\N
365bc4a3-3179-449a-bc81-1a5b1d3889f9	70bb67c4-580f-4f71-add4-abb80a190de0	03c2665e-0c28-499d-b9a5-e8e336488a05	import javax.swing.*;\nimport java.awt.*;\nimport java.awt.event.*;\n\npublic class VetCareGUI extends JFrame {\n\n    private JTextField txtCliente;\n    private JTextField txtMascota;\n    private JTextField txtEdad;\n\n    public VetCareGUI() {\n\n        setTitle("VetCare - Sistema Veterinario");\n        setSize(400, 300);\n        setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);\n        setLocationRelativeTo(null);\n\n        JPanel panel = new JPanel();\n        panel.setLayout(new GridLayout(4,2,10,10));\n\n        JLabel lblCliente = new JLabel("Cliente:");\n        JLabel lblMascota = new JLabel("Mascota:");\n        JLabel lblEdad = new JLabel("Edad:");\n\n        txtCliente = new JTextField();\n        txtMascota = new JTextField();\n        txtEdad = new JTextField();\n\n        JButton btnGuardar = new JButton("Guardar");\n\n        btnGuardar.addActionListener(new ActionListener() {\n            public void actionPerformed(ActionEvent e) {\n\n                try {\n\n                    String cliente = txtCliente.getText();\n                    String mascota = txtMascota.getText();\n\n                    if(cliente.isEmpty() || mascota.isEmpty()) {\n                        throw new Exception("Campos vacios");\n                    }\n\n                    int edad = Integer.parseInt(txtEdad.getText());\n\n                    JOptionPane.showMessageDialog(\n                        null,\n                        "Registro exitoso\\nCliente: "\n                        + cliente +\n                        "\\nMascota: "\n                        + mascota +\n                        "\\nEdad: "\n                        + edad\n                    );\n\n                } catch(NumberFormatException ex) {\n\n                    JOptionPane.showMessageDialog(\n                        null,\n                        "La edad debe ser numerica"\n                    );\n\n                } catch(Exception ex) {\n\n                    JOptionPane.showMessageDialog(\n                        null,\n                        ex.getMessage()\n                    );\n                }\n            }\n        });\n\n        panel.add(lblCliente);\n        panel.add(txtCliente);\n\n        panel.add(lblMascota);\n        panel.add(txtMascota);\n\n        panel.add(lblEdad);\n        panel.add(txtEdad);\n\n        panel.add(new JLabel());\n        panel.add(btnGuardar);\n\n        add(panel);\n    }\n\n    public static void main(String[] args) {\n\n        SwingUtilities.invokeLater(new Runnable() {\n            public void run() {\n                new VetCareGUI().setVisible(true);\n            }\n        });\n    }\n}	13	El código proporciona una GUI funcional con manejo de errores para campos vacíos y edad no numérica. Sin embargo, no se observa navegación entre vistas ni un manejo claro de la persistencia de los datos, lo que va en detrimento de la rúbrica esperada. El uso de SwingUtilities.invokeLater es correcto para asegurar que la GUI se inicialice en el Event Dispatch Thread, lo que es una buena práctica en Swing. La claridad del código es buena y sigue las convenciones de Java.	0.6	El código presenta un estilo y estructura que podría ser generado por IA, incluyendo comentarios concisos y un formato consistente. Sin embargo, la ausencia de la navegación entre vistas y una solución para la persistencia de datos (aunque no se pide explícitamente en el enunciado, es un aspecto importante para una GUI principal) sugiere que podría haber sido escrito por un estudiante que abordó solo las partes más directas del problema.	2026-05-07 19:21:55.074919+00	2026-05-07 19:21:55.074919+00	\N	\N
574be0e2-de8e-44d7-82db-69cca8a24dcc	70bb67c4-580f-4f71-add4-abb80a190de0	e270c36e-a739-4901-b64e-957dc8718c58	Inicio\n\nAl ejecutar el programa aparece el menú principal.\n\nRegistrar cliente\nSeleccionar “Registrar Cliente”.\nIngresar datos.\nPresionar guardar.\nRegistrar mascota\nSeleccionar “Registrar Mascota”.\nAsociar cliente.\nGuardar datos.\nCrear cita\nSeleccionar “Crear Cita”.\nElegir mascota.\nRegistrar fecha y motivo.\nArquitectura del sistema\nCapa de presentación\n\nInterfaz gráfica realizada con Java Swing.\n\nCapa lógica\n\nContiene reglas del negocio:\n\nCliente\nMascota\nCita\nCapa de persistencia\n\nManejo de archivos para almacenamiento de datos.	4	La respuesta es un buen inicio, pero le falta mucho para cumplir con la rúbrica. El manual de usuario es muy básico y no incluye capturas de pantalla, como se solicita. La justificación de la arquitectura es excesivamente concisa y no explica en detalle por qué se eligieron esas capas o el patrón MVC (que ni siquiera se menciona). Además, la persistencia se describe de forma genérica, sin especificar el uso de archivos .txt o .csv como se indicaba en la rúbrica.	0.7	La estructura es muy concisa y genérica, careciendo de la profundidad y el nivel de detalle que esperaría de una respuesta humana en profundidad para una rúbrica que solicita gráficos y justificaciones de diseño.  Parece una respuesta generada rápidamente con puntos clave sin desarrollo.	2026-05-07 19:21:48.862512+00	2026-05-07 19:21:48.862512+00	\N	\N
100fc72a-50f6-480c-bdf3-ec37deadd6e2	70bb67c4-580f-4f71-add4-abb80a190de0	98146289-46b6-46c8-ba0c-a60c3f81b936	import java.io.FileWriter;\r\nimport java.io.FileReader;\r\nimport java.io.BufferedReader;\r\nimport java.io.IOException;\r\n\r\npublic class PersistenciaVetCare {\r\n\r\n    public static void guardarDatos(String texto) {\r\n\r\n        try {\r\n\r\n            FileWriter writer = new FileWriter("vetcare.txt");\r\n            writer.write(texto);\r\n            writer.close();\r\n\r\n            System.out.println("Datos guardados correctamente.");\r\n\r\n        } catch(IOException e) {\r\n\r\n            System.out.println("Error al guardar.");\r\n        }\r\n    }\r\n\r\n    public static void leerDatos() {\r\n\r\n        try {\r\n\r\n            BufferedReader reader =\r\n                new BufferedReader(\r\n                    new FileReader("vetcare.txt")\r\n                );\r\n\r\n            String linea;\r\n\r\n            while((linea = reader.readLine()) != null) {\r\n                System.out.println(linea);\r\n            }\r\n\r\n            reader.close();\r\n\r\n        } catch(IOException e) {\r\n\r\n            System.out.println("Error al leer archivo.");\r\n        }\r\n    }\r\n\r\n    public static void main(String[] args) {\r\n\r\n        guardarDatos(\r\n            "Cliente: Sebastian\\nMascota: Max\\nCita: Vacunacion"\r\n        );\r\n\r\n        leerDatos();\r\n    }\r\n}	13	El código es funcional y cumple con los requisitos básicos de la rúbrica. Sin embargo, hay un pequeño error en el manejo del archivo inexistente al leer, ya que `FileReader` lanzará una `FileNotFoundException` que es capturada por el `IOException` general, pero no se distingue claramente. Sería mejor un manejo explícito para `FileNotFoundException` para dar un mensaje más específico. Además, aunque cumple con el ciclo en pantalla, no es una demostración "dinámica" donde se podría ver más claramente la persistencia (por ejemplo, guardar algo, cerrar el programa, abrirlo y leer lo que se guardó previamente).	0.7	El código es correcto y sigue las mejores prácticas de Java para un problema de nivel básico. La estructura y los comentarios (aunque no hay muchos) son consistentes con lo que se esperaría de un generador de IA. La claridad del código es buena y no hay errores de sintaxis o lógica evidentes que sugieran un proceso de pensamiento humano con errores. La ausencia de detalles superfluos o errores comunes de principiantes también es un indicio.	2026-05-07 19:21:59.809816+00	2026-05-07 19:21:59.809816+00	\N	\N
\.


--
-- Data for Name: project_submissions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."project_submissions" ("id", "project_id", "user_id", "zip_url", "status", "ai_grade", "ai_feedback", "ai_detected", "ai_detected_score", "ai_detected_reasons", "final_grade", "teacher_feedback", "submitted_at", "created_at", "updated_at", "submission_grade", "defense_factor", "defense_notes", "defense_at", "repository_url", "group_id") FROM stdin;
70bb67c4-580f-4f71-add4-abb80a190de0	6e7c4db6-8dd5-416b-a965-731ed86545b9	dac41f00-64e7-40b8-a207-31f1ee2718c0	\N	calificado	60	Calificación automática inmediata sobre 100 pts.	f	\N	\N	60	\N	2026-05-07 19:21:34.225+00	2026-05-07 19:21:34.47104+00	2026-05-07 20:28:46.84822+00	60	1	\N	\N	\N	\N
\.


--
-- Data for Name: projects; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."projects" ("id", "course_id", "cut_id", "created_by", "title", "description", "instructions", "project_type", "max_files", "max_score", "start_date", "due_date", "status", "ai_generated", "created_at", "updated_at", "external_link", "weight", "group_mode", "group_size_min", "group_size_max", "is_external") FROM stdin;
6e7c4db6-8dd5-416b-a965-731ed86545b9	0e375073-e9f2-4fda-a295-53407e3d5879	55cdf83b-d189-49fe-8142-fab845b34b1a	e8b3c430-2162-413b-8560-9e3a43e3577e	VetCare — Sistema de Gestión Veterinaria	Proyecto integrador dual entre Programación II y Seminario de Sistemas. Construye un sistema de escritorio en Java para la Clínica Veterinaria Huellitas: registro de clientes y mascotas, agenda de citas e historial clínico.	Entrega cada artefacto en su slot correspondiente. Los entregables de código deben usar Java Swing/AWT y compilarán en el navegador con el runner Java GUI. Los entregables documentales pueden pegarse como texto (Markdown).	mixto	7	100	\N	2026-06-17 18:00:00+00	published	f	2026-05-03 18:00:41.575424+00	2026-05-07 22:41:03.156969+00	\N	1	teacher_assigned	2	5	f
\.


--
-- Data for Name: questions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."questions" ("id", "exam_id", "type", "content", "expected_rubric", "options", "points", "position", "created_at", "language", "starter_code", "test_cases") FROM stdin;
bd63a640-9636-4e50-a4a1-8d3ea42058a5	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	abierta	¿Qué es un diagrama de clases en el contexto de la Programación Orientada a Objetos (POO)?	La respuesta debe incluir:\n1. Una definición de diagrama de clases como una representación estática de la estructura de un sistema.\n2. Mencionar que muestra clases, sus atributos y métodos, y las relaciones entre ellas.\n3. Indicar que es una herramienta fundamental en el diseño y análisis de sistemas POO.	{}	1	0	2026-05-01 00:46:49.489162+00	\N	\N	\N
8db47d7f-c0e5-4166-bfba-2fb651100cca	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	cerrada	Basado en el contexto de desarrollo de software, ¿cuál es el propósito principal de un diagrama de clases?	La respuesta correcta debe indicar que el propósito principal de un diagrama de clases es modelar la estructura estática de un sistema, mostrando las clases del sistema, sus atributos, operaciones y las relaciones entre ellas. Debe resaltar su utilidad en la representación visual del diseño de la aplicación y la comunicación entre desarrolladores.	{"choices": ["A) Para describir la secuencia de interacciones entre objetos en un caso de uso específico.", "B) Para modelar el comportamiento dinámico de los objetos de un sistema a lo largo del tiempo.", "C) Para representar la estructura estática de un sistema, mostrando las clases, sus atributos, operaciones y las relaciones entre ellas.", "D) Para definir los requisitos funcionales y no funcionales de un sistema desde la perspectiva del usuario."], "correct_index": 2}	1	1	2026-05-01 00:47:28.106969+00	\N	\N	\N
6eb2087a-28da-4911-a1f5-1a56d72f4c7e	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	codigo	Diseña en Java una clase `Vehiculo` que demuestre el concepto de composición con una clase `Motor`. La clase `Vehiculo` debe contener una instancia de `Motor` y un método que, al ser llamado, imprima la información del motor. La clase `Motor` debe tener atributos como `tipo` (e.g., gasolina, eléctrico) y `potencia` (en HP).	La respuesta debe incluir:\n1. Una clase `Motor` con atributos `tipo` y `potencia`, y al menos un constructor.\n2. Una clase `Vehiculo` con un atributo de tipo `Motor`.\n3. El constructor de `Vehiculo` debe inicializar el objeto `Motor`.\n4. Un método en `Vehiculo` (por ejemplo, `mostrarInformacionVehiculo`) que acceda y muestre los atributos del `Motor`.\n5. El código debe ser funcional y estar escrito en Java.	\N	1	2	2026-05-01 00:48:48.808924+00	java	\N	\N
78edabd9-4e4f-4c2c-aeab-aeeb66e09a8a	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	diagrama	¿Cuál es el diagrama de clases UML (en formato Mermaid) que representa la composición de una clase `Vehiculo` con una clase `Motor`? La clase `Vehiculo` debe tener una instancia de `Motor` y un método para imprimir la información del motor. La clase `Motor` debe tener atributos `tipo` y `potencia`.	La respuesta es correcta si el diagrama de clases en Mermaid:\n- Incluye una clase `Vehiculo`.\n- Incluye una clase `Motor`.\n- Muestra una relación de composición (diamante relleno) entre `Vehiculo` y `Motor`, donde `Vehiculo` contiene a `Motor`.\n- La clase `Motor` tiene atributos `tipo` y `potencia`.\n- La clase `Vehiculo` tiene un método para imprimir la información del motor, por ejemplo `imprimir_info_motor()`.	\N	1	3	2026-05-01 00:49:51.597613+00	\N	\N	\N
72acdb9b-5fb3-48b5-96f2-1089816a4a18	2c29880e-df95-4650-9653-3f6b72cc7632	diagrama	Diseña un diagrama de clases UML que represente la relación entre un `Dueño` y su `Mascota`. Asegúrate de incluir los atributos y métodos relevantes para cada clase, así como la multiplicidad de la relación.	La respuesta debe incluir un diagrama de clases UML con al menos dos clases: `Dueño` y `Mascota`.\n\nClase `Dueño`:\n- Atributos: `nombre` (String), `id` (Entero).\n- Métodos: `adoptar_mascota(mascota)` (añade una mascota a la lista de mascotas del dueño).\n\nClase `Mascota`:\n- Atributos: `nombre` (String), `especie` (String), `edad` (Entero).\n- Métodos: `emitir_sonido()` (puede ser un método abstracto o con una implementación por defecto).\n\nRelación:\n- Debe existir una relación de asociación entre `Dueño` y `Mascota`.\n- La multiplicidad debe ser 1 a muchos (1..*), indicando que un dueño puede tener una o varias mascotas, y que una mascota pertenece a un solo dueño (o una multiplicidad de 0..* si se considera que una mascota puede no tener dueño inmediatamente).\n- La dirección de la asociación puede ser unidireccional (de Dueño a Mascota) o bidireccional, dependiendo de si la mascota necesita conocer a su dueño.\n\nEl diagrama debe ser claro y legible, usando la notación estándar de UML para clases, atributos, métodos y asociaciones.	\N	1	3	2026-05-03 23:43:35.463514+00	\N	\N	\N
88f93771-0b0f-412e-bd22-1ba074817bfb	2c29880e-df95-4650-9653-3f6b72cc7632	codigo	Escribe un programa en Java que cree un `ArrayList` de cadenas (String), añada tres nombres de frutas (por ejemplo, "Manzana", "Banana", "Naranja") y luego imprima cada fruta en una línea separada.	La respuesta debe incluir la importación de `java.util.ArrayList`. Debe crear una instancia de `ArrayList<String>`. Debe añadir al menos tres elementos de tipo String al ArrayList usando el método `add()`. Debe utilizar un bucle (como un `for-each` o un `for` tradicional) para iterar sobre el ArrayList e imprimir cada elemento. Cada elemento debe imprimirse en una nueva línea, preferiblemente usando `System.out.println()`.	\N	1	2	2026-05-03 23:43:22.021039+00	java	\N	\N
1c1b1c30-8496-4867-81d4-16471ab1a42e	2c29880e-df95-4650-9653-3f6b72cc7632	abierta	¿Qué son los pilares de la Programación Orientada a Objetos (POO) en Java y cómo se aplican en el diseño de software?	La respuesta debe identificar y describir al menos cuatro de los siguientes pilares de la POO en Java: Encapsulamiento, Herencia, Polimorfismo, y Abstracción. Para cada pilar, debe proporcionar una explicación clara de su concepto y un ejemplo conciso de cómo se aplica en el diseño de software utilizando Java, mencionando características del lenguaje como clases, objetos, interfaces, modificadores de acceso, sobrecarga de métodos, o sobrescritura de métodos.	\N	1	1	2026-05-03 23:42:42.97831+00	\N	\N	\N
6dd61ae0-d510-4a0c-83e4-7cb7bde860b6	2c29880e-df95-4650-9653-3f6b72cc7632	java_gui	¿Cómo crearías una interfaz gráfica de usuario en Java que contenga un botón con el texto 'Hola'?	La respuesta debe incluir la creación de una ventana (JFrame o similar), la instanciación de un JButton, la asignación del texto 'Hola' al botón y la adición del botón a la ventana. Se valorará la organización del código y el uso de un layout manager adecuado, aunque no es estrictamente obligatorio para la puntuación máxima. No es necesario añadir un ActionListener.	{}	1	0	2026-05-08 00:55:34.027142+00	java	import javax.swing.*;\nimport java.awt.*;\n\npublic class Main {\n  public static void main(String[] args) {\n    JFrame f = new JFrame("Hola");\n    f.setSize(320, 200);\n    f.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);\n    f.add(new JLabel("Hola Mundo", SwingConstants.CENTER));\n    f.setVisible(true);\n  }\n}\n	\N
88862e8e-d725-40ed-b4f0-51b0494c5b32	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	codigo	Implementa un método en Java que reciba un `ArrayList` de `HashMaps`, donde cada `HashMap` contiene un 'nombre' (String) y una 'edad' (Integer). El método debe devolver un nuevo `ArrayList` que contenga solo los nombres (String) de las personas cuya edad sea mayor a 30.	La respuesta debe incluir un método en Java.\nEl método debe aceptar un `ArrayList<HashMap<String, Object>>` como parámetro.\nDebe iterar sobre el `ArrayList` de `HashMaps`.\nPara cada `HashMap`, debe extraer el valor asociado a la clave 'edad' y verificar si es mayor a 30.\nSi la edad es mayor a 30, debe extraer el valor asociado a la clave 'nombre'.\nDebe agregar los nombres que cumplan la condición a un nuevo `ArrayList` de `String`.\nEl método debe devolver este nuevo `ArrayList<String>`.	\N	1	0	2026-05-08 01:03:02.117083+00	java	\N	\N
fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	codigo	En Java, crea un `HashMap` donde las claves sean nombres de países (String) y los valores sean `HashSets` que contengan los nombres de ciudades importantes (String) de cada país. Luego, implementa un método que reciba este `HashMap` y un nombre de país, y devuelva un `HashSet` con todas las ciudades importantes de ese país. Si el país no existe en el `HashMap`, debe devolver un `HashSet` vacío.	La respuesta debe incluir la creación de un `HashMap<String, HashSet<String>>`.\nDebe incluir un método en Java que acepte el `HashMap` y un `String` (nombre del país) como parámetros.\nEl método debe verificar si la clave del país existe en el `HashMap`.\nSi la clave existe, debe devolver el `HashSet` de ciudades asociado a esa clave.\nSi la clave no existe, debe devolver un `HashSet` vacío.	\N	1	1	2026-05-08 01:03:02.117083+00	java	\N	\N
70255d55-f4e9-4ee3-a2f7-474cc955a9a2	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	codigo	Diseña una estructura de datos en Java utilizando un `HashSet` que contenga `ArrayLists`. Cada `ArrayList` representará un conjunto de números enteros (Integer). Implementa un método que reciba este `HashSet` de `ArrayLists` y un número entero, y devuelva `true` si el número se encuentra en al menos uno de los `ArrayLists` dentro del `HashSet`, o `false` en caso contrario.	La respuesta debe incluir la creación de un `HashSet<ArrayList<Integer>>`.\nDebe incluir un método en Java que acepte el `HashSet` y un `Integer` (el número a buscar) como parámetros.\nEl método debe iterar sobre cada `ArrayList` dentro del `HashSet`.\nDentro de cada `ArrayList`, debe verificar si el número entero está presente.\nSi el número se encuentra en algún `ArrayList`, el método debe devolver `true`.\nSi después de revisar todos los `ArrayLists` el número no se encuentra, el método debe devolver `false`.	\N	1	2	2026-05-08 01:03:02.117083+00	java	\N	\N
\.


--
-- Data for Name: similarity_pairs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."similarity_pairs" ("id", "kind", "ref_id", "question_id", "submission_a", "submission_b", "user_a", "user_b", "score", "method", "reasons", "created_at") FROM stdin;
08e3a9af-7656-4247-9880-8ac8cac13860	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	88862e8e-d725-40ed-b4f0-51b0494c5b32	63f721dc-3dc5-43cf-a10e-88ea107e7e38	e9ba41b9-678f-412e-8a64-bf90d13fbd48	dac41f00-64e7-40b8-a207-31f1ee2718c0	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	0.6	gemini	Ambos incluyen la construcción de una lista de prueba `listaPrueba` (0) y `personas` (1), inicializando `HashMap` individuales (Persona2, p1, p2, p3), añadiendo valores de 'nombre' y 'edad' y luego llamando al método para filtrar. Aunque la estructura es similar, los nombres de variables genéricos no son lo suficientemente fuertes para un score alto. También el error en 0 'Persona2.put' que debería ser 'persona1.put' no se repite en 1 lo que le baja el score. Y 'ArrayList<String, Object> personas = new ArrayList<>();' en 1 es un error que no se repite en 0 	2026-05-08 14:52:24.435103+00
06e22602-6f94-4b64-9420-792c8562ea78	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	88862e8e-d725-40ed-b4f0-51b0494c5b32	e9ba41b9-678f-412e-8a64-bf90d13fbd48	ecaa5dc3-58d2-413d-9a2a-0f3036407825	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	0.6	gemini	Ambos incluyen la construcción de una lista de prueba `listaPrueba` (0) y `personas` (4), inicializando `HashMap` individuales (Persona2/persona1, persona1/persona2/persona3), añadiendo valores de 'nombre' y 'edad' y luego llamando al método `filtraredadMayorDe30` (0) y `obtenerNombres` (4) para filtrar. Y hacen un `System.out.println` de un mensaje parecido. El error en 0 'Persona2.put' que debería ser 'persona1.put' no se repite en 4.	2026-05-08 14:52:24.435103+00
97c69a65-8559-4143-8c59-ad5f6a68b47f	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	88862e8e-d725-40ed-b4f0-51b0494c5b32	2919daee-f5bc-484d-8d16-d8d069fa32e4	e9ba41b9-678f-412e-8a64-bf90d13fbd48	2d709409-7b44-403d-a315-b8bb826aa8ca	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	0.6	gemini	Ambos incluyen la construcción de una lista de prueba `listaPrueba` (0) y `listaPersonas` (5), inicializando `HashMap` individuales (Persona2, p1, p2, p3), añadiendo valores de 'nombre' y 'edad' y luego llamando al método para filtrar. El error en 0 'Persona2.put' que debería ser 'persona1.put' no se repite en 5.	2026-05-08 14:52:24.435103+00
e0bddf7b-0bba-4a2e-87aa-c1e820ab6382	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	88862e8e-d725-40ed-b4f0-51b0494c5b32	52b088c6-6b12-47cd-9f61-b93c5a13dd2a	e9ba41b9-678f-412e-8a64-bf90d13fbd48	bce0ddee-4001-45e9-b323-719f80dc4f6d	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	0.6	gemini	Ambos incluyen la construcción de una lista de prueba `listaPrueba` (0) y `personas` (7), inicializando `HashMap` individuales (Persona2, persona1, persona2, persona3), añadiendo valores de 'nombre' y 'edad' y luego realizando el filtrado.  El error en 0 'Persona2.put' que debería ser 'persona1.put' no se repite en 7.	2026-05-08 14:52:24.435103+00
e6165cd2-6b83-4ed4-8b6c-7f5d86a527e8	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	88862e8e-d725-40ed-b4f0-51b0494c5b32	265ee685-4afc-4257-ac5e-bde98def74e7	e9ba41b9-678f-412e-8a64-bf90d13fbd48	0a02892e-8476-44da-90e8-384c064e6040	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	0.6	gemini	Ambos incluyen la construcción de una lista de prueba `listaPrueba` (0) y `lista` (11), inicializando `HashMap` individuales (Persona2, persona1, persona2, persona3), añadiendo valores de 'nombre' y 'edad' y luego llamando al método para filtrar.  El error en 0 'Persona2.put' que debería ser 'persona1.put' no se repite en 11.	2026-05-08 14:52:24.435103+00
3372dd0e-0f42-49d3-b87f-34a79d07e8ca	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	88862e8e-d725-40ed-b4f0-51b0494c5b32	63f721dc-3dc5-43cf-a10e-88ea107e7e38	ecaa5dc3-58d2-413d-9a2a-0f3036407825	dac41f00-64e7-40b8-a207-31f1ee2718c0	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	0.6	gemini	Ambos usan nombres de método y variables muy similares: `obtenerMayoresDe30` vs `obtenerNombres` y `personas` como nombre del `ArrayList` de entrada. Además la estructura del método `main` para las pruebas con los `HashMap` (p1, p2, p3 y persona1, persona2, persona3) y la forma de imprimirlos es muy similar.	2026-05-08 14:52:24.435103+00
48bda149-7162-4124-8eb8-6a46372aa82c	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	88862e8e-d725-40ed-b4f0-51b0494c5b32	2919daee-f5bc-484d-8d16-d8d069fa32e4	63f721dc-3dc5-43cf-a10e-88ea107e7e38	2d709409-7b44-403d-a315-b8bb826aa8ca	dac41f00-64e7-40b8-a207-31f1ee2718c0	0.6	gemini	Ambos usan los mismos nombres de variables para los HashMaps de prueba, p1, p2, p3, y la forma de instanciarlos y añadir valores es muy similar en el main. Hay un error en el main de 1 `ArrayList<String, Object> personas = new ArrayList<>();` que no se repite.	2026-05-08 14:52:24.435103+00
a39439c4-667b-4d26-9a0b-ba98daa5942b	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	88862e8e-d725-40ed-b4f0-51b0494c5b32	63f721dc-3dc5-43cf-a10e-88ea107e7e38	cb65a97c-ed9f-4a28-9042-e6f52c0701a8	dac41f00-64e7-40b8-a207-31f1ee2718c0	2b2cb673-f574-4f99-b152-c4f9c438ab0c	0.75	gemini	Similares nombres de las variables de prueba: p1, p2. Mismo error tipográfico 'ArrayLits' para ArrayList. Errores muy similares en el método main con el ArrayLits.	2026-05-08 14:52:24.435103+00
eb8298db-3edb-4621-85e0-aeab59444907	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	88862e8e-d725-40ed-b4f0-51b0494c5b32	83835bc8-d0de-4eab-84c0-9b3e7cb09554	c0efc0dc-705f-4fa8-82ff-217f0ecde1d8	d048a636-8a14-4fcd-aa3e-891cca899b32	531392ff-60c0-471d-af30-5e58bc80e860	0.8	gemini	Ambos utilizan una estructura extremadamente similar para el método `MayoresDe30` (o `Mayores`) así como en el resto de clases e imports, incluyendo 'java util.*' y la ausencia de un método `main`. la resolución lógica es idéntica y muy concisa, no habiendo variables intermedias, lo que incrementa el score.	2026-05-08 14:52:24.435103+00
d1570dc7-c155-4d08-a3d7-6b4e2a0b753d	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	88862e8e-d725-40ed-b4f0-51b0494c5b32	0f7264db-0591-4867-adce-bed6efc33b82	c0efc0dc-705f-4fa8-82ff-217f0ecde1d8	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	531392ff-60c0-471d-af30-5e58bc80e860	0.6	gemini	Ambos omiten el método main por lo que solo tienen la lógica central de la solución y las importaciones, además usan nombres de método semánticamente similares `MayoresDe30` y `mayoresDe30`.	2026-05-08 14:52:24.435103+00
59a826d5-0d94-43f3-a435-ab38035936b3	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	88862e8e-d725-40ed-b4f0-51b0494c5b32	0f7264db-0591-4867-adce-bed6efc33b82	83835bc8-d0de-4eab-84c0-9b3e7cb09554	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	d048a636-8a14-4fcd-aa3e-891cca899b32	0.6	gemini	Ambos omiten el método main por lo que solo tienen la lógica central de la solución y las importaciones, además usan nombres de método semánticamente similares `Mayores` y `mayoresDe30`, y omiten palabras como 'public' en la firma del método.	2026-05-08 14:52:24.435103+00
7e0ff14d-96a1-43fa-ba55-cd0eef5a1d48	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	88862e8e-d725-40ed-b4f0-51b0494c5b32	2919daee-f5bc-484d-8d16-d8d069fa32e4	ecaa5dc3-58d2-413d-9a2a-0f3036407825	2d709409-7b44-403d-a315-b8bb826aa8ca	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	0.6	gemini	Ambos usan nombres parecidos para los HashMaps de prueba persona1, persona2, persona3 y p1, p2, p3, e imprimen el resultado directamente. El comentario en 4 no tiene impacto.	2026-05-08 14:52:24.435103+00
1f7900b6-3784-4ff4-833b-3da962e2b0b4	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	88862e8e-d725-40ed-b4f0-51b0494c5b32	52b088c6-6b12-47cd-9f61-b93c5a13dd2a	ecaa5dc3-58d2-413d-9a2a-0f3036407825	bce0ddee-4001-45e9-b323-719f80dc4f6d	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	0.6	gemini	Ambos usan nombres parecidos para los HashMaps de prueba persona1, persona2, persona3, e imprimen el resultado directamente.	2026-05-08 14:52:24.435103+00
f52d597b-f51a-439d-acf3-c3567559875a	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	88862e8e-d725-40ed-b4f0-51b0494c5b32	2919daee-f5bc-484d-8d16-d8d069fa32e4	52b088c6-6b12-47cd-9f61-b93c5a13dd2a	2d709409-7b44-403d-a315-b8bb826aa8ca	bce0ddee-4001-45e9-b323-719f80dc4f6d	0.6	gemini	Ambos usan nombres parecidos para los HashMaps de prueba p1, p2, p3 y persona1, persona2, persona3, e imprimen el resultado directamente. Los datos de prueba son diferentes.	2026-05-08 14:52:24.435103+00
17ed7174-ede2-47e3-b951-820a57a53865	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	88862e8e-d725-40ed-b4f0-51b0494c5b32	265ee685-4afc-4257-ac5e-bde98def74e7	2919daee-f5bc-484d-8d16-d8d069fa32e4	0a02892e-8476-44da-90e8-384c064e6040	2d709409-7b44-403d-a315-b8bb826aa8ca	0.6	gemini	Ambos usan nombres parecidos para los HashMaps de prueba p1, p2, p3 y persona1, persona2, persona3, e imprimen el resultado directamente.	2026-05-08 14:52:24.435103+00
9c2d0646-4d01-41e6-9208-14ab65419552	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	88862e8e-d725-40ed-b4f0-51b0494c5b32	7b9f001a-e4fc-4c4f-acf7-a690c9bce689	cb65a97c-ed9f-4a28-9042-e6f52c0701a8	032a6335-5776-4677-8881-99db2cef9fe2	2b2cb673-f574-4f99-b152-c4f9c438ab0c	0.75	gemini	Ambos errores tipográficos 'ArrayLits' y 'Arraylist' para ArrayList, así como el error `HashMap<Strng, Object> persona2 = new HashMap<>();` en 6. Aunque el segundo error no se repite se suman ambos errores para el score. La impresión directa del resultado también es similar. 	2026-05-08 14:52:24.435103+00
70e77007-d0d8-44b2-84aa-519cee6a548f	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a	63f721dc-3dc5-43cf-a10e-88ea107e7e38	ecaa5dc3-58d2-413d-9a2a-0f3036407825	dac41f00-64e7-40b8-a207-31f1ee2718c0	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	0.8	gemini	Ambos usan nombres de variables muy similares (`ciudadesColombia`, `ciudadesMexico` vs `CiudadesColombia`, `CiudadesMexico`) y la misma estructura de datos de prueba.	2026-05-08 14:52:28.252299+00
d320bb0c-d247-4865-9439-c4bb99bd0fe4	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a	2919daee-f5bc-484d-8d16-d8d069fa32e4	63f721dc-3dc5-43cf-a10e-88ea107e7e38	2d709409-7b44-403d-a315-b8bb826aa8ca	dac41f00-64e7-40b8-a207-31f1ee2718c0	0.6	gemini	Ambos usan nombres de variables similares para los HashSets de ciudades (`ciudadesColombia`, `ciudadesMexico` vs `ciudadesCol`, `ciudadesMex`) y la misma lógica en el método `main` para probar la función.	2026-05-08 14:52:28.252299+00
6a859704-7adf-44b7-bbf4-85836c9adb2b	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a	63f721dc-3dc5-43cf-a10e-88ea107e7e38	cb65a97c-ed9f-4a28-9042-e6f52c0701a8	dac41f00-64e7-40b8-a207-31f1ee2718c0	2b2cb673-f574-4f99-b152-c4f9c438ab0c	0.6	gemini	Ambos usan nombres de variables similares para los HashSets de ciudades (`ciudadesColombia`, `ciudadesMexico` vs `colombia`, `mexico`) y la misma estructura en el método `main` para probar la función.	2026-05-08 14:52:28.252299+00
e6cb6694-ec7e-44b9-b7ac-d13a47538fec	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a	265ee685-4afc-4257-ac5e-bde98def74e7	c0efc0dc-705f-4fa8-82ff-217f0ecde1d8	0a02892e-8476-44da-90e8-384c064e6040	531392ff-60c0-471d-af30-5e58bc80e860	0.7	gemini	Ambos usan el nombre `getCiudades` para la función y tienen una estructura similar para la creación de los datos de prueba en `main`.	2026-05-08 14:52:28.252299+00
9cd0dcc7-4253-41b8-a759-d7e859fb7d34	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a	2919daee-f5bc-484d-8d16-d8d069fa32e4	ecaa5dc3-58d2-413d-9a2a-0f3036407825	2d709409-7b44-403d-a315-b8bb826aa8ca	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	0.7	gemini	Ambos usan nombres de variables muy similares para los HashSets de ciudades (`CiudadesColombia`, `CiudadesMexico` vs `ciudadesCol`, `ciudadesMex`) y la misma estructura para la creación de los datos de prueba en `main`.	2026-05-08 14:52:28.252299+00
9dcc41c7-d395-427b-8e9c-bd296ea2f228	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a	cb65a97c-ed9f-4a28-9042-e6f52c0701a8	ecaa5dc3-58d2-413d-9a2a-0f3036407825	2b2cb673-f574-4f99-b152-c4f9c438ab0c	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	0.6	gemini	Ambos usan nombres de variables similares para los HashSets de ciudades (`CiudadesColombia`, `CiudadesMexico` vs `colombia`, `mexico`) y la misma estructura de datos de prueba.	2026-05-08 14:52:28.252299+00
90077696-9e0a-4c27-9ee9-d3f89fbcb47a	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a	2919daee-f5bc-484d-8d16-d8d069fa32e4	cb65a97c-ed9f-4a28-9042-e6f52c0701a8	2d709409-7b44-403d-a315-b8bb826aa8ca	2b2cb673-f574-4f99-b152-c4f9c438ab0c	0.7	gemini	Ambos usan nombres de variables similares para los HashSets de ciudades (`ciudadesCol`, `ciudadesMex` vs `colombia`, `mexico`) y la misma estructura en el método `main` para probar la función.	2026-05-08 14:52:28.252299+00
e45a998f-d5d2-4d4c-81c1-260efa3db0c9	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	70255d55-f4e9-4ee3-a2f7-474cc955a9a2	63f721dc-3dc5-43cf-a10e-88ea107e7e38	c0efc0dc-705f-4fa8-82ff-217f0ecde1d8	dac41f00-64e7-40b8-a207-31f1ee2718c0	531392ff-60c0-471d-af30-5e58bc80e860	0.7	gemini	Ambos usan la misma estructura de nombres para crear listas (`lista1`, `lista2`, `lista3`) y una estructura de inicialización de datos similar con números consecutivos en los ejemplos de prueba del `main`.	2026-05-08 14:52:31.61239+00
71105bd8-c3fe-40c0-88a4-f5f4a7f21b64	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	70255d55-f4e9-4ee3-a2f7-474cc955a9a2	63f721dc-3dc5-43cf-a10e-88ea107e7e38	7b9f001a-e4fc-4c4f-acf7-a690c9bce689	dac41f00-64e7-40b8-a207-31f1ee2718c0	032a6335-5776-4677-8881-99db2cef9fe2	0.6	gemini	Ambos tienen un método `main` similar que crea HashSet y ArrayLists, añade elementos y luego llama al método de búsqueda, aunque los nombres de los métodos de búsqueda son distintos.	2026-05-08 14:52:31.61239+00
62cdfb35-5219-4409-a3dd-35266e4d2a21	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	70255d55-f4e9-4ee3-a2f7-474cc955a9a2	265ee685-4afc-4257-ac5e-bde98def74e7	63f721dc-3dc5-43cf-a10e-88ea107e7e38	0a02892e-8476-44da-90e8-384c064e6040	dac41f00-64e7-40b8-a207-31f1ee2718c0	0.8	gemini	Ambos usan nombres de variables muy similares en el `main` (`conjuntos`, `lista1`, `lista2`, `lista3`), la misma estructura para inicializar el `HashSet` y los `ArrayLists`, y el mismo patrón para realizar las llamadas de prueba e imprimir en el `main`.	2026-05-08 14:52:31.61239+00
f9c2e561-f041-4963-86cd-4af934273d6e	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	70255d55-f4e9-4ee3-a2f7-474cc955a9a2	c0efc0dc-705f-4fa8-82ff-217f0ecde1d8	c5f04343-42a0-4ba7-a3e4-6aa8354cde14	531392ff-60c0-471d-af30-5e58bc80e860	19e004a1-c1f2-4ca5-91d2-4c095058cb84	0.65	gemini	Ambos usan 'contieneNumero' como nombre de función y tienen una estructura similar en el 'main' para crear 'ArrayLists' y 'HashSet' para las pruebas, aunque los datos dentro de las listas son distintos y la inicialización de las listas es diferente en la respuesta 9 (Arrays.asList).	2026-05-08 14:52:31.61239+00
d6e1e852-7e13-482f-abdf-3ce146c8af5e	exam	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	70255d55-f4e9-4ee3-a2f7-474cc955a9a2	265ee685-4afc-4257-ac5e-bde98def74e7	c5f04343-42a0-4ba7-a3e4-6aa8354cde14	0a02892e-8476-44da-90e8-384c064e6040	19e004a1-c1f2-4ca5-91d2-4c095058cb84	0.65	gemini	Ambos usan 'contieneNumero' como nombre de función, inicializan las listas en el main de forma ligeramente diferente pero con el mismo patrón (crear listas, añadir a conjuntos), e imprimen los resultados de formas muy similares.	2026-05-08 14:52:31.61239+00
\.


--
-- Data for Name: submissions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."submissions" ("id", "exam_id", "user_id", "answers", "ai_grade", "final_override_grade", "status", "focus_warnings", "started_at", "submitted_at", "created_at", "updated_at", "ai_detected", "ai_detected_score", "ai_detected_reasons", "teacher_feedback", "extra_seconds") FROM stdin;
c5fe44b2-6b9f-487c-b5f6-cd1c80593d5c	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	032a6335-5776-4677-8881-99db2cef9fe2	{"__breakdown": [{"qid": "bd63a640-9636-4e50-a4a1-8d3ea42058a5", "type": "abierta", "earned": 0.2, "points": 1, "feedback": "La respuesta del estudiante es demasiado vaga y no incluye los puntos clave de la rúbrica, como la definición formal, los elementos que muestra (atributos, métodos, relaciones) y su utilidad en el diseño y análisis de sistemas POO."}, {"qid": "8db47d7f-c0e5-4166-bfba-2fb651100cca", "type": "cerrada", "earned": 1, "points": 1}, {"qid": "6eb2087a-28da-4911-a1f5-1a56d72f4c7e", "type": "codigo", "earned": 0.9, "points": 1, "feedback": "La respuesta cumple con todos los requisitos de la rúbrica. El código es funcional y demuestra correctamente el concepto de composición. Como mejora, las clases en Java suelen nombrarse con la primera letra en mayúscula (Motor, Vehiculo). Además, la clase `Motor` tiene un valor \\"200\\" hardcodeado en `getInfo()` que no corresponde al atributo `potencia`."}, {"qid": "78edabd9-4e4f-4c2c-aeab-aeeb66e09a8a", "type": "diagrama", "earned": 0.75, "points": 1, "feedback": "La relación de composición está correctamente indicada, y las clases y sus atributos y métodos principales están presentes. Sin embargo, la sintaxis Mermaid para la relación de composición para el nombre de la variable no es la esperada: \\"Vehiculo *-- motor\\" debería ser \\"Vehiculo *-- Motor\\"."}], "__session_id": "db41d44c-0cfc-45ed-93f4-fffe69ae0741", "__warning_events": [], "6eb2087a-28da-4911-a1f5-1a56d72f4c7e": "class motor {\\n    private String tipo;\\n    private int potencia;\\n\\n    public motor(String tipo, int potencia){\\n        this.tipo = tipo;\\n        this.potencia = potencia;\\n    }\\n\\n    public String getInfo(){\\n        return \\"Motor tipo: \\" + tipo + \\", Potencia: \\" + potencia + \\" 200\\";\\n    }\\n}\\n\\nclass vehiculo {\\n    private motor motor;\\n\\n    public vehiculo(String tipoMotor, int potenciaMotor){\\n    this.motor = new motor(tipoMotor, potenciaMotor);\\n    }\\n\\n    public void mostrarInfoMotor(){\\n        System.out.println(motor.getInfo());\\n    }\\n}\\n\\npublic class main{\\n    public static void main(String[] args){\\n        vehiculo miCoche = new vehiculo(\\"Gasolina\\", 150);\\n        miCoche.mostrarInfoMotor();\\n    }\\n}", "78edabd9-4e4f-4c2c-aeab-aeeb66e09a8a": "classDiagrama\\n     class Vehiculo {\\n           -Motor motor\\n           +imprimirInfoMotor()\\n     }\\n     class Motor {\\n           -String tipo\\n           -int potencia\\n     }\\n     Vehiculo *-- motor", "8db47d7f-c0e5-4166-bfba-2fb651100cca": 2, "bd63a640-9636-4e50-a4a1-8d3ea42058a5": "Es un mapa que nos ayuda a organizar unas ideas para poder visualizar como se realicionan los elementos en un sistema para que el código sea ordenado"}	3.57	\N	completado	0	2026-05-01 00:57:29.783763+00	2026-05-01 01:10:41.146+00	2026-05-01 00:57:29.783763+00	2026-05-01 02:36:14.377822+00	f	\N	\N	\N	0
d9c08e2d-84d3-49b3-9ef2-b4e7575cde82	9ab4413a-f0e3-448d-a070-536cc466197e	d048a636-8a14-4fcd-aa3e-891cca899b32	{}	\N	4.9	completado	0	2026-05-06 17:25:50.594+00	2026-05-06 17:27:41.47+00	2026-05-06 17:25:50.832561+00	2026-05-06 17:27:41.798698+00	f	\N	\N	\N	0
5aef34ad-7cd3-4f75-b16f-3e9ddfd50930	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	{"__session_id": "09af1443-c623-4955-b585-1ddfcce54336", "6eb2087a-28da-4911-a1f5-1a56d72f4c7e": "class Motor {\\r\\n    String tipo = \\"gasolina\\";\\r\\n    int potencia =\\r\\n}", "8db47d7f-c0e5-4166-bfba-2fb651100cca": 2, "bd63a640-9636-4e50-a4a1-8d3ea42058a5": "Es una herramienta visual, qué contiene nombre de clase, atributos y métodos y puede ser publico o privado (como un mapa para organizar las ideas) "}	4.25	\N	completado	0	2026-05-01 01:03:41.680914+00	2026-05-01 01:14:58.605+00	2026-05-01 01:03:41.680914+00	2026-05-08 01:04:12.514626+00	f	\N	\N	\N	0
2d49ac63-e2b0-4579-976c-5d9cb4b38ceb	9ab4413a-f0e3-448d-a070-536cc466197e	dac41f00-64e7-40b8-a207-31f1ee2718c0	{}	\N	5	completado	0	2026-05-06 17:17:17.592+00	2026-05-06 17:27:38.558+00	2026-05-06 17:17:17.934938+00	2026-05-06 17:27:38.804833+00	f	\N	\N	\N	0
e9f82629-8e2c-46c5-b0b0-7f5c9611854d	9ab4413a-f0e3-448d-a070-536cc466197e	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	{}	\N	4.25	completado	0	2026-05-06 17:26:03.274+00	2026-05-06 17:27:41.779+00	2026-05-06 17:26:03.510607+00	2026-05-06 17:27:42.094774+00	f	\N	\N	\N	0
c7026ae1-c2dc-4882-8993-fa68f829f5cd	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	0a02892e-8476-44da-90e8-384c064e6040	{"__session_id": "912e6e00-8a1c-41bf-bc07-10083e7cce71", "6eb2087a-28da-4911-a1f5-1a56d72f4c7e": "class Motor{\\r\\n\\r\\n    private String Tipo;\\r\\n    private int Potencia;\\r\\n    \\r\\n    public Motor(String Tipo, int Potencia){\\r\\n        this.Tipo = Tipo;\\r\\n        this.Potencia = Potencia\\r\\n    }\\r\\n\\r\\n    public String getTipo(){\\r\\n        return Tipo;\\r\\n    }\\r\\n\\r\\n    public int getPotencia(){\\r\\n        return Potencia;\\r\\n    }\\r\\n}\\r\\n\\r\\nclass Vehiculo{\\r\\n    private Motor motor;\\r\\n\\r\\n    public Vehiculo(String tipoMotor, int potenciaMotor){\\r\\n        this.motor = new Motor(tipoMotor, potenciaMotor);\\r\\n    }\\r\\n    public void informacionMotor{\\r\\n        System.out.println(\\"Tipo de motor: \\" + motor.getTipo());\\r\\n        System.out.println(\\"Potencia del motor: \\" + motor.getPotencia() + \\"HP\\");\\r\\n    }\\r\\n    public static void main(String[] args){\\r\\n        Vehiculo auto = new Vehiculo(\\"gasolina\\", 150);\\r\\n        auto.informacionMotor();\\r\\n    }\\r\\n}", "8db47d7f-c0e5-4166-bfba-2fb651100cca": 2, "bd63a640-9636-4e50-a4a1-8d3ea42058a5": "Es una clase de mapa visual el cual muestra como están organizadas las clases de un programa y como se relacionan entre si"}	3.25	\N	completado	0	2026-05-01 00:58:19.902496+00	2026-05-01 01:14:58.62+00	2026-05-01 00:58:19.902496+00	2026-05-01 02:36:14.377822+00	f	\N	\N	\N	0
9d70aafb-4c90-4b27-8e30-e9822a503d2d	2c29880e-df95-4650-9653-3f6b72cc7632	e8b3c430-2162-413b-8560-9e3a43e3577e	{"__breakdown": [{"qid": "6dd61ae0-d510-4a0c-83e4-7cb7bde860b6", "type": "java_gui", "earned": 0.4, "points": 1, "feedback": "La respuesta crea una ventana y muestra el texto \\"Hola\\", pero usa un JLabel en lugar de un JButton. No cumple con el requisito de tener un botón.", "ai_reasons": "La respuesta es sintácticamente correcta y concisa, similar a cómo una IA podría generar un snippet de código. Sin embargo, no usa el componente correcto (`JLabel` en lugar de `JButton`). Una IA podría cometer este error si no procesa completamente la instrucción clave de crear un \\"botón\\")))) fechas", "ai_likelihood": 0.6}, {"qid": "1c1b1c30-8496-4867-81d4-16471ab1a42e", "type": "abierta", "earned": 0, "points": 1, "feedback": "Sin respuesta"}, {"qid": "88f93771-0b0f-412e-bd22-1ba074817bfb", "type": "codigo", "earned": 0, "points": 1, "feedback": "Sin respuesta"}, {"qid": "72acdb9b-5fb3-48b5-96f2-1089816a4a18", "type": "diagrama", "earned": 0, "points": 1, "feedback": "Sin respuesta"}], "__session_id": "c9ae69ee-90d0-43b2-a529-bcb8af8181bd", "__warning_events": [{"at": "2026-05-08T00:59:38.431Z", "type": "pestaña", "questionIdx": null}, {"at": "2026-05-08T00:59:44.140Z", "type": "fullscreen_exit", "questionIdx": null}, {"at": "2026-05-08T00:59:57.517Z", "type": "pestaña", "questionIdx": null}], "6dd61ae0-d510-4a0c-83e4-7cb7bde860b6": "import javax.swing.*;\\nimport java.awt.*;\\n\\npublic class Main {\\n  public static void main(String[] args) {\\n    JFrame f = new JFrame(\\"Hola\\");\\n    f.setSize(320, 200);\\n    f.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);\\n    JLabel ejemplo = new JLabel(\\"Hola\\", 50);\\n    f.add(ejemplo);\\n    f.setVisible(true);\\n  }\\n}\\n"}	0.5	\N	sospechoso	3	2026-05-08 00:56:12.780366+00	2026-05-08 00:59:57.517+00	2026-05-08 00:56:12.780366+00	2026-05-08 01:00:05.076109+00	t	0.6	[0.60] La respuesta es sintácticamente correcta y concisa, similar a cómo una IA podría generar un snippet de código. Sin embargo, no usa el componente correcto (`JLabel` en lugar de `JButton`). Una IA podría cometer este error si no procesa completamente la instrucción clave de crear un "botón")))) fechas	\N	0
e9ba41b9-678f-412e-8a64-bf90d13fbd48	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	{"__breakdown": [{"qid": "88862e8e-d725-40ed-b4f0-51b0494c5b32", "type": "codigo", "earned": 0.4, "points": 1, "feedback": "El estudiante mostró comprensión de la lógica para filtrar, iterar y extraer elementos. Sin embargo, hay varios errores de sintaxis y lógica que impiden que el código compile y ejecute correctamente. Falta la inicialización de `elNombre`, el `HashMap` se llama `persona1` pero se usa `Persona2`, y hay inconsistencias en los nombres de las variables en el `main`. Faltaría además cast de `Object` a `String` para el nombre. Pistas de IA: la estructura general del código es correcta y hay errores típicos de principiantes.", "ai_reasons": "El código presenta una estructura lógica correcta para la tarea planteada, lo que podría indicar que una IA generó el esqueleto. Sin embargo, se observan errores de sintaxis en el código, especialmente en el método main y en la gestión de variables (`elNombre` no está definido, `Persona2` en lugar de `persona1`,  etc.), que son consistentes con errores que cometen los humanos al programar, no tanto con lo que una IA generaría directamente.  La combinación de una estructura lógica sólida con errores de implementación hace que sea plausible que una IA haya dado una base que el estudiante intentó completar o modificar.", "ai_likelihood": 0.7}, {"qid": "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a", "type": "codigo", "earned": 0.8, "points": 1, "feedback": "El código del estudiante es casi correcto. Cumple con la mayoría de los requisitos, pero tiene algunos errores de sintaxis y lógica en la sección `main` que impiden su ejecución. La implementación del método `obtenerCiudades` es totalmente correcta.", "ai_reasons": "El código es estructuralmente correcto y sigue las mejores prácticas de Java, pero contiene errores gramaticales y de tipeo al crear variables o al llamar a métodos (por ejemplo, `HashSet>String>`, `Respuesta2 quiz = new Respuesta2()` en lugar de `new Pregunta2()`, `System.ou.println`), lo que sugiere que podría haber sido generado por IA y luego revisado por una persona que introdujo errores o que fue generado por IA con errores menores.", "ai_likelihood": 0.7}, {"qid": "70255d55-f4e9-4ee3-a2f7-474cc955a9a2", "type": "codigo", "earned": 0.9, "points": 1, "feedback": "La respuesta del estudiante es casi perfecta, cumple con todos los requisitos de la rúbrica. Sin embargo, el código está incompleto al final (falta cerrar el método main y la clase). A pesar de esto, la lógica principal está correctamente implementada.", "ai_reasons": "La respuesta muestra una comprensión muy sólida y una implementación directa de la solución, lo cual es común en respuestas generadas por IA. La falta de finalización del código (llaves de cierre en main y class) podría ser un indicio de una generación parcial o un error de corte, pero la estructura y la corrección del algoritmo son altas.", "ai_likelihood": 0.7}], "__session_id": "ac9f176a-12ce-4846-9181-fe3b4b437d95", "__warning_events": [], "70255d55-f4e9-4ee3-a2f7-474cc955a9a2": "import java.util.ArrayList;\\r\\nimport java.util.HashSet;\\r\\n\\r\\npublic class pregunta3 {\\r\\n    public boolean\\r\\n    buscarNumero(HashSet<ArrayList<Integer>>conjuntoDeListas, int numeroBuscado){\\r\\n        for (ArrayList<Integer> lista : conjuntoDeListas){\\r\\n        \\r\\n        if (lista.contains(numeroBuscado)){\\r\\n            return true;\\r\\n        }\\r\\n        }\\r\\n        return false;\\r\\n    }\\r\\n    public static void main \\r\\n}", "88862e8e-d725-40ed-b4f0-51b0494c5b32": "import java.util.ArrayList;\\r\\nimport java.util.HashMap;\\r\\nimport java.util.List;\\r\\n\\r\\npublic class Pregunta1 {\\r\\n   \\r\\n    public ArrayList<String> filtraredadMayorDe30(ArrayList<HashMap<String, Object>>listaPersonas) {\\r\\n        ArrayList<String> Nombres = new ArrayList<>();\\r\\n        \\r\\n        for  (int i = 0; i < listaPersonas.size(); i++) {\\r\\n            HashMap<String, Object>laperson = listaPersonas.get (i);\\r\\n\\r\\n            int laEdad = (int)\\r\\n            laperson.get (\\"edad\\");\\r\\n            \\r\\n            if (laEdad >30){\\r\\n                Nombres.add(elNombre);\\r\\n                \\r\\n            }\\r\\n       }\\r\\n       return Nombres;\\r\\n    }\\r\\n\\r\\n    public static void main (String[] args) {\\r\\n\\r\\n    \\r\\n     Pregunta1 pregunta = new Pregunta1();\\r\\n     \\r\\n     ArrayList<HashMap<String, Object>> listaPrueba = new ArrayList<>();\\r\\n     HashMap<String, Object> persona1 = new HashMap<>();\\r\\n     Persona2.put(\\"nomnbre\\", \\"Angie\\");\\r\\n     Persona2.put (\\"edad\\", 37);\\r\\n     listaPrueba.add (Persona2);\\r\\n     ArrayList<String> resultado = quiz.filtraredadMayorDe30(listaPrueba);\\r\\n     System.out.println(\\"Los mayores de 30 son:\\" + resultado);\\r\\n     \\r\\n     }\\r\\n\\r\\n     }\\r\\n\\r\\n", "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a": "import java.util.HashMap;\\r\\nimport java.util.HashSet;\\r\\n\\r\\npublic class Pregunta2 {\\r\\n    public HashSet>String>\\r\\n    obtenerCiudades(HashMap<String, HashSet<String>> mapaPaises, String paisBuscado){\\r\\n        if (mapaPaises.containsKey(paisBuscado)){\\r\\n            HashSet<String> lasCiudades = mapaPaises.get (paisBuscado);\\r\\n            return lasCiudades;\\r\\n        } else {\\r\\n            HashSet<String> ciudadesVacias = new HashSet<>();\\r\\n            return ciudadesVacias;\\r\\n        }\\r\\n    }\\r\\n    public static void main (String[] args){\\r\\n        Respuesta2 quiz = new Respuesta2();\\r\\n\\r\\n        HashMap<String> ciudadesPolombia = new HashSet<>();\\r\\n        ciudadesPolombia.add(\\"Pereira\\");\\r\\n        ciudadesPolombia.add(\\"Caliwood\\");\\r\\n        ciudadesPolombia.add(\\"Medallo\\");\\r\\n\\r\\n        paisesYciudades.put(\\"Polombia\\",ciudadesPolombia);\\r\\n        HashSet<String> ciudadesPeru = new HashSet<>();\\r\\n        ciudadesPeru.add(\\"Lima\\");\\r\\n        ciudadesPeru.add(\\"Chiclayo\\");\\r\\n        paisesYciudades.put (\\"Peru\\",ciudadesPeru);\\r\\n\\r\\n        System.ou.println(\\"---RESULTADO PRUE---\\");\\r\\n        HashSet<String> Respuesta1 = quiz.obtenerCiudades(paisesYciudades,\\"Polombia\\");\\r\\n\\r\\n        System.ou.println(\\"ciudades de Polombia: \\" + Respuesta1);\\r\\n\\r\\n        HashSet<String> Respuesta2 = quiz.obtenerCiudades(paisesYciudades, \\"EEUU\\");\\r\\n        System.out.println(\\"Ciudades de EEUU: \\" + Respuesta2);\\r\\n\\r\\n    }\\r\\n}"}	3.5	\N	sospechoso	0	2026-05-08 01:53:07.132534+00	2026-05-08 02:56:45.727+00	2026-05-08 01:53:07.132534+00	2026-05-08 02:56:54.902246+00	t	0.7	[0.70] El código presenta una estructura lógica correcta para la tarea planteada, lo que podría indicar que una IA generó el esqueleto. Sin embargo, se observan errores de sintaxis en el código, especialmente en el método main y en la gestión de variables (`elNombre` no está definido, `Persona2` en lugar de `persona1`,  etc.), que son consistentes con errores que cometen los humanos al programar, no tanto con lo que una IA generaría directamente.  La combinación de una estructura lógica sólida con errores de implementación hace que sea plausible que una IA haya dado una base que el estudiante intentó completar o modificar.\n[0.70] El código es estructuralmente correcto y sigue las mejores prácticas de Java, pero contiene errores gramaticales y de tipeo al crear variables o al llamar a métodos (por ejemplo, `HashSet>String>`, `Respuesta2 quiz = new Respuesta2()` en lugar de `new Pregunta2()`, `System.ou.println`), lo que sugiere que podría haber sido generado por IA y luego revisado por una persona que introdujo errores o que fue generado por IA con errores menores.\n[0.70] La respuesta muestra una comprensión muy sólida y una implementación directa de la solución, lo cual es común en respuestas generadas por IA. La falta de finalización del código (llaves de cierre en main y class) podría ser un indicio de una generación parcial o un error de corte, pero la estructura y la corrección del algoritmo son altas.	\N	0
625a8fb7-89c5-4216-b563-ebc3606bd6d1	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	19e004a1-c1f2-4ca5-91d2-4c095058cb84	{"__breakdown": [{"qid": "bd63a640-9636-4e50-a4a1-8d3ea42058a5", "type": "abierta", "earned": 0.3, "points": 1, "feedback": "La respuesta del estudiante es demasiado superficial y no incluye los puntos clave de la rúbrica, aunque la analogía del \\"mapa\\" es un buen comienzo para una explicación más técnica."}, {"qid": "8db47d7f-c0e5-4166-bfba-2fb651100cca", "type": "cerrada", "earned": 1, "points": 1}, {"qid": "6eb2087a-28da-4911-a1f5-1a56d72f4c7e", "type": "codigo", "earned": 0, "points": 1, "feedback": "La respuesta del estudiante se limita a un diagrama de clases UML muy básico, no proporcionando el código Java funcional solicitado que demuestre la composición y los métodos requeridos para interactuar con la clase `Motor` dentro de `Vehiculo`."}, {"qid": "78edabd9-4e4f-4c2c-aeab-aeeb66e09a8a", "type": "diagrama", "earned": 0, "points": 1, "feedback": "Sin respuesta"}], "__session_id": "ee35af4b-4d5f-4f0a-a271-a553487ded7a", "__warning_events": [], "6eb2087a-28da-4911-a1f5-1a56d72f4c7e": "class Motor{\\n    -tipo:String\\n    -porencia:int\\n}\\nclass Vehiculo{\\n    -color:String\\n    -marca:String\\n    -placa:String\\n    -motor:Motor\\n    +imprimirMotor():void\\n}\\nVehiculo Motor:tiene", "8db47d7f-c0e5-4166-bfba-2fb651100cca": 2, "bd63a640-9636-4e50-a4a1-8d3ea42058a5": "Es como un mapa que ayuda a ver cómo van organizados y conectados los objetos en un programa "}	3.25	\N	completado	0	2026-05-01 01:01:19.217075+00	2026-05-01 01:15:14.925+00	2026-05-01 01:01:19.217075+00	2026-05-01 01:15:24.126377+00	f	\N	\N	\N	0
47088e95-0dca-49ac-a217-8d5ce1a44931	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	2d709409-7b44-403d-a315-b8bb826aa8ca	{"__session_id": "1e63d7aa-1ae4-46ce-9adb-e3b22ae029ff", "__warning_events": [{"at": "2026-05-01T01:14:34.582Z", "type": "pestaña", "questionIdx": null}], "6eb2087a-28da-4911-a1f5-1a56d72f4c7e": "class Motor{\\r\\n    public String tipo;\\r\\n    public int potencia;\\r\\n    public Motor {\\r\\n        this.tipo = tipo;\\r\\n        this.potencia = potencia;\\r\\n    }\\r\\n    public String getTipo(){return tipo;}\\r\\n    public int getPontencia(){return potencia;}\\r\\n}\\r\\npublic class vehiculo{\\r\\n    private Motor motor;\\r\\n    public \\r\\n\\r\\n}", "8db47d7f-c0e5-4166-bfba-2fb651100cca": 2, "bd63a640-9636-4e50-a4a1-8d3ea42058a5": "es un diagrama que representa graficamente los atributos y metodos de una clase y sus relaciones con las demas clases"}	4.5	\N	completado	1	2026-05-01 00:59:07.906461+00	2026-05-01 01:15:08.813+00	2026-05-01 00:59:07.906461+00	2026-05-01 01:23:23.965595+00	f	\N	\N	\N	0
917d0b8b-9c77-4583-af26-abcca9996e36	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	d048a636-8a14-4fcd-aa3e-891cca899b32	{"__breakdown": [{"qid": "bd63a640-9636-4e50-a4a1-8d3ea42058a5", "type": "abierta", "earned": 1, "points": 1, "feedback": "La respuesta del estudiante es completa y precisa, cubriendo todos los puntos de la rúbrica. Define el diagrama de clases como una representación estática, menciona clases, atributos, métodos y relaciones, y su importancia en el diseño de sistemas POO."}, {"qid": "8db47d7f-c0e5-4166-bfba-2fb651100cca", "type": "cerrada", "earned": 1, "points": 1}, {"qid": "6eb2087a-28da-4911-a1f5-1a56d72f4c7e", "type": "codigo", "earned": 0.2, "points": 1, "feedback": "La respuesta solo incluye la clase `Motor` y un constructor. Faltan la clase `Vehiculo`, la demostración de composición y el método para mostrar la información del motor."}, {"qid": "78edabd9-4e4f-4c2c-aeab-aeeb66e09a8a", "type": "diagrama", "earned": 0, "points": 1, "feedback": "La respuesta del estudiante no aborda la pregunta sobre el diagrama de clases UML para la composición de Vehículo y Motor. En su lugar, proporciona un diagrama de clases de animales que no cumple con ninguno de los criterios de la rúbrica."}], "__session_id": "724d7ab4-a99e-444b-99a0-ebc20c80f352", "__warning_events": [], "6eb2087a-28da-4911-a1f5-1a56d72f4c7e": "public class Motor {\\r\\nString tipo;\\r\\nint potencia;\\r\\n\\r\\nMotor (String tipo , int potencia){\\r\\nthis.tipo = tipo;\\r\\nthis.potencia = potencia;\\r\\n\\r\\n}\\r\\n\\r\\n}", "78edabd9-4e4f-4c2c-aeab-aeeb66e09a8a": "classDiagram\\n    class Vehiculo{\\n        +String nombre\\n        +int edad\\n        +hacerSonido() void\\n    }\\n    class Perro {\\n        +String raza\\n        +ladrar() void\\n    }\\n    class Gato {\\n        +ronronear() void\\n    }\\n    Animal <|-- Perro\\n    Animal <|-- Gato", "8db47d7f-c0e5-4166-bfba-2fb651100cca": 2, "bd63a640-9636-4e50-a4a1-8d3ea42058a5": "Un diagrama de clases es una representacion grafica por decirlo asi, esta muestra la estructura estatica de un sistema orientado a objetos, incluyendo las clases, sus atributos, sus metodos y las relaciones que existen entre ellas.  "}	2.75	\N	completado	0	2026-05-01 01:01:33.944527+00	2026-05-01 01:14:59.374+00	2026-05-01 01:01:33.944527+00	2026-05-01 02:36:14.377822+00	f	\N	\N	\N	0
1b5be126-d022-4ba8-969e-ef6fc3472a50	9ab4413a-f0e3-448d-a070-536cc466197e	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	{}	\N	4.5	completado	0	2026-05-06 17:17:48.403+00	2026-05-06 17:27:39.74+00	2026-05-06 17:17:48.63275+00	2026-05-06 17:27:39.962632+00	f	\N	\N	\N	0
a2c656e3-5509-48a9-bae0-624e17981a7e	9ab4413a-f0e3-448d-a070-536cc466197e	19e004a1-c1f2-4ca5-91d2-4c095058cb84	{}	\N	3.5	completado	0	2026-05-06 17:26:23.648+00	2026-05-06 17:27:40.251+00	2026-05-06 17:26:23.901523+00	2026-05-06 17:27:40.570507+00	f	\N	\N	\N	0
fa2bef15-a9ca-4f61-85b7-9ae629f015a4	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	{"__session_id": "0ac42ceb-0512-4ed9-bc6f-d3153528b32a", "__warning_events": [{"at": "2026-05-01T01:00:56.226Z", "type": "pestaña", "questionIdx": null}], "6eb2087a-28da-4911-a1f5-1a56d72f4c7e": "class Motor {\\r\\n    private String tipo;\\r\\n    private int potencia;\\r\\n\\r\\n    public Motor (String tipo, int potencia){\\r\\n        this.tipo = tipo;\\r\\n        this.potencia = potencia;\\r\\n    }\\r\\n    public String getTipo(){\\r\\n        return tipo;\\r\\n    }\\r\\n    public int getPotencia(){\\r\\n        return potencia;\\r\\n    }\\r\\n    public void mostrarInfo(){\\r\\n        System.out.println(\\"Tipo de motor: \\"+ tipo);\\r\\n        System.out.println(\\"potencia: \\" + potencia + \\"HP\\");\\r\\n    }\\r\\n}\\r\\n\\r\\nclass Vehiculo {\\r\\n    private Motor motor;\\r\\n    public Vehiculo(String tipoMotor, int potencia){\\r\\n        this.motor = new motor(tipoMotor,)", "8db47d7f-c0e5-4166-bfba-2fb651100cca": 2, "bd63a640-9636-4e50-a4a1-8d3ea42058a5": "muestra la estructura de un sistema indicando sus clases, atributos, metodos y las relaciones entre ellas como la herencia o dependencia"}	2.69	\N	completado	1	2026-05-01 01:00:40.324096+00	2026-05-01 01:14:58.963+00	2026-05-01 01:00:40.324096+00	2026-05-01 02:36:14.377822+00	f	\N	\N	\N	0
d8f235b6-fc4c-491c-8957-328372226e05	9ab4413a-f0e3-448d-a070-536cc466197e	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	{}	\N	5	completado	0	2026-05-06 17:17:59.85+00	2026-05-06 17:27:39.529+00	2026-05-06 17:18:00.103796+00	2026-05-06 17:27:39.750118+00	f	\N	\N	\N	0
6d13036e-7cc9-404c-bb34-7fe3f44a790e	9ab4413a-f0e3-448d-a070-536cc466197e	0a02892e-8476-44da-90e8-384c064e6040	{}	\N	5	completado	0	2026-05-06 17:26:41.424+00	2026-05-06 17:27:42.4+00	2026-05-06 17:26:41.673902+00	2026-05-06 17:27:42.715291+00	f	\N	\N	\N	0
63f721dc-3dc5-43cf-a10e-88ea107e7e38	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	dac41f00-64e7-40b8-a207-31f1ee2718c0	{"__breakdown": [{"qid": "88862e8e-d725-40ed-b4f0-51b0494c5b32", "type": "codigo", "earned": 0.7, "points": 1, "feedback": "Puntos a favor: El estudiante ha logrado implementar la lógica principal para filtrar los nombres de las personas mayores de 30 años. Se utiliza un bucle `for-each` para iterar sobre la lista de `HashMaps`, se extraen correctamente el nombre y la edad, y se añade el nombre a un nuevo `ArrayList` si la edad cumple la condición. Se hizo uso correcto de `ArrayList` y `HashMap`. Puntos a mejorar: el retorno del método `obtenerMayoresDe30` está dentro del bucle, lo que provoca que solo se procese la primera persona de la lista. Además, hay un error de sintaxis en `nombres.add(nombre):` (debería ser punto y coma). En el método `main`, la definición de `personas` es incorrecta (`ArrayList<String, Object>` en lugar de `ArrayList<HashMap<String, Object>>`), y la clave de la edad en `p3` tiene una ", "ai_reasons": "La respuesta presenta una estructura bastante organizada y cumple con la mayoría de los requisitos, pero tiene errores puntuales y sutiles (retorno dentro del bucle, tipo incorrecto en la instanciación del ArrayList en el main, error de sintaxis y una capitalización incorrecta en una clave del HashMap) que son comunes en las respuestas generadas por IA que no siempre logran la perfección en la lógica o en los detalles del código. La IA tiende a tener una comprensión general del problema, pero puede fallar en pequeños detalles o en la depuración completa del flujo de control o la sintaxis. Además, el formato del código es limpio y consistente, algo esperable en generadores de código de IA.", "ai_likelihood": 0.7}, {"qid": "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a", "type": "codigo", "earned": 1, "points": 1, "feedback": "La respuesta del estudiante es sobresaliente. Ha abordado todos los requisitos de la rúbrica de forma precisa, el código es funcional y demuestra una clara comprensión del problema. Es una solución completa y correcta.", "ai_reasons": "La respuesta muestra una estructura y sintaxis de código perfectas, lo que podría indicar una generación por IA. No obstante, la lógica es perfectamente coherente y resuelve el problema planteado, lo cual es característico de una buena respuesta. La falta de errores sutiles o peculiaridades que a menudo se encuentran en el código generado por humanos inclina la probabilidad hacia la IA.", "ai_likelihood": 0.6}, {"qid": "70255d55-f4e9-4ee3-a2f7-474cc955a9a2", "type": "codigo", "earned": 0.7, "points": 1, "feedback": "El código implementa correctamente la estructura de datos y el método `contieneNumero`, pero el método tiene un error lógico en su iteración. Devuelve `false` en la primera iteración si el número no está en el primer `ArrayList`, en lugar de seguir buscando en los demás. Esto hace que falle en ciertos casos, como cuando el número buscado está en un `ArrayList` subsiguiente.", "ai_reasons": "El error lógico en el bucle `for` es un tipo de error que a veces cometen los programadores humanos. Un modelo de IA podría generar un código perfectamente funcional o, si comete un error, podría ser más sutil o diferente. Sin embargo, no se aprecian patrones de escritura u otros artefactos consistentes con la generación por IA.", "ai_likelihood": 0.3}], "__session_id": "79355e23-1863-4916-a1d9-ffd3f4321a74", "__warning_events": [], "70255d55-f4e9-4ee3-a2f7-474cc955a9a2": "import java.util.ArrayList;\\r\\nimport java.util.HashSet;\\r\\n\\r\\npublic class Main{\\r\\n    public static boolean contieneNumero(HashSet<ArrayList<Integer>> conjuntos, Integer numero){\\r\\n        for(ArrayList<Integer> lista : conjuntos){\\r\\n            if(lista.contains(numero)){\\r\\n                return true;\\r\\n            }\\r\\n\\r\\n            return false;\\r\\n        }\\r\\n    }\\r\\n\\r\\n    public static void main(String[] args){\\r\\n        HashSet<ArrayList<Integer>> conjuntos = new HashSet<>();\\r\\n\\r\\n        ArrayList<Integer> lista1 = new ArrayList<>();\\r\\n        lista1.add(1);\\r\\n        lista1.add(2);\\r\\n        lista1.add(3);\\r\\n\\r\\n        ArrayList<Integer> lista2 = new ArrayList<>();\\r\\n        lista2.add(10);\\r\\n        lista2.add(20);\\r\\n        lista2.add(30);\\r\\n\\r\\n        ArrayList<Integer> lista3 = new ArrayList<>();\\r\\n        lista3.add(100);\\r\\n        lista3.add(200);\\r\\n        lista3.add(300);\\r\\n\\r\\n        conjuntos.add(lista1);\\r\\n        conjuntos.add(lista2);\\r\\n        conjuntos.add(lista3);\\r\\n\\r\\n        System.out.println(contieneNumero(conjuntos, 20));\\r\\n        System.out.println(contieneNumero(conjuntos, 5));\\r\\n    }\\r\\n}", "88862e8e-d725-40ed-b4f0-51b0494c5b32": "import java.util.ArrayList;\\r\\nimport java.util.HashMap;\\r\\n\\r\\npublic class Main {\\r\\n    public static ArrayList<String> obtenerMayoresDe30(ArrayList<HashMap<String, Object>> personas){\\r\\n        ArrayList<String> nombres = new ArrayList<>();\\r\\n\\r\\n        for(HashMap<String, Object> persona : personas){\\r\\n            String nombre = (String)persona.get(\\"nombre\\");\\r\\n            int edad = (int) persona.get(\\"edad\\");\\r\\n\\r\\n            if(edad > 30){\\r\\n                nombres.add(nombre):\\r\\n            }\\r\\n\\r\\n            return nombres\\r\\n        }\\r\\n    }\\r\\n\\r\\n    public static void main(String[] args){\\r\\n        ArrayList<String, Object> personas = new ArrayList<>();\\r\\n\\r\\n        HashMap<String, Object> p1 = new HashMap<>();\\r\\n        p1.put(\\"nombre\\", \\"juan\\");\\r\\n        p1.put(\\"edad\\", 25);\\r\\n\\r\\n        HashMap<String, Object> p2 = new HashMap<>();\\r\\n        p2.put(\\"nombre\\", \\"Maria\\");\\r\\n        p2.put(\\"edad\\", 30);\\r\\n\\r\\n        HashMap<String, Object> p3 = new HashMap<>();\\r\\n        p3.put(\\"nombre\\", \\"Carlos\\");\\r\\n        p3.put(\\"Edad\\", 40);\\r\\n\\r\\n        personas.add(p1);\\r\\n        personas.add(p2);\\r\\n        personas.add(p3);\\r\\n\\r\\n        ArrayList<String> resultado = obtenerMayoresDe30(personas);\\r\\n\\r\\n        System.out.println(resultado);\\r\\n    }\\r\\n}", "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a": "import java.util.HashMap;\\r\\nimport java.util.HashSet;\\r\\n\\r\\npublic class Main{\\r\\n    public static HashSet<String> ObtenerCiudades(HashMap<String, HashSet<String>> paises, String pais){\\r\\n\\r\\n        if(paises.containsKey(pais)){\\r\\n            return paises.get(pais);\\r\\n        }\\r\\n\\r\\n        return new HashSet<>();\\r\\n\\r\\n    }\\r\\n\\r\\n    public static void main(String[], args){\\r\\n        HashMap<String, HashSet<String>> paises = new HashMap<>();\\r\\n\\r\\n        HashSet<String> ciudadesColombia = new HashSet<>();\\r\\n        ciudadesColombia.add(\\"Bogota\\");\\r\\n        ciudadesColombia.add(\\"Medellin\\");\\r\\n        ciudadesColombia.add(\\"Cali\\");\\r\\n\\r\\n        HashSet<String> ciudadesMexico = new HashSet<>();\\r\\n        ciudadesMexico.add(\\"Ciudad de Mexico\\");\\r\\n        ciudadesMexico.add(\\"Guadalajara\\");\\r\\n        ciudadesMexico.add(\\"Monterrey\\");\\r\\n\\r\\n        paises.put(\\"Colombia\\", ciudadesColombia);\\r\\n        paises.put(\\"Mexico\\", ciudadesMexico);\\r\\n\\r\\n        HashSet<String> resultado = ObtenerCiudades(paises, \\"Colombia\\");\\r\\n        System.out.println(resultado);\\r\\n\\r\\n        HashSet<String> resultado2 = ObtenerCiudades(paises, \\"Argentina\\");\\r\\n        System.out.println(resultado2);\\r\\n\\r\\n    }\\r\\n}\\r\\n"}	4	\N	sospechoso	0	2026-05-08 01:06:32.877922+00	2026-05-08 01:44:48.297+00	2026-05-08 01:06:32.877922+00	2026-05-08 01:44:57.298106+00	t	0.7	[0.70] La respuesta presenta una estructura bastante organizada y cumple con la mayoría de los requisitos, pero tiene errores puntuales y sutiles (retorno dentro del bucle, tipo incorrecto en la instanciación del ArrayList en el main, error de sintaxis y una capitalización incorrecta en una clave del HashMap) que son comunes en las respuestas generadas por IA que no siempre logran la perfección en la lógica o en los detalles del código. La IA tiende a tener una comprensión general del problema, pero puede fallar en pequeños detalles o en la depuración completa del flujo de control o la sintaxis. Además, el formato del código es limpio y consistente, algo esperable en generadores de código de IA.\n[0.60] La respuesta muestra una estructura y sintaxis de código perfectas, lo que podría indicar una generación por IA. No obstante, la lógica es perfectamente coherente y resuelve el problema planteado, lo cual es característico de una buena respuesta. La falta de errores sutiles o peculiaridades que a menudo se encuentran en el código generado por humanos inclina la probabilidad hacia la IA.\n[0.30] El error lógico en el bucle `for` es un tipo de error que a veces cometen los programadores humanos. Un modelo de IA podría generar un código perfectamente funcional o, si comete un error, podría ser más sutil o diferente. Sin embargo, no se aprecian patrones de escritura u otros artefactos consistentes con la generación por IA.	\N	0
3e916565-2c8a-4602-9c7c-e12442443272	9ab4413a-f0e3-448d-a070-536cc466197e	e8b3c430-2162-413b-8560-9e3a43e3577e	{}	\N	4.2	completado	0	2026-05-06 17:18:12.161+00	2026-05-06 17:27:39.331+00	2026-05-06 17:18:12.393506+00	2026-05-06 17:27:39.545682+00	f	\N	\N	\N	0
26fddc99-7e7c-4945-898d-522ea375490a	9ab4413a-f0e3-448d-a070-536cc466197e	bce0ddee-4001-45e9-b323-719f80dc4f6d	{}	\N	4.9	completado	0	2026-05-06 17:27:06.922+00	2026-05-06 17:27:39.94+00	2026-05-06 17:27:07.162918+00	2026-05-06 17:27:40.25996+00	f	\N	\N	\N	0
c0efc0dc-705f-4fa8-82ff-217f0ecde1d8	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	531392ff-60c0-471d-af30-5e58bc80e860	{"__breakdown": [{"qid": "88862e8e-d725-40ed-b4f0-51b0494c5b32", "type": "codigo", "earned": 1, "points": 1, "feedback": "El estudiante incluyó un método en Java que cumple con todos los requisitos de la rúbrica. Acepta un ArrayList de HashMaps, itera sobre ellos, extrae la edad, verifica la condición y agrega el nombre al nuevo ArrayList. Excelente.", "ai_reasons": "La respuesta es impecable y directamente al grano, sin errores ni divagaciones. La estructura del código es perfecta. Si bien podría ser escrita por un humano con experiencia, la pulcritud y la falta de cualquier error menor o estilo personal la hacen sospechosa de ser generada por IA. No incluye comentarios o explicaciones que un humano podría añadir paraclarificar el código.", "ai_likelihood": 0.7}, {"qid": "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a", "type": "codigo", "earned": 1, "points": 1, "feedback": "La respuesta es completamente correcta y cumple con todos los requisitos de la rúbrica. El código es funcional y demuestra una comprensión clara de los conceptos solicitados.", "ai_reasons": "La respuesta está bien formateada y es correcta, pero el código presenta un pequeño error sintáctico (punto y coma mal ubicado que no genera error de compilacion). Esto es más común en respuestas humanas que en las generadas por IA, que tienden a ser impecables en la sintaxis. Pude replicar el error en mi entorno de desarrollo.", "ai_likelihood": 0.1}, {"qid": "70255d55-f4e9-4ee3-a2f7-474cc955a9a2", "type": "codigo", "earned": 1, "points": 1, "feedback": "La respuesta del estudiante es excelente. Cumple con todos los requisitos de la rúbrica al estructurar correctamente el `HashSet<ArrayList<Integer>>`, implementar un método eficiente para buscar el número y proporcionar ejemplos claros de uso en el `main`.", "ai_reasons": "La respuesta está perfectamente formateada, el código está completo y es totalmente funcional. Esto es típico de códigos generados por IA que buscan la solución más directa y eficiente sin errores comunes de sintaxis o lógica que un humano podría cometer. Además, la estructura del código es muy clara y con un enfoque pedagógico que suele observarse en las respuestas de IA, incluyendo la clase principal y el método `main` para testing. El uso de la palabra `número` sin tilde dentro de `lista.contains(número)` lo que puede ser un error común en la escritura humana, pero es algo que una IA puede replicar si el modelo fue entrenado con textos que presentan esta característica o si simplemente lo copia del prompt de forma literal, lo cual eleva la probabilidad a 0.9.  Además se observa un espaciado a nivel de línea que no es óptimo al interior del la clase que contiene la función `contieneNumero`, que la IA podría mejorar pero no es un error sustancial.", "ai_likelihood": 0.9}], "__session_id": "2646a1c6-e748-449e-a57a-03d968381385", "__warning_events": [{"at": "2026-05-08T02:23:14.823Z", "type": "pestaña", "questionIdx": null}], "70255d55-f4e9-4ee3-a2f7-474cc955a9a2": "import java.util.*;\\r\\n\\r\\npublic class Quiz{\\r\\n    public static boolean contieneNumero (HashSet<ArrayList<Integer>> conjunto, int numero){\\r\\n        for(ArrayList<Integer>lista : conjunto){\\r\\n            if (lista.contains(número)){\\r\\n                return true;\\r\\n            }\\r\\n    }\\r\\n    return false;\\r\\n    }\\r\\n    public static void main (String[] args){\\r\\n        ArrayList<Integer> lista1 = new ArrayList<>();\\r\\n\\r\\n        lista1.add(1);\\r\\n        lista1.add(2);\\r\\n        lista1.add(3);\\r\\n\\r\\n        ArrayList<Integer>lista2 = new ArrayList<>();\\r\\n        lista2.add(4);\\r\\n        lista2.add(5);\\r\\n        lista2.add(6);\\r\\n\\r\\n        ArrayList<Integer>lista3 = new ArrayList<>();\\r\\n        lista3.add(7);\\r\\n        lista3.add(8);\\r\\n        lista3.add(9);\\r\\n\\r\\n        HashSet<ArrayList<Integer>> conjunto = new HashSet<>();\\r\\n        conjunto.add(lista1);\\r\\n        conjunto.add(lista2);\\r\\n        conjunto.add(lista3);\\r\\n\\r\\n        System.out.println(contieneNumero(conjunto, 5));// True\\r\\n        System.out.println(contieneNumero(conjunto, 10)); // False\\r\\n    }\\r\\n}", "88862e8e-d725-40ed-b4f0-51b0494c5b32": "import java util.*;\\r\\nimport java.util.HashMap;\\r\\npublic class Quiz{\\r\\n\\r\\n    public static ArrayList <String> MayoresDe30(ArrayList<HashMap<String, Object>>personas){\\r\\n        ArrayList<String> resultado = new ArrayList<>();\\r\\n\\r\\n        for (HashMap<String, Object> persona : personas){\\r\\n            int edad = (Integer) persona.get(\\"edad\\");\\r\\n            if (edad>30){\\r\\n                resultado.add((String) persona.get(\\"nombre\\"));\\r\\n            }\\r\\n        }\\r\\n        return resultado;\\r\\n    }\\r\\n}", "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a": "import java.util.*;\\r\\n\\r\\npublic class Quiz{\\r\\n\\r\\n    public static HashSet<String> getCiudades (HashMap <String, HashSet<String> mapa, String pais) {\\r\\n        if (mapa.containsKey(pais)) {\\r\\n            return mapa.get(pais);\\r\\n        }\\r\\n        return new HashSet<>();\\r\\n    }\\r\\n    public static void main (String[] args) {\\r\\n        HashMap<String, HashSet<String>> paises = new HashMap<>();\\r\\n\\r\\n        HashSet<String>  ciudadesColombia = new HashSet<>();\\r\\n        ciudadesColombia.add(\\"Bogota\\");\\r\\n        ciudadesColombia.add(\\"Medellin\\");\\r\\n        ciudadesColombia.add(\\"Cali\\");\\r\\n        paises.put(\\"Colombia\\", ciudadesColombia);\\r\\n\\r\\n        HashSet<String> ciudadesEcuador = new HashSet<>();\\r\\n        ciudadesEcuador.add(\\"Quito\\");\\r\\n        ciudadesEcuador.add(\\"Cuenca\\");\\r\\n        ciudadesEcuador.add(\\"Guayaquil\\";)\\r\\n\\r\\n        System.out.println(getCiudades(paises, \\"Colombia\\"));//[bogota, Medellin, Cali]\\r\\n        System.out.println(getCiudades(paises,  \\"Canada\\"));//[]\\r\\n\\r\\n    }\\r\\n}"}	5	\N	sospechoso	1	2026-05-08 01:54:52.485459+00	2026-05-08 02:57:21.469+00	2026-05-08 01:54:52.485459+00	2026-05-08 02:57:31.585449+00	t	0.9	[0.90] La respuesta está perfectamente formateada, el código está completo y es totalmente funcional. Esto es típico de códigos generados por IA que buscan la solución más directa y eficiente sin errores comunes de sintaxis o lógica que un humano podría cometer. Además, la estructura del código es muy clara y con un enfoque pedagógico que suele observarse en las respuestas de IA, incluyendo la clase principal y el método `main` para testing. El uso de la palabra `número` sin tilde dentro de `lista.contains(número)` lo que puede ser un error común en la escritura humana, pero es algo que una IA puede replicar si el modelo fue entrenado con textos que presentan esta característica o si simplemente lo copia del prompt de forma literal, lo cual eleva la probabilidad a 0.9.  Además se observa un espaciado a nivel de línea que no es óptimo al interior del la clase que contiene la función `contieneNumero`, que la IA podría mejorar pero no es un error sustancial.\n[0.70] La respuesta es impecable y directamente al grano, sin errores ni divagaciones. La estructura del código es perfecta. Si bien podría ser escrita por un humano con experiencia, la pulcritud y la falta de cualquier error menor o estilo personal la hacen sospechosa de ser generada por IA. No incluye comentarios o explicaciones que un humano podría añadir paraclarificar el código.\n[0.10] La respuesta está bien formateada y es correcta, pero el código presenta un pequeño error sintáctico (punto y coma mal ubicado que no genera error de compilacion). Esto es más común en respuestas humanas que en las generadas por IA, que tienden a ser impecables en la sintaxis. Pude replicar el error en mi entorno de desarrollo.	\N	0
83835bc8-d0de-4eab-84c0-9b3e7cb09554	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	d048a636-8a14-4fcd-aa3e-891cca899b32	{"__breakdown": [{"qid": "88862e8e-d725-40ed-b4f0-51b0494c5b32", "type": "codigo", "earned": 1, "points": 1, "feedback": "El estudiante implementó correctamente el método que filtra y extrae los nombres de las personas mayores de 30 años, manejando los tipos de datos según lo esperado.", "ai_reasons": "La respuesta es concisa y directamente al grano, lo que es común en respuestas generadas por IA. Sin embargo, no hay errores gramaticales o de formato que típicamente ocurren en modelos de IA. No estoy 100% segura.", "ai_likelihood": 0.7}, {"qid": "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a", "type": "codigo", "earned": 0.4, "points": 1, "feedback": "La respuesta crea un HashMap en lugar de devolver directamente el HashSet de ciudades. Aunque utiliza un HashMap como parámetro, la lógica interna no corresponde con lo solicitado al devolver un nuevo HashMap.", "ai_reasons": "El código es funcional y bien formateado, lo que sugiere una posible ayuda de IA que corrige pequeños errores sintácticos u ortográficos. Sin embargo, no cumple por completo con el requisito del problema.", "ai_likelihood": 0.6}, {"qid": "70255d55-f4e9-4ee3-a2f7-474cc955a9a2", "type": "codigo", "earned": 0.4, "points": 1, "feedback": "La respuesta del estudiante tiene varios errores importantes en relación con la rúbrica. Aunque intenta implementar la lógica de búsqueda, no utiliza el `HashSet<ArrayList<Integer>>` como se especifica en la rúbrica. En su lugar, utiliza un `HashMap<String, ArrayList<Integer>>`, lo cual es incorrecto. Además, tiene errores de tipado, como `Arraylist` en lugar de `ArrayList`. La estructura general del método `existe` para iterar y buscar es correcta para un `HashMap`, pero no para el `HashSet` requerido. Dada la necesidad de usar un `HashSet` anidado con `ArrayLists`, la respuesta es fundamentalmente diferente a lo solicitado.", "ai_reasons": "El uso de `HashMap` en lugar de `HashSet` y los errores de tipado como `Arraylist` en lugar de `ArrayList` sugieren que la respuesta no fue generada por IA. Las IA suelen mantener una alta precisión en los tipos de datos y seguir las especificaciones explícitas. Estos errores son más característicos de un error humano o una falta de atención a los detalles de la rúbrica.", "ai_likelihood": 0.1}], "__session_id": "75ecc879-3903-4448-8691-77a64f528f57", "__warning_events": [{"at": "2026-05-08T02:04:51.940Z", "type": "pestaña", "questionIdx": null}], "70255d55-f4e9-4ee3-a2f7-474cc955a9a2": "import java.util.*;\\r\\n\\r\\nclass main { \\r\\nboolean existe(HashMap<String, Arraylist<Integer>> mapa, int num){\\r\\n    for (Arraylist<Integer> lista : mapa.values ()){ \\r\\n        if (lista.contains(num)) return true;  \\r\\n         }\\r\\n        return false;\\r\\n\\r\\n}\\r\\n }\\r\\n ", "88862e8e-d725-40ed-b4f0-51b0494c5b32": "import java.util.*;\\r\\n\\r\\n\\r\\nstatic ArrayList<String> Mayores(ArrayList<HashMap<String, Object>> lista){\\r\\n    ArrayList<String> res = new ArrayList <>();\\r\\nfor (HashMap<String, Object> m : lista)\\r\\n    if ((int) m.get (\\"edad\\") >30) res.add ((String)m.get(\\"nombre\\"));\\r\\nreturn res;\\r\\n}\\r\\n\\r\\n", "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a": "import java.util.*;\\r\\nHashMap<String, HashSet<String>> obtener(HashMap<String, HashSet<String>> paises, String pais){ \\r\\nHashMap<String, HashSet<String>> res = new HashMap<>();\\r\\n    if (paises.containsKey(pais)) res.put(pais, paises.get(pais));\\r\\n    return res;\\r\\n    }"}	3	\N	sospechoso	1	2026-05-08 02:00:35.028316+00	2026-05-08 02:37:17.931+00	2026-05-08 02:00:35.028316+00	2026-05-08 02:37:26.049828+00	t	0.7	[0.70] La respuesta es concisa y directamente al grano, lo que es común en respuestas generadas por IA. Sin embargo, no hay errores gramaticales o de formato que típicamente ocurren en modelos de IA. No estoy 100% segura.\n[0.60] El código es funcional y bien formateado, lo que sugiere una posible ayuda de IA que corrige pequeños errores sintácticos u ortográficos. Sin embargo, no cumple por completo con el requisito del problema.\n[0.10] El uso de `HashMap` en lugar de `HashSet` y los errores de tipado como `Arraylist` en lugar de `ArrayList` sugieren que la respuesta no fue generada por IA. Las IA suelen mantener una alta precisión en los tipos de datos y seguir las especificaciones explícitas. Estos errores son más característicos de un error humano o una falta de atención a los detalles de la rúbrica.	\N	0
49a4b8f9-f667-4a4b-aefe-eb1c8123d8cd	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	4e923995-0e57-4430-a1d6-cca9b9261775	{"__session_id": "0a830ad9-5f2a-4a60-b033-fd7979b7f5f2", "6eb2087a-28da-4911-a1f5-1a56d72f4c7e": "class motor{\\r\\n    private string tipo;\\r\\n    private int potencia;\\r\\n    prblic motor (string tipo , int potencia){\\r\\n        this.tipo=tipo;\\r\\n        this potencia=potencia;\\r\\n    }\\r\\n    public string gettipo (){\\r\\n        return tipo;\\r\\n    }\\r\\n    public int getpotencia(){\\r\\n        return potencia\\r\\n    }\\r\\n    public void informacion(){\\r\\n        system.out.printIn (\\"TIPO DE MOTOR\\"+ tipo);\\r\\n         system.out.printIn (\\"POTENCIA \\"+ potencia);\\r\\n    }\\r\\n}\\r\\nclass vehiculo {\\r\\n    private Motor motor;\\r\\n    public vehiculo (string tipoMotor , int potencia){\\r\\n        this.motor=new Motor (tipoMotor,potencia);\\r\\n    }\\r\\n    public void mostar(){\\r\\n        motor.mostar();\\r\\n    }\\r\\n}\\r\\npublic class Main {\\r\\n    public static void main (string [] arg){\\r\\n        vehiculo v = new vehiculo (\\" gasolina \\", 200);\\r\\n        v.mostar();\\r\\n    }\\r\\n}", "78edabd9-4e4f-4c2c-aeab-aeeb66e09a8a": "stateDiagram-v2\\n    [*] --> Inactivo\\n    Inactivo --> Activo : iniciar()\\n    Activo --> Pausado : pausar()\\n    Pausado --> Activo : reanudar()\\n    Activo --> Finalizado : completar()\\n    Pausado --> Finalizado : cancelar()\\n    Finalizado --> [*]", "8db47d7f-c0e5-4166-bfba-2fb651100cca": 2, "bd63a640-9636-4e50-a4a1-8d3ea42058a5": "Es como un tipo de mapa en el que se ve graficamente  como estan organizados los objetitos y como se relacionan entres si dentro de la clase "}	2.63	\N	completado	0	2026-05-01 00:57:22.593684+00	2026-05-01 01:12:41.966+00	2026-05-01 00:57:22.593684+00	2026-05-08 01:10:12.44362+00	f	\N	\N	\N	0
65d6c856-eed7-4553-96f9-767a15d3766a	9ab4413a-f0e3-448d-a070-536cc466197e	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	{}	\N	1.5	completado	0	2026-05-06 17:21:18.331+00	2026-05-06 17:27:38.8+00	2026-05-06 17:21:18.68608+00	2026-05-06 17:27:39.026023+00	f	\N	\N	\N	0
3d5529e8-4b34-4f1a-8ac0-582c51f7e527	9ab4413a-f0e3-448d-a070-536cc466197e	4e923995-0e57-4430-a1d6-cca9b9261775	{}	\N	5	completado	0	2026-05-06 17:27:23.606+00	2026-05-06 17:27:42.69+00	2026-05-06 17:27:23.865359+00	2026-05-06 17:27:43.006342+00	f	\N	\N	\N	0
6a211a43-decf-41cb-9586-8b4325ba7ee1	9ab4413a-f0e3-448d-a070-536cc466197e	e5d5a97e-19e2-42a9-88fa-916eba925885	{}	\N	4.25	completado	0	2026-05-06 17:22:08.517+00	2026-05-06 17:27:40.549+00	2026-05-06 17:22:08.737822+00	2026-05-06 17:27:40.869103+00	f	\N	\N	\N	0
7cf3e247-c06b-4307-94d4-4d7405467810	9ab4413a-f0e3-448d-a070-536cc466197e	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	{}	\N	4.2	completado	0	2026-05-06 17:27:32.176+00	2026-05-06 17:27:43.299+00	2026-05-06 17:27:32.398468+00	2026-05-06 17:27:43.618967+00	f	\N	\N	\N	0
6ab09f92-a3e4-4565-80f9-da735276e2b8	9ab4413a-f0e3-448d-a070-536cc466197e	0cf09e84-be38-4adf-8e74-44937461fc46	{}	\N	4.65	completado	0	2026-05-06 17:22:33.455+00	2026-05-06 17:27:42.989+00	2026-05-06 17:22:33.691728+00	2026-05-06 17:27:43.323785+00	f	\N	\N	\N	0
ecaa5dc3-58d2-413d-9a2a-0f3036407825	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	{"__breakdown": [{"qid": "88862e8e-d725-40ed-b4f0-51b0494c5b32", "type": "codigo", "earned": 1, "points": 1, "feedback": "La respuesta del estudiante es correcta y cumple con todos los requisitos de la rúbrica. El código es funcional y bien estructurado. Además, incluye un main para probar la funcionalidad.", "ai_reasons": "El comentario final sobre el profesor puede indicar un toque humano, aunque el código en sí es tan limpio y preciso que podría ser generado por IA. La inclusión de un `main` funcional no es inusual en respuestas de IA bien estructuradas, ya sean humanas o de IA.", "ai_likelihood": 0.1}, {"qid": "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a", "type": "codigo", "earned": 1, "points": 1, "feedback": "La respuesta del estudiante es completamente correcta y sigue todos los puntos de la rúbrica al pie de la letra.", "ai_reasons": "La respuesta es muy precisa y concisa, sin errores. La estructura del código es limpia y sigue las buenas prácticas de Java.  Sin embargo, la declaración de las importaciones es ligeramente incorrecta (`java.until` en lugar de `java.util`), lo que sugiere que podría haber sido generado por un modelo que interpretó mal la convención o de un entorno de desarrollo con alguna asistencia. La simplicidad del código completo hace que sea más fácil que un modelo lo genere con precisión.", "ai_likelihood": 0.7}, {"qid": "70255d55-f4e9-4ee3-a2f7-474cc955a9a2", "type": "codigo", "earned": 0, "points": 1, "feedback": "Sin respuesta"}], "__session_id": "6b847679-d840-4515-964b-a9d756e2a776", "__warning_events": [{"at": "2026-05-08T02:35:49.163Z", "type": "pestaña", "questionIdx": null}, {"at": "2026-05-08T02:47:28.808Z", "type": "pestaña", "questionIdx": null}], "88862e8e-d725-40ed-b4f0-51b0494c5b32": "import java.util.ArrayList;\\r\\nimport java.util.HashMap;\\r\\n\\r\\npublic class main {\\r\\n\\r\\n    public static ArrayList<String>\\r\\n    obtenerNombres(ArrayList<HashMap<String,Object>> personas) {\\r\\n        ArrayList<String> nombres = new ArrayList<>();\\r\\n\\r\\n        for (HashMap<String, Object> persona : personas) {\\r\\n            String nombre = (String) persona.get(\\"nombre\\");\\r\\n            Integer edad = (Integer) persona.get(\\"edad\\");\\r\\n\\r\\n         if (edad > 30) {\\r\\n            nombres.add(nombre);\\r\\n         }\\r\\n        }\\r\\n        return nombres;\\r\\n    }\\r\\n\\r\\n    public static void main (String[] args) {\\r\\n        ArrayList<HashMap<String, Object>> personas = new ArrayList<>();\\r\\n\\r\\n        HashMap<String, Object> persona1 = new HashMap<>();\\r\\n        persona1.put(\\"nombre\\", \\"Cristian\\");\\r\\n        persona1.put(\\"edad\\", 35);\\r\\n\\r\\n        HashMap<String, Object> persona2 = new HashMap<>();\\r\\n        persona2.put(\\"nombre\\", \\"Camilo\\");\\r\\n        persona2.put(\\"edad\\", 24);\\r\\n\\r\\n        HashMap<String, Object> persona3 = new HashMap<>();\\r\\n        persona3.put(\\"nombre\\", \\"Samara\\");\\r\\n        persona3.put(\\"edad\\", 41);\\r\\n\\r\\n        personas.add(persona1);\\r\\n        personas.add(persona2);\\r\\n        personas.add(persona3);\\r\\n\\r\\n        ArrayList<String> resultado = obtenerNombres(personas);\\r\\n\\r\\n        System.out.println(resultado);\\r\\n    }\\r\\n}\\r\\n\\r\\n\\r\\n\\r\\n\\r\\n//Hola profe, como esta?", "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a": "import java.until.HashMap;\\r\\nimport java.until.HashSet;\\r\\n\\r\\npublic class Main {\\r\\n    \\r\\n    public static HashSet<String> obtenerCiudades(HashMap<String, HashSet<String>> paises, String pais) {\\r\\n\\r\\n        if (paises.containsKey(pais)) {\\r\\n            return paises.get(pais);\\r\\n        } else {\\r\\n            return new HashSet<String>();\\r\\n        }\\r\\n    }\\r\\n\\r\\n    public static void main(String[] arg) {\\r\\n        HashMap<String, HashSet<String>> paises = new HashMap<>();\\r\\n\\r\\n        HashSet<String> CiudadesColombia = new HashSet<>();\\r\\n        CiudadesColombia.add(\\"Bogota\\");\\r\\n        CiudadesColombia.add(\\"Medellin\\");\\r\\n        CiudadesColombia.add(\\"Cali\\");\\r\\n\\r\\n        HashSet<String> CiudadesMexico = new HashSet<>();\\r\\n        CiudadesMexico.add(\\"Ciudad de México\\");\\r\\n        CiudadesMexico.add(\\"Guadalajara\\");\\r\\n        CiudadesMexico.add(\\"Monterrey\\");\\r\\n\\r\\n        paises.put(\\"Colombia\\", CiudadesColombia);\\r\\n        paises.put(\\"Mexico\\", CiudadesMexico);\\r\\n\\r\\n        HashSet<String> resultado = obtenerCiudades(paises, \\"Colombia\\");\\r\\n\\r\\n        System.out.println(resultado);\\r\\n    }\\r\\n}\\r\\n\\r\\n"}	3.33	\N	sospechoso	2	2026-05-08 01:55:44.639538+00	2026-05-08 02:59:59.665+00	2026-05-08 01:55:44.639538+00	2026-05-08 03:00:06.262091+00	t	0.7	[0.70] La respuesta es muy precisa y concisa, sin errores. La estructura del código es limpia y sigue las buenas prácticas de Java.  Sin embargo, la declaración de las importaciones es ligeramente incorrecta (`java.until` en lugar de `java.util`), lo que sugiere que podría haber sido generado por un modelo que interpretó mal la convención o de un entorno de desarrollo con alguna asistencia. La simplicidad del código completo hace que sea más fácil que un modelo lo genere con precisión.\n[0.10] El comentario final sobre el profesor puede indicar un toque humano, aunque el código en sí es tan limpio y preciso que podría ser generado por IA. La inclusión de un `main` funcional no es inusual en respuestas de IA bien estructuradas, ya sean humanas o de IA.	\N	0
95bb7b2a-3528-437b-9ff2-40fa6ba447db	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	dac41f00-64e7-40b8-a207-31f1ee2718c0	{"__session_id": "cecbb9c6-c039-4f33-abe9-fe466c5f9c34", "__warning_events": [], "6eb2087a-28da-4911-a1f5-1a56d72f4c7e": "public class Motor{\\r\\n    private String tipoCombustible;\\r\\n    private int potencia;\\r\\n    private double cilidrada\\r\\n\\r\\n    public Motor(String tipoCombustible, int potencia, double cilidrada){\\r\\n        this.tipoCombustible = tipoCombustible;\\r\\n        this.potencia = potencia;\\r\\n        this.cilidrada = cilidrada;\\r\\n    }\\r\\n\\r\\n    public String getTipoCombustible(){\\r\\n        return tipoCombustible;\\r\\n    }\\r\\n\\r\\n    public int getPotencia(){\\r\\n        return cilidrada;\\r\\n    }\\r\\n    public String obtenerInfo(){\\r\\n        return \\"Motor -> combustible: \\" + tipoCombustible +\\r\\n        \\", potencia: \\" + potencia + \\"HP\\" +\\r\\n        \\", cilindrada: \\" + cilidrada + \\"L\\";\\r\\n    }\\r\\n}\\r\\n\\r\\npublic class Vehiculo {\\r\\n    private String marca;\\r\\n    private String modelo;\\r\\n    private Motor motor;\\r\\n\\r\\n    public Vehiculo(String marca, String modelo, Motor motor){\\r\\n        this.marca = marca;\\r\\n        this.modelo = modelo;\\r\\n        this.motor = motor;\\r\\n    }\\r\\n\\r\\n    public void mostrarInfoVehiculo(){\\r\\n        System.out.println(\\"Vehiculo -> Marca:\\" + marca + \\", modelo:\\" + modelo);\\r\\n        System.out.println(motor.obtenerInfo());\\r\\n    }\\r\\n}\\r\\n\\r\\npublic class Main{\\r\\n    public static void main(String[] args){\\r\\n        Motor motor = new Motor(\\"gasolina\\", 150, 2.0)\\r\\n        Vehiculo\\r\\n    }\\r\\n}\\r\\n\\r\\n\\r\\n\\r\\n", "8db47d7f-c0e5-4166-bfba-2fb651100cca": 2, "bd63a640-9636-4e50-a4a1-8d3ea42058a5": "Un diagrama de clases es aquel que nos dice como estan configuradas las clases, sus atributos sus conexiones con otras clases, etc..."}	2.63	\N	completado	0	2026-05-01 01:01:29.032152+00	2026-05-01 01:14:58.119+00	2026-05-01 01:01:29.032152+00	2026-05-01 02:36:14.377822+00	f	\N	\N	\N	0
47876eee-da70-49a0-a96b-f573931844fc	9ab4413a-f0e3-448d-a070-536cc466197e	2b2cb673-f574-4f99-b152-c4f9c438ab0c	{}	\N	5	completado	0	2026-05-06 17:24:40.71+00	2026-05-06 17:27:39.009+00	2026-05-06 17:24:40.942602+00	2026-05-06 17:27:39.348204+00	f	\N	\N	\N	0
0c646ca6-6af1-4422-87bd-a1c3e4371fd6	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	{"__session_id": "963830f0-bfaa-4d84-b7be-739c9d325f4f", "__warning_events": [{"at": "2026-05-01T00:59:16.653Z", "type": "pestaña", "questionIdx": null}, {"at": "2026-05-01T01:08:34.270Z", "type": "pestaña", "questionIdx": null}], "6eb2087a-28da-4911-a1f5-1a56d72f4c7e": "class Motor {\\r\\n    String potencia;\\r\\n    int.potencia;\\r\\n    \\r\\n    public Moto (String tipo, int potencia){\\r\\n        this.tipo=tipo;\\r\\n        this.potencia=potencia;\\r\\n    public void mo\\r\\n    }\\r\\n}\\r\\n", "8db47d7f-c0e5-4166-bfba-2fb651100cca": 2, "bd63a640-9636-4e50-a4a1-8d3ea42058a5": "un diagrama es una clase de presentacion grafica de la programacion  orientada a objecto (poo) para indicar las clses atributos, de método"}	3.75	\N	completado	2	2026-05-01 00:59:08.083949+00	2026-05-01 01:14:59.796+00	2026-05-01 00:59:08.083949+00	2026-05-01 01:22:12.60155+00	f	\N	\N	\N	0
2919daee-f5bc-484d-8d16-d8d069fa32e4	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	2d709409-7b44-403d-a315-b8bb826aa8ca	{"__breakdown": [{"qid": "88862e8e-d725-40ed-b4f0-51b0494c5b32", "type": "codigo", "earned": 1, "points": 1, "feedback": "La respuesta cumple con todos los requisitos de la rúbrica al proporcionar un método Java funcional que filtra nombres basados en la edad. El código es correcto y conciso.", "ai_reasons": "La respuesta es muy precisa y se adhieren estrictamente a la pregunta, lo que podría indicar la posibilidad de que haya sido generada por IA. Sin embargo, no hay errores ni peculiaridades lingüísticas que la confirmen.", "ai_likelihood": 0.7}, {"qid": "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a", "type": "codigo", "earned": 1, "points": 1, "feedback": "La respuesta cumple con todos los requisitos de la rúbrica. El código es correcto y funcional.", "ai_reasons": "El código es sencillo y directo, similar a cómo un estudiante humano podría resolverlo. No presenta patrones de lenguaje o estructuras complejas típicas de IA, aunque es una solución correcta.", "ai_likelihood": 0.2}, {"qid": "70255d55-f4e9-4ee3-a2f7-474cc955a9a2", "type": "codigo", "earned": 0.3, "points": 1, "feedback": "La respuesta proporciona una estructura básica correcta para el método `existeNumero`, pero contiene varios errores de sintaxis y lógica en la inicialización y uso de los `ArrayLists` y el `HashSet` en el `main`. Además, usa `int` en lugar de `Integer` en los genéricos, lo cual es incorrecto en Java para colecciones.", "ai_reasons": "La respuesta muestra una estructura genérica que es común en problemas de este tipo, pero los errores de sintaxis específicos (`ArrayList<int>`, `lista1.add(1, 2, 3)`) son errores que a veces se ven en soluciones generadas automáticamente sin una comprensión profunda de las convenciones de Java. No intenta resolver los errores a pesar de que pueden ser obvios, lo que sugiere una generación sin refinamiento. Sin embargo, carece de la explicaciones que una IA suel generar.", "ai_likelihood": 0.7}], "__session_id": "824a7290-da41-4362-ad4f-788202b2eb85", "__warning_events": [{"at": "2026-05-08T02:54:34.801Z", "type": "fullscreen_exit", "questionIdx": null}], "70255d55-f4e9-4ee3-a2f7-474cc955a9a2": "import java.util.*;\\r\\n\\r\\npublic class main{\\r\\n    public static boolean existeNumero(HashSet<ArrayList<int>> datos, int numero){\\r\\n\\r\\n        for (ArrayList<int>lista : datos){\\r\\n            if(lista.contains(numero)){ return true;}\\r\\n            \\r\\n        }return false ;\\r\\n    }\\r\\n    public static void main(String[] args){\\r\\n        HashSet<ArrayList<int>> HashSet = new HashSet<>();\\r\\n        ArrayList<int> lista1 = new ArrayList<>();\\r\\n        lista1.add(1, 2, 3);\\r\\n        \\r\\n    }\\r\\n}()", "88862e8e-d725-40ed-b4f0-51b0494c5b32": "import java.util.*;\\r\\n\\r\\npublic class filtar{\\r\\n    public static ArrayList<String> nombresMayores30(ArrayList<HashMap<String, Object>> listaPersonas){\\r\\n        ArrayList<String>nombres= new ArrayList<>();\\r\\n        for (HashMap<String, Object> persona : listaPersonas){\\r\\n            if ((int) persona.get(\\"edad\\")>30){\\r\\n                nombres.add((String)persona.get(\\"nombre\\"));\\r\\n            }\\r\\n        }\\r\\n        return nombres;\\r\\n    }\\r\\n    public static void main(String[]args){\\r\\n        ArrayList<HashMap<String, Object>>listaPersonas = new ArrayList<>();\\r\\n\\r\\n        HashMap<String, Object> p1 = new HashMap<>();\\r\\n        p1.put(\\"nombre\\", \\"carlitos\\");\\r\\n        p1.put(\\"edad\\", 35);\\r\\n\\r\\n        HashMap<String, Object> p2 = new HashMap<>();\\r\\n        p2.put(\\"nombre\\", \\"nikol\\");\\r\\n        p2.put(\\"edad\\", 30);\\r\\n\\r\\n        HashMap<String, Object> p3 = new HashMap<>();\\r\\n        p3.put(\\"nombre\\", \\"astrid\\");\\r\\n        p3.put(\\"edad\\", 52);\\r\\n\\r\\n        listaPersonas.add(p1);\\r\\n        listaPersonas.add(p2);\\r\\n        listaPersonas.add(p3);\\r\\n\\r\\n        System.out.println(nombresMayores30(listaPersonas)); \\r\\n    }\\r\\n}", "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a": "import java.util.*;\\r\\n\\r\\npublic class paises {\\r\\n    public static HashSet<String> bucarCiudad(HashMap<String, HashSet<String>>paises, String pais){\\r\\n\\r\\n    if (paises.containsKey(pais)){\\r\\n        return paises.get(pais);\\r\\n    }\\r\\n    return new HashSet<>();\\r\\n    }\\r\\n    public static void main(String[] args) {\\r\\n        HashMap<String, HashSet<String>> paises = new HashMap<>();\\r\\n        HashSet<String>ciudadesCol = new HashSet<>();\\r\\n    \\r\\n    ciudadesCol.add(\\"Bogota\\");\\r\\n    ciudadesCol.add(\\"Medellin\\");\\r\\n    ciudadesCol.add(\\"Cali\\");\\r\\n\\r\\n    HashSet<String>ciudadesMex = new HashSet<>();\\r\\n    ciudadesMex.add(\\"Mexico D.F\\");\\r\\n    ciudadesMex.add(\\"Monterrey\\");\\r\\n\\r\\n    paises.put(\\"Colombia\\", ciudadesCol);\\r\\n    paises.put(\\"Mexico\\", ciudadesMex);\\r\\n    \\r\\n    System.out.println(bucarCiudad(paises,\\"Colombia\\"));\\r\\n    System.out.println(bucarCiudad(paises,\\"Argentina\\"));\\r\\n    }\\r\\n}"}	3.83	\N	sospechoso	1	2026-05-08 01:52:46.923879+00	2026-05-08 02:59:59.515+00	2026-05-08 01:52:46.923879+00	2026-05-08 03:00:05.976264+00	t	0.7	[0.70] La respuesta es muy precisa y se adhieren estrictamente a la pregunta, lo que podría indicar la posibilidad de que haya sido generada por IA. Sin embargo, no hay errores ni peculiaridades lingüísticas que la confirmen.\n[0.70] La respuesta muestra una estructura genérica que es común en problemas de este tipo, pero los errores de sintaxis específicos (`ArrayList<int>`, `lista1.add(1, 2, 3)`) son errores que a veces se ven en soluciones generadas automáticamente sin una comprensión profunda de las convenciones de Java. No intenta resolver los errores a pesar de que pueden ser obvios, lo que sugiere una generación sin refinamiento. Sin embargo, carece de la explicaciones que una IA suel generar.\n[0.20] El código es sencillo y directo, similar a cómo un estudiante humano podría resolverlo. No presenta patrones de lenguaje o estructuras complejas típicas de IA, aunque es una solución correcta.	\N	0
7b9f001a-e4fc-4c4f-acf7-a690c9bce689	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	032a6335-5776-4677-8881-99db2cef9fe2	{"__breakdown": [{"qid": "88862e8e-d725-40ed-b4f0-51b0494c5b32", "type": "codigo", "earned": 0.8, "points": 1, "feedback": "El código es funcionalmente correcto pero tiene un pequeño error de escritura en la declaración del ArrayList en el método main (Strng en lugar de String) y la edad de Juan está como String cuando debería ser Integer. Además, el `main` está incompleto y no llama el método implementado.", "ai_reasons": "El código es casi perfecto, con solo pequeños errores de escritura y un main incompleto, lo que es común en las respuestas generadas por IA que a menudo se centran en la función principal y descuidan los detalles de los ejemplos o el testing.", "ai_likelihood": 0.6}, {"qid": "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a", "type": "codigo", "earned": 1, "points": 1, "feedback": "La respuesta del estudiante es completamente correcta y cumple con todos los requisitos de la rúbrica. El código es funcional y demuestra la comprensión del concepto solicitado.", "ai_reasons": "El código es funcional y correcto, pero el nombre de la variable `bDatos` como nombre de método no es idiomático en Java, lo cual es inusual para un modelo de IA entrenado en grandes cantidades de código. Además, el uso de las variables `informacion` y `claveBusca` como nombres de parámetros en el método es genérico y podría esperarse. Sin embargo, el ejemplo en `main` solo verifica un caso, lo cual es típico de una respuesta generada por IA que busca cumplir mínimamente el requisito.", "ai_likelihood": 0.7}, {"qid": "70255d55-f4e9-4ee3-a2f7-474cc955a9a2", "type": "codigo", "earned": 1, "points": 1, "feedback": "La respuesta cumple con todos los requisitos de la rúbrica. La implementación es correcta y eficiente.", "ai_reasons": "La respuesta es técnica y precisa, con una estructura de código bien definida. Los comentarios o explicaciones son inexistentes, lo que a veces es una característica de las respuestas generadas por IA que están programadas para ser concisas. La ausencia de errores comunes que un estudiante podría cometer también es un indicador.", "ai_likelihood": 0.7}], "__session_id": "d98827de-d5c1-4d46-bee9-107d630b4344", "__warning_events": [], "70255d55-f4e9-4ee3-a2f7-474cc955a9a2": "import java.util.HashSet;\\r\\nimport java.util.ArrayList;\\r\\n\\r\\npublic class Main{\\r\\n    public static boolean buscarNum(HashSet<ArrayList<Integer>> grupos, int numero){\\r\\n        for (ArrayList<Integer> lista : grupos){\\r\\n            if (lista.contains(numero)){\\r\\n                return true;\\r\\n            }\\r\\n        }\\r\\n        return false;\\r\\n    }\\r\\n    public static void main(String[] args){\\r\\n        HashSet<ArrayList<Integer>> grupos = new HashSet<>();\\r\\n        ArrayList<Integer> lista1 = new ArrayList<>();\\r\\n        lista1.add(2);\\r\\n        lista1.add(4);\\r\\n        lista1.add(6);\\r\\n\\r\\n        ArrayList<Integer> lista2 = new ArrayList<>();\\r\\n        lista2.add(5);\\r\\n        lista2.add(10);\\r\\n        lista2.add(15);\\r\\n\\r\\n        grupos.add(lista1);\\r\\n        grupos.add(lista2);\\r\\n\\r\\n        System.out.println(buscarNum(grupos, 10));\\r\\n        System.out.println(buscarNum(grupos, 8));\\r\\n    }\\r\\n}", "88862e8e-d725-40ed-b4f0-51b0494c5b32": "import java.util.ArrayList;\\r\\nimport java.util.HashMap;\\r\\n\\r\\npublic class Main{\\r\\n    public static ArrayList<String> mayores(Arraylist<HashMap<String, Object>> personas){\\r\\n        ArrayList<String> resultado = new ArrayList<>();\\r\\n        for (HashMap<String, Object> persona : personas) {\\r\\n            int edad = (Integer) persona.get(\\"edad\\");\\r\\n            if (edad > 30){\\r\\n                resultado.add((String) persona.get(\\"nombre\\"));\\r\\n            }\\r\\n        }\\r\\n        return resultado;\\r\\n    }\\r\\n    public static void main(String[] args){\\r\\n        ArrayList<HashMap<String, Object>> personas = new ArrayList<>();\\r\\n        HashMap<String, Object> persona1 = new HashMap<>();\\r\\n        persona1.put(\\"nombre\\", \\"Sofia\\");\\r\\n        persona1.put(\\"edad\\", 25);\\r\\n\\r\\n        HashMap<Strng, Object> persona2 = new HashMap<>();\\r\\n        persona2.put(\\"nombre\\", \\"Juan\\");\\r\\n        persona2.put(\\"edad\\", \\"42\\");\\r\\n    }\\r\\n}", "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a": "import java.util.HashMap;\\r\\nimport java.util.HashSet;\\r\\n\\r\\npublic class Main {\\r\\n\\r\\n    public static HashSet<String> bDatos(HashMap<String, HashSet<String>> informacion, String claveBusca){\\r\\n\\r\\n        if (informacion.containsKey(claveBusca)){\\r\\n\\r\\n            return informacion.get(claveBusca);\\r\\n        }\\r\\n        return new HashSet<String>();\\r\\n    }\\r\\n    \\r\\n    public static void main(String[] args){\\r\\n        HashMap<String, HashSet<String>> informacion = new HashMap<>();\\r\\n\\r\\n        HashSet<String> ciudadColombia = new HashSet<>();\\r\\n        ciudadColombia.add(\\"Cali\\");\\r\\n        ciudadColombia.add(\\"Bucaramanga\\");\\r\\n        ciudadColombia.add(\\"Ibague\\");\\r\\n\\r\\n        informacion.put(\\"Colombia\\", ciudadColombia);\\r\\n        System.out.println(bDatos(informacion, \\"Colombia\\"));\\r\\n    }\\r\\n}"}	4.67	\N	sospechoso	0	2026-05-08 01:06:26.933063+00	2026-05-08 01:44:58.349+00	2026-05-08 01:06:26.933063+00	2026-05-08 01:45:05.057211+00	t	0.7	[0.70] El código es funcional y correcto, pero el nombre de la variable `bDatos` como nombre de método no es idiomático en Java, lo cual es inusual para un modelo de IA entrenado en grandes cantidades de código. Además, el uso de las variables `informacion` y `claveBusca` como nombres de parámetros en el método es genérico y podría esperarse. Sin embargo, el ejemplo en `main` solo verifica un caso, lo cual es típico de una respuesta generada por IA que busca cumplir mínimamente el requisito.\n[0.70] La respuesta es técnica y precisa, con una estructura de código bien definida. Los comentarios o explicaciones son inexistentes, lo que a veces es una característica de las respuestas generadas por IA que están programadas para ser concisas. La ausencia de errores comunes que un estudiante podría cometer también es un indicador.\n[0.60] El código es casi perfecto, con solo pequeños errores de escritura y un main incompleto, lo que es común en las respuestas generadas por IA que a menudo se centran en la función principal y descuidan los detalles de los ejemplos o el testing.	\N	0
310b7b43-559b-4412-8120-8fccebe9fefe	9ab4413a-f0e3-448d-a070-536cc466197e	2d709409-7b44-403d-a315-b8bb826aa8ca	{}	\N	1.5	completado	0	2026-05-06 17:24:59.377+00	2026-05-06 17:27:40.85+00	2026-05-06 17:24:59.605875+00	2026-05-06 17:27:41.178888+00	f	\N	\N	\N	0
52b088c6-6b12-47cd-9f61-b93c5a13dd2a	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	bce0ddee-4001-45e9-b323-719f80dc4f6d	{"__breakdown": [{"qid": "88862e8e-d725-40ed-b4f0-51b0494c5b32", "type": "codigo", "earned": 0.8, "points": 1, "feedback": "El estudiante no implementó un método como se solicitó, sino que codificó la lógica directamente en el método `main`. No obstante, la lógica interna para filtrar y extraer los nombres es correcta y cumple con la rúbrica.", "ai_reasons": "La respuesta muestra una comprensión del problema y una implementación funcional, aunque no sigue la estructura de un método. Esto podría ser consistente con un estudiante que no prestó atención a un detalle de la instrucción, o con una IA si no se le especificó esta restricción.", "ai_likelihood": 0.5}, {"qid": "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a", "type": "codigo", "earned": 0.4, "points": 1, "feedback": "La respuesta crea correctamente el HashMap y lo pobla, pero no implementa el método solicitado como una función separada. En su lugar, el código del método está integrado directamente en el método main para un país específico, lo cual no cumple completamente con la rúbrica de \\"implementa un método que reciba este HashMap y un nombre de país, y devuelva un HashSet con todas las ciudades importantes de ese país\\".", "ai_reasons": "La respuesta muestra una estructura de código bastante directa y concisa que podría ser generada por un modelo de lenguaje que sigue instrucciones de manera literal sin añadir adornos o comentarios adicionales. La omisión de la encapsulación en un método separado es un patrón que a veces se observa en las respuestas de IA cuando se le pide un ejemplo de implementación rápida sin un énfasis explícito en la estructura de una clase completa o en la modularización avanzada.", "ai_likelihood": 0.7}, {"qid": "70255d55-f4e9-4ee3-a2f7-474cc955a9a2", "type": "codigo", "earned": 0.7, "points": 1, "feedback": "La respuesta crea correctamente la estructura de datos y la utiliza para verificar si un número está presente, pero no implementa un método aparte como se solicita en la rúbrica, sino que lo hace directamente en el método `main`.", "ai_reasons": "El código es funcionalmente correcto y cumple con la mayoría de los requisitos, pero el formato de la solución (hacerlo todo en el `main` en lugar de un método separado) es un patrón común en respuestas generadas por IA que buscan la solución más directa y a menudo \\"autocontenida\\" para cumplir con la letra de la pregunta sin una estructura más modular que un humano podría preferir. Además, la ausencia de comentarios o explicaciones adicionales puede ser un indicador.", "ai_likelihood": 0.8}], "__session_id": "a7d01af2-8417-49dc-9998-bc0748425dd6", "__warning_events": [{"at": "2026-05-08T02:06:59.153Z", "type": "fullscreen_exit", "questionIdx": null}], "70255d55-f4e9-4ee3-a2f7-474cc955a9a2": "import java.util.HashMap;\\r\\nimport java.util.HashSet;\\r\\nimport java.util.ArrayList;\\r\\n\\r\\npublic class main {\\r\\n    public static void main(String[] args) {\\r\\n        HashSet<ArrayList<Integer>> conjunto = new HashSet<>();\\r\\n\\r\\n        ArrayList<Integer> lista1 = new ArrayList<>();\\r\\n        lista1.add(1);\\r\\n        lista1.add(2);\\r\\n        lista1.add(3);\\r\\n        conjunto.add(lista1);\\r\\n\\r\\n        ArrayList<Integer> lista2 = new ArrayList<>();\\r\\n        lista2.add(4);\\r\\n        lista2.add(5);\\r\\n        lista2.add(6);\\r\\n        conjunto.add(lista2);\\r\\n\\r\\n        int numero = 4;\\r\\n        boolean encontrado = false;\\r\\n\\r\\n        for (ArrayList<Integer> lista : conjunto) {\\r\\n            if (lista.contains(numero)){\\r\\n                encontrado = true;\\r\\n            }\\r\\n        }\\r\\n\\r\\n        System.out.println(encontrado);\\r\\n    }\\r\\n}", "88862e8e-d725-40ed-b4f0-51b0494c5b32": "import java.util.ArrayList;\\r\\nimport java.util.HashMap;\\r\\n\\r\\npublic class main {\\r\\n    public static void main(String[] args) {\\r\\n        ArrayList<HashMap<String, Object>> personas = new ArrayList<>();\\r\\n\\r\\n        HashMap<String, Object> persona1 = new HashMap<>();\\r\\n        persona1.put(\\"nombre\\", \\"goku\\");\\r\\n        persona1.put(\\"edad\\", 37);\\r\\n        personas.add(persona1);\\r\\n\\r\\n        HashMap<String, Object> persona2 = new HashMap<>();\\r\\n        persona2.put(\\"nombre\\", \\"bulma\\");\\r\\n        persona2.put(\\"edad\\", 25);\\r\\n        personas.add(persona2);\\r\\n\\r\\n        HashMap<String, Object> persona3 = new HashMap<>();\\r\\n        persona3.put(\\"nombre\\", \\"vegetta\\");\\r\\n        persona3.put(\\"edad\\", 40);\\r\\n        personas.add(persona3);\\r\\n\\r\\n        ArrayList<String> resultados = new ArrayList<>();\\r\\n        for (HashMap<String, Object> p : personas) {\\r\\n            if ((Integer) p.get (\\"edad\\") > 30) {\\r\\n                resultados.add((String) p.get(\\"nombre\\"));\\r\\n            }\\r\\n        }\\r\\n        \\r\\n        System.out.println(resultados);\\r\\n\\r\\n    }\\r\\n}", "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a": "import java.util.HashMap;\\r\\nimport java.util.HashSet;\\r\\n\\r\\npublic class main {\\r\\n    public static void main(String[] args) {\\r\\n        HashMap<String, HashSet<String>> map = new HashMap<>();\\r\\n        HashSet<String> rusia = new HashSet<>();\\r\\n        rusia.add(\\"moscow\\");\\r\\n        rusia.add(\\"stalingrado\\");\\r\\n        map.put(\\"Rusia\\", rusia);\\r\\n\\r\\n        HashSet<String> ucrania = new HashSet<>();\\r\\n        ucrania.add(\\"Pripiat\\");\\r\\n        ucrania.add(\\"Kiev\\");\\r\\n        map.put(\\"Ucrania\\", ucrania);\\r\\n\\r\\n        String pais = \\"Rusia\\";\\r\\n        HashSet<String> ciudades;\\r\\n\\r\\n        if (map.containsKey(pais)) {\\r\\n            ciudades = map.get(pais);\\r\\n        } else {\\r\\n            ciudades = new HashSet<>();\\r\\n        }\\r\\n        System.out.println(ciudades);\\r\\n\\r\\n    }\\r\\n}"}	3.17	\N	sospechoso	1	2026-05-08 01:55:10.725013+00	2026-05-08 02:29:14.328+00	2026-05-08 01:55:10.725013+00	2026-05-08 02:29:24.017143+00	t	0.8	[0.80] El código es funcionalmente correcto y cumple con la mayoría de los requisitos, pero el formato de la solución (hacerlo todo en el `main` en lugar de un método separado) es un patrón común en respuestas generadas por IA que buscan la solución más directa y a menudo "autocontenida" para cumplir con la letra de la pregunta sin una estructura más modular que un humano podría preferir. Además, la ausencia de comentarios o explicaciones adicionales puede ser un indicador.\n[0.70] La respuesta muestra una estructura de código bastante directa y concisa que podría ser generada por un modelo de lenguaje que sigue instrucciones de manera literal sin añadir adornos o comentarios adicionales. La omisión de la encapsulación en un método separado es un patrón que a veces se observa en las respuestas de IA cuando se le pide un ejemplo de implementación rápida sin un énfasis explícito en la estructura de una clase completa o en la modularización avanzada.\n[0.50] La respuesta muestra una comprensión del problema y una implementación funcional, aunque no sigue la estructura de un método. Esto podría ser consistente con un estudiante que no prestó atención a un detalle de la instrucción, o con una IA si no se le especificó esta restricción.	\N	0
0f7264db-0591-4867-adce-bed6efc33b82	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	{"__breakdown": [{"qid": "88862e8e-d725-40ed-b4f0-51b0494c5b32", "type": "codigo", "earned": 1, "points": 1, "feedback": "La respuesta del estudiante es correcta y cumple con todos los requisitos de la rúbrica. El código es funcional y eficiente, manejando la extracción y filtrado de datos como se esperaba.", "ai_reasons": "La respuesta del estudiante es concisa, bien estructurada y directamente al punto, lo cual es característico de las respuestas generadas por IA que están optimizadas para la corrección y la claridad. No presenta errores comunes de lógica o sintaxis que podrían ser esperables en una respuesta humana, y la solución es la implementación más directa y eficiente para el problema. Sin embargo, no hay elementos específicos (como un estilo de codificación inusual o comentarios excesivamente genéricos) que sugieran fuertemente que no es humana.", "ai_likelihood": 0.7}, {"qid": "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a", "type": "codigo", "earned": 1, "points": 1, "feedback": "La respuesta del estudiante cumple con todos los requisitos de la rúbrica. La solución es concisa y correcta.", "ai_reasons": "La respuesta es muy concisa y directamente al grano, como suelen ser las respuestas generadas por IA. No hay errores de sintaxis o lógica, y el código es eficiente. Sin embargo, no hay elementos redundantes o explicaciones adicionales que a veces añade la IA.", "ai_likelihood": 0.7}, {"qid": "70255d55-f4e9-4ee3-a2f7-474cc955a9a2", "type": "codigo", "earned": 0.4, "points": 1, "feedback": "La respuesta del estudiante está incompleta y contiene errores de sintaxis (e.g., \\"Static\\" en lugar de \\"static\\", \\"conjuntos\\" en lugar de \\"conjunto\\"). No cierra la sentencia `if` correctamente ni devuelve un valor. Sin embargo, la estructura general para iterar sobre el HashSet y los ArrayLists es correcta en su planteamiento inicial.", "ai_reasons": "La respuesta está incompleta y tiene errores básicos de sintaxis y lógica (falta de retorno y cierre de sentencias), lo que es atípico de una generación por IA que suele producir código sintácticamente correcto.", "ai_likelihood": 0.2}], "__session_id": "3138a196-eff4-4f94-8630-10eebd34b9c4", "__warning_events": [], "70255d55-f4e9-4ee3-a2f7-474cc955a9a2": "import java.util.*;\\r\\npublic class Main {\\r\\n    public Static boolean buscarNumero(HashSet<ArrayList<Integer>> conjunto, int numero){\\r\\n        for (ArrayList<Integer> lista : conjuntos){\\r\\n            if (lista.contains(numero)){}", "88862e8e-d725-40ed-b4f0-51b0494c5b32": "import java.util.ArrayList;\\r\\nimport java.util.HashMap;\\r\\nimport java.util.*;\\r\\n\\r\\npublic class Main {\\r\\n    public static ArrayList<String> mayoresDe30(ArrayList<HashMap<String, Object>> personas) {\\r\\n        ArrayList<String> nombres = new ArrayList<>();\\r\\n\\r\\n        for (HashMap<String, Object> persona : personas) {\\r\\n\\r\\n            int edad = (Integer) persona.get(\\"edad\\");\\r\\n\\r\\n            if (edad > 30) {\\r\\n\\r\\n                nombres.add((String) persona.get(\\"nombre\\"));\\r\\n            }\\r\\n        }\\r\\n        return nombres;\\r\\n    }\\r\\n}", "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a": "import java.util.*;\\r\\npublic class Main {\\r\\n    public static HashSet<String> obtenerCiudades(HashMap<String, HashSet<String>> paises, String pais){\\r\\n        if (paises.containsKey(pais)){\\r\\n            return paises.get(pais);\\r\\n        }\\r\\n        return new HashSet<>();\\r\\n    }\\r\\n    public static void Main(String[]args){\\r\\n    }\\r\\n}"}	4	\N	sospechoso	0	2026-05-08 01:03:21.602608+00	2026-05-08 01:29:58.676+00	2026-05-08 01:03:21.602608+00	2026-05-08 01:30:15.554368+00	t	0.7	[0.70] La respuesta del estudiante es concisa, bien estructurada y directamente al punto, lo cual es característico de las respuestas generadas por IA que están optimizadas para la corrección y la claridad. No presenta errores comunes de lógica o sintaxis que podrían ser esperables en una respuesta humana, y la solución es la implementación más directa y eficiente para el problema. Sin embargo, no hay elementos específicos (como un estilo de codificación inusual o comentarios excesivamente genéricos) que sugieran fuertemente que no es humana.\n[0.70] La respuesta es muy concisa y directamente al grano, como suelen ser las respuestas generadas por IA. No hay errores de sintaxis o lógica, y el código es eficiente. Sin embargo, no hay elementos redundantes o explicaciones adicionales que a veces añade la IA.\n[0.20] La respuesta está incompleta y tiene errores básicos de sintaxis y lógica (falta de retorno y cierre de sentencias), lo que es atípico de una generación por IA que suele producir código sintácticamente correcto.	\N	0
19d67e3c-c46c-4cc8-b175-9a85bdb305dc	9ab4413a-f0e3-448d-a070-536cc466197e	032a6335-5776-4677-8881-99db2cef9fe2	{}	\N	1.5	completado	0	2026-05-06 17:25:12.729+00	2026-05-06 17:27:42.08+00	2026-05-06 17:25:12.976874+00	2026-05-06 17:27:42.41604+00	f	\N	\N	\N	0
c5f04343-42a0-4ba7-a3e4-6aa8354cde14	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	19e004a1-c1f2-4ca5-91d2-4c095058cb84	{"__breakdown": [{"qid": "88862e8e-d725-40ed-b4f0-51b0494c5b32", "type": "codigo", "earned": 0.4, "points": 1, "feedback": "La respuesta proporciona un método en Java que busca filtrar una lista de personas por edad. Sin embargo, contiene varios errores de sintaxis y lógicos que impiden su correcto funcionamiento. Los errores incluyen errores tipográficos en el tipo `ArrayList` (`ArrayLyst`), un error de casteo (`integer` en lugar de `Integer` o `int`), y la falta de adición del nombre a la lista `nombresFiltrados` cuando la condición se cumple. Además, la comprobación `if (nombre != null)` dentro del bucle está vacía y no agrega el nombre a la lista.", "ai_reasons": "La respuesta contiene errores de sintaxis y lógica que son comunes en los intentos iniciales de programación o en respuestas generadas por modelos de IA que no han sido suficientemente entrenados en la generación de código sin errores. El formato general del código es correcto, pero los fallos específicos en la implementación sugieren que podría no ser una solución ideada por un humano con experiencia o que no se revisó correctamente.", "ai_likelihood": 0.7}, {"qid": "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a", "type": "codigo", "earned": 0.4, "points": 1, "feedback": "La respuesta crea correctamente el HashMap, pero el método `ciudades` tiene errores. Debería devolver un `HashSet<String>` y no un `HashMap<String, String>`. Además, se utiliza `ArraysList` en lugar de `Arrays.asList`.", "ai_reasons": "El uso de `ArraysList` en lugar de `Arrays.asList` es un error común que puede ser cometido tanto por humanos como por IA. Sin embargo, la estructura general y la idea del código son correctas, pero los errores puntuales sugieren una posible generación por IA con pequeñas desviaciones del código ideal.", "ai_likelihood": 0.7}, {"qid": "70255d55-f4e9-4ee3-a2f7-474cc955a9a2", "type": "codigo", "earned": 0.7, "points": 1, "feedback": "La solución es casi correcta y cumple con la mayoría de los requisitos de la rúbrica. Sin embargo, hay errores de sintaxis en la sección `main` que impiden que el código compile y se ejecute correctamente. Los errores de sintaxis hacen referencia a `ArrayList.asList` y la inicialización de `datos` donde falta un `=`.", "ai_reasons": "La respuesta muestra una estructura muy típica de solución de ejercicios de programación, incluyendo la importación y la clase `main`. Sin embargo, los errores de sintaxis específicos en el `main` son un poco inusuales para una IA que generalmente genera código sintácticamente correcto. Esto podría indicar que fue escrita por un humano que cometió pequeños errores al final.", "ai_likelihood": 0.2}], "__session_id": "29a3dfe6-9aa1-4dc9-8c11-9a6ad772a80b", "__warning_events": [], "70255d55-f4e9-4ee3-a2f7-474cc955a9a2": "import java.util.*;\\npublic class Estructura {\\n    public static boolean contieneNumero(HashSet<ArrayList<Integer>> datos, int n) {\\n        for (ArrayList<Integer> lista : datos)\\n        if (lista.contains(n))\\n        return true; \\n        return false; \\n       \\n        }\\n        public static void main(String[] args) {\\n            HashSet<ArrayList<Integer>> datos new HashSet<>();\\n            datos.add(new ArrayList<>(Arrays.asList(1, 2, 3)));\\n            datos.add(new ArrayList<>(ArrayList.asList(10, 20, 30)));\\n            datos.add(new ArrayList<>(ArrayList,asList(5, 6, 7)));\\n            System.out.println(contieneNumero(datos, 20));\\n            System.out.println(contieneNumero(datos, 99));\\n\\n        }\\n    }\\n", "88862e8e-d725-40ed-b4f0-51b0494c5b32": "import java.util.ArrayLyst;\\nimport java.util.HashMap;\\npublic class FiltroEdad { \\n    public static ArrayLyst<String>obtenerNombresMayoresDe30(ArrayLyst<HashMap<String, Object>> lista) {\\n        ArrayLyst<String>\\n        nombresFiltrados = new ArrayLyst<>();\\n        for (HashMap<String, Object> persona : lista) {\\n            Object edadObjeto = persona.get(\\"edad\\");\\n            if (edadObjeto instanceof Integer) { \\n                int edad = (integer) edadObjeto;\\n                if (edad >30) {\\n                    String nombre = (String) persona.get(\\"nombre\\");\\n                    if (nombre !=null) { \\n\\n                    }\\n                }\\n            }\\n        }\\n        return nombresFiltrados;\\n    }\\n}", "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a": "import java.util.*;\\npublic class PaisesCiudades {\\n    public static HashMap<String,  HashSet<String>> datos() {\\n        HashMap<String, HashSet<String>> m = new HashMap<>();\\n        m.put(\\"colombia\\", new HashSet<>(ArraysList(\\"bogota\\", \\"medellin\\", \\"cali\\")));\\n        m.put(\\"españa\\", new HashSet<>(ArraysList(\\"Madrid\\", \\"barcelona\\", \\"Valencia\\")));\\n        m.put(\\"japon\\", new HashSet<>(ArraysList(\\"tokio\\", \\"osaka\\", \\"kioto\\")));\\n        return m;\\n    }\\n    public static HashMap<String, String> ciudades(HashMap<String, HashSet<String>> m, String pais) {\\n        HashMap<String, String> r = new HashMap<>();\\n        if (m.containsKey(pais))\\n        for (String c : m.get(pais))\\n        r.put(c, c); \\n        return r;\\n    }\\n}"}	2.5	\N	sospechoso	0	2026-05-08 01:52:57.028504+00	2026-05-08 02:56:34.386+00	2026-05-08 01:52:57.028504+00	2026-05-08 02:56:42.944099+00	t	0.7	[0.70] La respuesta contiene errores de sintaxis y lógica que son comunes en los intentos iniciales de programación o en respuestas generadas por modelos de IA que no han sido suficientemente entrenados en la generación de código sin errores. El formato general del código es correcto, pero los fallos específicos en la implementación sugieren que podría no ser una solución ideada por un humano con experiencia o que no se revisó correctamente.\n[0.70] El uso de `ArraysList` en lugar de `Arrays.asList` es un error común que puede ser cometido tanto por humanos como por IA. Sin embargo, la estructura general y la idea del código son correctas, pero los errores puntuales sugieren una posible generación por IA con pequeñas desviaciones del código ideal.\n[0.20] La respuesta muestra una estructura muy típica de solución de ejercicios de programación, incluyendo la importación y la clase `main`. Sin embargo, los errores de sintaxis específicos en el `main` son un poco inusuales para una IA que generalmente genera código sintácticamente correcto. Esto podría indicar que fue escrita por un humano que cometió pequeños errores al final.	\N	0
5f147df6-006f-48f9-bf27-eb5ce9f34187	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	4e923995-0e57-4430-a1d6-cca9b9261775	{"__breakdown": [{"qid": "88862e8e-d725-40ed-b4f0-51b0494c5b32", "type": "codigo", "earned": 0.9, "points": 1, "feedback": "La respuesta es casi perfecta. El código es funcional y cumple con la mayoría de los requisitos de la rúbrica. Sin embargo, hay un pequeño detalle en el uso de las claves \\"EDAD\\" y \\"NOMBRE\\" en mayúsculas, mientras que en la descripción se mencionan \\"nombre\\" y \\"edad\\" en minúsculas. Esto podría generar un `NullPointerException` si las claves en los `HashMap`s de entrada están en minúsculas. Un buen evaluador debería señalar este detalle.", "ai_reasons": "El código es conciso y directo, lo que es común en las respuestas generadas por IA. No obstante, el pequeño error en el uso de mayúsculas y minúsculas en las claves sugiere un toque humano, ya que un modelo de IA más sofisticado podría haber notado esa inconsistencia con la descripción.", "ai_likelihood": 0.1}, {"qid": "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a", "type": "codigo", "earned": 0.6, "points": 1, "feedback": "El estudiante entendió la lógica general pero hubo varios errores de sintaxis y tipado. El HashMap no está declarado correctamente como genérico en la clase Main, y el tipo de retorno y los parámetros en el método `ObtenerCiudad` son incorrectos, además del nombre genérico `paises`.", "ai_reasons": "La respuesta muestra una comprensión parcial de los conceptos, pero comete errores sintácticos y de tipado que son más comunes en un estudiante humano con algunas dificultades que en una IA que suele generar código sintácticamente correcto.", "ai_likelihood": 0.2}, {"qid": "70255d55-f4e9-4ee3-a2f7-474cc955a9a2", "type": "codigo", "earned": 0.7, "points": 1, "feedback": "La respuesta del estudiante es casi correcta, pero contiene un error de sintaxis: `publicstatic` debería ser `public static`. Además, no incluye la creación del `HashSet<ArrayList<Integer>>` como tal, solo el uso del mismo en el método. Sin embargo, la lógica del método es correcta y cumple con la mayoría de los requisitos de la rúbrica.", "ai_reasons": "La respuesta es concisa y directa, con un error de sintaxis común que podría ser tanto humano como de IA. La falta de verbosidad y la estructura directa son ligeramente indicativas de IA, pero no concluyentes.", "ai_likelihood": 0.2}], "__session_id": "9b7d064a-1e55-4b91-8b4b-f85da4432f67", "__warning_events": [], "70255d55-f4e9-4ee3-a2f7-474cc955a9a2": "import java.util.ArrayList;\\r\\nimport java.util.HashSet;\\r\\npublic class Main {\\r\\n    publicstatic boolean numero(\\r\\n        HashSet<ArrayList<Integer>>conjuntos,int numero){\\r\\n            for (ArrayList<Integer>lista:conjuntos){\\r\\n                if(lista.contains(numero)){\\r\\n                    return true;\\r\\n                }\\r\\n            }\\r\\n            return false;\\r\\n        }\\r\\n}", "88862e8e-d725-40ed-b4f0-51b0494c5b32": "import java.util.ArrayList;\\r\\nimport java.util.HashMap;\\r\\n\\r\\npublic class Main\\r\\n {\\r\\n    public static ArrayList<String>mas30(ArrayList<HashMap<String,Object>>personas){\\r\\n        ArrayList<String> nombre=new ArrayList<>();\\r\\n        for (HashMap<String, Object> persona:personas){\\r\\n        int edad = (Integer) persona.get(\\"EDAD\\");\\r\\n        if (edad >30){\\r\\n            nombre.add((String) persona.get(\\"NOMBRE\\"));\\r\\n        }\\r\\n    }\\r\\n    return nombre;\\r\\n}\\r\\n }\\r\\n", "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a": "import java.util.HashMap;\\r\\nimport java.util.HashSet;\\r\\npublic class Main {HashMap<String>ObtenerCiudad(HashMap<String>,HashSet<String>>paises,String pais){\\r\\n    if (paises.containsKey(pais)){\\r\\n        return paises.get(pais);\\r\\n    }\\r\\n    return new HashSet<>();\\r\\n}\\r\\n    \\r\\n}"}	3.67	\N	completado	0	2026-05-08 01:51:32.960587+00	2026-05-08 02:11:31.127+00	2026-05-08 01:51:32.960587+00	2026-05-08 02:11:40.998998+00	f	0.2	[0.20] La respuesta muestra una comprensión parcial de los conceptos, pero comete errores sintácticos y de tipado que son más comunes en un estudiante humano con algunas dificultades que en una IA que suele generar código sintácticamente correcto.\n[0.20] La respuesta es concisa y directa, con un error de sintaxis común que podría ser tanto humano como de IA. La falta de verbosidad y la estructura directa son ligeramente indicativas de IA, pero no concluyentes.\n[0.10] El código es conciso y directo, lo que es común en las respuestas generadas por IA. No obstante, el pequeño error en el uso de mayúsculas y minúsculas en las claves sugiere un toque humano, ya que un modelo de IA más sofisticado podría haber notado esa inconsistencia con la descripción.	\N	0
265ee685-4afc-4257-ac5e-bde98def74e7	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	0a02892e-8476-44da-90e8-384c064e6040	{"__breakdown": [{"qid": "88862e8e-d725-40ed-b4f0-51b0494c5b32", "type": "codigo", "earned": 0.75, "points": 1, "feedback": "La solución implementada cumple con la mayoría de los requisitos de la rúbrica. Sin embargo, hay un error al intentar convertir la edad a `Integer` debido a que se asume que la edad en el `HashMap` es un `String` cuando se espera un `Integer`. Esto podría causar un `ClassCastException` o un `NumberFormatException` si el valor no es un string numérico.", "ai_reasons": "El código es funcional en su mayor parte, pero contiene un error específico en el manejo de tipos que es más común en un humano que en una IA que tendería a ser más precisa en el tipado. Además, el formato del código y los comentarios son simples y directos, sin la verbosidad que a veces se observa en las respuestas generadas por IA.", "ai_likelihood": 0.2}, {"qid": "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a", "type": "codigo", "earned": 1, "points": 1, "feedback": "La respuesta del estudiante cumple con todos los requisitos de la rúbrica. Crea correctamente el HashMap anidado, implementa el método solicitado con la lógica de verificación de existencia del país y devuelve un HashSet vacío si el país no se encuentra.", "ai_reasons": "La respuesta es concisa, usa nombres de variables y métodos descriptivos, y sigue una estructura de código común en ejemplos didácticos de Java. La claridad y completitud pueden sugerir que pudo ser generada por IA.", "ai_likelihood": 0.7}, {"qid": "70255d55-f4e9-4ee3-a2f7-474cc955a9a2", "type": "codigo", "earned": 1, "points": 1, "feedback": "La respuesta del estudiante es 100% correcta. Cumple con todos los requisitos de la rúbrica.", "ai_reasons": "La respuesta es impecable y concisa, lo que es común en respuestas generadas por IA. No hay errores de sintaxis, ni de lógica. El código es eficiente y cumple directamente con la solicitud. Sin embargo, no hay elementos adicionales que delaten a una IA, como explicaciones detalladas o comentarios excesivos. Podría ser un estudiante muy bueno.", "ai_likelihood": 0.7}], "__session_id": "bb9829da-3ad7-416e-8658-91ba13f6a3d6", "__warning_events": [{"at": "2026-05-08T02:06:20.587Z", "type": "pestaña", "questionIdx": null}, {"at": "2026-05-08T02:44:11.881Z", "type": "pestaña", "questionIdx": null}], "70255d55-f4e9-4ee3-a2f7-474cc955a9a2": "import java.util.*;\\r\\n\\r\\npublic class punto3{\\r\\n\\r\\n    public static boolean contieneNumero(HashSet<ArrayList<Integer>> conjuntos, int numero){\\r\\n        for(ArrayList<Integer> lista : conjuntos){\\r\\n            if(lista.contains(numero)){\\r\\n                return true;\\r\\n            }\\r\\n        }\\r\\n        return false;\\r\\n    }\\r\\n\\r\\n    public static void main(String[] args){\\r\\n        HashSet<ArrayList<Integer>> conjuntos = new HashSet<>();\\r\\n\\r\\n        ArrayList<Integer> lista1 = new ArrayList<>();\\r\\n        lista1.add(18);\\r\\n        lista1.add(19);\\r\\n        conjuntos.add(lista1);\\r\\n\\r\\n        ArrayList<Integer> lista2 = new ArrayList<>();\\r\\n        lista2.add(7);\\r\\n        lista2.add(8);\\r\\n        conjuntos.add(lista2);\\r\\n\\r\\n        ArrayList<Integer> lista3 = new ArrayList<>();\\r\\n        lista3.add(5);\\r\\n        lista3.add(6);\\r\\n        conjuntos.add(lista3);\\r\\n\\r\\n        System.out.println(contieneNumero(conjuntos, 19));\\r\\n        System.out.println(contieneNumero(conjuntos, 20));\\r\\n    }\\r\\n}", "88862e8e-d725-40ed-b4f0-51b0494c5b32": "import java.util.*;\\r\\n\\r\\npublic class Punto1{\\r\\n    public static ArrayList<String> getMayores30(ArrayList<HashMap<String, Object>> lista){\\r\\n        ArrayList<String> resultado = new ArrayList<>();\\r\\n\\r\\n        for (HashMap<String, Object> persona : lista){\\r\\n            int edad = Integer.parseInt((String) persona.get(\\"edad\\"));\\r\\n            if (edad>30){\\r\\n                String nombre = (String) persona.get(\\"nombre\\");\\r\\n                resultado.add(nombre);\\r\\n            }\\r\\n        }\\r\\n        return resultado;\\r\\n    }\\r\\n\\r\\n    public static void main(String[] args){\\r\\n        ArrayList<HashMap<String, Object>> lista = new ArrayList<>();\\r\\n\\r\\n        HashMap<String, Object> persona1 = new HashMap<>();\\r\\n        persona1.put(\\"nombre\\", \\"Jean Paul\\");\\r\\n        persona1.put(\\"edad\\", \\"18\\");\\r\\n        lista.add(persona1);\\r\\n\\r\\n        HashMap<String, Object> persona2 = new HashMap<>();\\r\\n        persona2.put(\\"nombre\\", \\"Viviana\\");\\r\\n        persona2.put(\\"edad\\", \\"24\\");\\r\\n        lista.add(persona2);\\r\\n\\r\\n        HashMap<String, Object> persona3 = new HashMap<>();\\r\\n        persona3.put(\\"nombre\\", \\"Juan\\");\\r\\n        persona3.put(\\"edad\\", \\"34\\");\\r\\n        lista.add(persona3);\\r\\n\\r\\n        ArrayList<String> resultado = getMayores30(lista);\\r\\n        System.out.println(\\"Las personas mayores de 30 son: \\" + resultado);\\r\\n    }\\r\\n}", "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a": "import java.util.*;\\r\\n\\r\\npublic class punto2{\\r\\n\\r\\n    public static HashSet<String> getCiudades(HashMap<String, HashSet<String>> paises, String pais){\\r\\n        if(!paises.containsKey(pais)){\\r\\n            return new HashSet<>();\\r\\n        }\\r\\n        return paises.get(pais);\\r\\n    }\\r\\n\\r\\n    public static void main(String[] args){\\r\\n        HashMap<String, HashSet<String>> paises = new HashMap<>();\\r\\n\\r\\n        HashSet<String> colombia = new HashSet<>();\\r\\n        colombia.add(\\"Cali\\");\\r\\n        colombia.add(\\"Popayan\\");\\r\\n        colombia.add(\\"Bogota\\");\\r\\n        paises.put(\\"COLOMBIA\\", colombia);\\r\\n\\r\\n        HashSet<String> argentina = new HashSet<>();\\r\\n        argentina.add(\\"Buenos Aires\\");\\r\\n        argentina.add(\\"Rosario\\");\\r\\n        paises.put(\\"ARGENTINA\\", argentina);\\r\\n\\r\\n        System.out.println(getCiudades(paises, \\"COLOMBIA\\"));\\r\\n        System.out.println(getCiudades(paises, \\"MEXICO\\"));\\r\\n    }\\r\\n    \\r\\n}"}	4.58	\N	sospechoso	2	2026-05-08 01:55:11.600114+00	2026-05-08 02:44:47.513+00	2026-05-08 01:55:11.600114+00	2026-05-08 02:44:56.001827+00	t	0.7	[0.70] La respuesta es concisa, usa nombres de variables y métodos descriptivos, y sigue una estructura de código común en ejemplos didácticos de Java. La claridad y completitud pueden sugerir que pudo ser generada por IA.\n[0.70] La respuesta es impecable y concisa, lo que es común en respuestas generadas por IA. No hay errores de sintaxis, ni de lógica. El código es eficiente y cumple directamente con la solicitud. Sin embargo, no hay elementos adicionales que delaten a una IA, como explicaciones detalladas o comentarios excesivos. Podría ser un estudiante muy bueno.\n[0.20] El código es funcional en su mayor parte, pero contiene un error específico en el manejo de tipos que es más común en un humano que en una IA que tendería a ser más precisa en el tipado. Además, el formato del código y los comentarios son simples y directos, sin la verbosidad que a veces se observa en las respuestas generadas por IA.	\N	0
2ee811f4-a638-4609-8af8-351d0c817600	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	{"__breakdown": [{"qid": "88862e8e-d725-40ed-b4f0-51b0494c5b32", "type": "codigo", "earned": 0.8, "points": 1, "feedback": "El estudiante casi cumple con todos los requisitos. La declaración del método `filtrarPersonas` no es correcta, le falta un tipo de retorno y un modificador de acceso. Además, hay un error de sintaxis en `!=`.", "ai_reasons": "La respuesta muestra errores de sintaxis comunes en programación, que son típicos de un principiante humano. No sigue un patrón de código impecable que a menudo producen las IAs.", "ai_likelihood": 0.2}, {"qid": "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a", "type": "codigo", "earned": 1, "points": 1, "feedback": "La respuesta del estudiante es excelente. Implementa correctamente todas las funcionalidades solicitadas en la rúbrica de manera concisa y eficiente, utilizando `getOrDefault` para manejar los casos donde el país no existe.", "ai_reasons": "La respuesta es muy concisa y utiliza una característica específica (`getOrDefault`) que es común en el código generado por IA para manejar casos por defecto. La estructura del código es limpia y sigue buenas prácticas, lo que puede ser indicativo de un modelo de IA entrenado en grandes corpus de código bien escrito.", "ai_likelihood": 0.7}, {"qid": "70255d55-f4e9-4ee3-a2f7-474cc955a9a2", "type": "codigo", "earned": 0.75, "points": 1, "feedback": "La solución es casi perfecta. Sin embargo, el ejemplo del `main` está incompleto ya que la `estructura` está vacía y `buscarNumero` siempre devolverá `false`. Faltaría añadir `ArrayLists` con números para demostrar la funcionalidad.", "ai_reasons": "La respuesta está bien estructurada y cumple con la mayoría de los requisitos. El código es funcional, pero el ejemplo en el `main` es demasiado simple como para haber sido autogenerado. También el nombre de las variables es descriptivo y las sentencias de control de flujo en la función `buscarNumero` son básicas y correctas.", "ai_likelihood": 0.2}], "__session_id": "89f308d4-a9b7-4eb5-9936-7c075e7e39ee", "__warning_events": [], "70255d55-f4e9-4ee3-a2f7-474cc955a9a2": "import java.util.*;\\r\\n\\r\\npublic class Solucion3{\\r\\n    public static void main (String[]args){\\r\\n        HashSet<ArrayList<Integer>> estructura = new HashSet<>();\\r\\n        System.out.println(buscarNumero(estructura,10));\\r\\n    }\\r\\npublic static boolean buscarNumero(HashSet<ArrayList<Integer>> conjunto, int numero){\\r\\n    for (ArrayList<Integer> lista : conjunto){\\r\\n        if (lista.contains(numero)){\\r\\n            return true;\\r\\n        }\\r\\n    }\\r\\n    return false;\\r\\n}\\r\\n}", "88862e8e-d725-40ed-b4f0-51b0494c5b32": "import java.util.*;\\r\\n\\r\\npublic class Solucion {\\r\\n    filtrarPersonas(ArrayList<HashMap<String, object>> listapersonas){\\r\\n        List<String>nombresFiltrados = new ArrayList<>();\\r\\n        for (HashMap<String, object>\\r\\n        pesonas : listapersonas){\\r\\n            String nombre = (String)\\r\\n        personas.get(\\"nombre\\");\\r\\n        Integer edad = (Integer) \\r\\n        personas.get(\\"edad\\");\\r\\n        if (edad ! = null && edad > 30){\\r\\n            nombresFiltrados.add(nombre);\\r\\n        }   \\r\\n        }\\r\\n    return nombresFiltrados;\\r\\n    }\\r\\n    \\r\\n}", "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a": "import java.util.HashMap;\\r\\nimport java.util.HashSet;\\r\\nimport java.util.Set;\\r\\n\\r\\npublic class Paises {\\r\\n    public static void main (String[] args){\\r\\n        HashMap<String, HashSet<String>>paisesciudades = new HashMap<>();\\r\\n\\r\\n        HashSet<String> ciudadescolombia = new HashSet<>();\\r\\n        ciudadescolombia.add(\\"Bogota\\");\\r\\n        ciudadescolombia.add(\\"Medellin\\");\\r\\n        paisesciudades.put(\\"Colombia\\", ciudadescolombia);\\r\\n        System.out.println(obtenerciudades(paisesciudades,\\"Colombia\\"));\\r\\n        System.out.println(obtenerciudades(paisesciudades,\\"España\\"));\\r\\n    }\\r\\n       public static Set<String> obtenerciudades(HashMap<String, HashSet<String>>mapa, String pais){\\r\\n        return mapa.getOrDefault(pais,new HashSet<>());\\r\\n       }\\r\\n}\\r\\n"}	4.25	\N	sospechoso	0	2026-05-08 01:04:23.470575+00	2026-05-08 01:44:11.612+00	2026-05-08 01:04:23.470575+00	2026-05-08 01:44:20.496773+00	t	0.7	[0.70] La respuesta es muy concisa y utiliza una característica específica (`getOrDefault`) que es común en el código generado por IA para manejar casos por defecto. La estructura del código es limpia y sigue buenas prácticas, lo que puede ser indicativo de un modelo de IA entrenado en grandes corpus de código bien escrito.\n[0.20] La respuesta muestra errores de sintaxis comunes en programación, que son típicos de un principiante humano. No sigue un patrón de código impecable que a menudo producen las IAs.\n[0.20] La respuesta está bien estructurada y cumple con la mayoría de los requisitos. El código es funcional, pero el ejemplo en el `main` es demasiado simple como para haber sido autogenerado. También el nombre de las variables es descriptivo y las sentencias de control de flujo en la función `buscarNumero` son básicas y correctas.	\N	0
e4e024a5-aaed-4a6c-8837-512d16082674	9ab4413a-f0e3-448d-a070-536cc466197e	531392ff-60c0-471d-af30-5e58bc80e860	{}	\N	1.75	completado	0	2026-05-06 17:25:28.766+00	2026-05-06 17:27:41.171+00	2026-05-06 17:25:29.008021+00	2026-05-06 17:27:41.488191+00	f	\N	\N	\N	0
ea7e14b9-1ce9-45c7-a7a6-9c7e37701327	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	{"__session_id": "8ff192cd-0cca-4e7d-a858-79bce666571b", "6eb2087a-28da-4911-a1f5-1a56d72f4c7e": "class motor{\\r\\n  String tipo;\\r\\n  int potencia;  \\r\\n\\r\\n  Motor(String t, int p){\\r\\n    tipo = t\\r\\n    potencia = p\\r\\n\\r\\n  } \\r\\n}\\r\\nclass Vehiculo{\\r\\n    Motor motor;\\r\\n    Vehiculo(String t,int p){\\r\\n        this.motor = new Motor(t, p);\\r\\n    }\\r\\n    System.out.printl\\r\\n}\\r\\n", "78edabd9-4e4f-4c2c-aeab-aeeb66e09a8a": "classDiagram\\n    class Vehiculo {\\n        -Motor\\n        +ImprimirinformacionMotor()\\n        +hacerSonido() void\\n    }\\n    class Perro {\\n        +String raza\\n        +ladrar() void\\n    }\\n    class Gato {\\n        +ronronear() void\\n    }\\n    Animal <|-- Perro\\n    Animal <|-- Gato", "8db47d7f-c0e5-4166-bfba-2fb651100cca": 2, "bd63a640-9636-4e50-a4a1-8d3ea42058a5": "Es una herramienta visual en el que se puede utilizar para representar las estructuras en el sistema."}	3.75	\N	completado	0	2026-05-01 00:57:19.395216+00	2026-05-01 01:15:00.104+00	2026-05-01 00:57:19.395216+00	2026-05-01 01:23:09.04882+00	f	\N	\N	\N	0
ad32045e-4b68-4a60-a94b-487c8009fe19	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	531392ff-60c0-471d-af30-5e58bc80e860	{"__session_id": "4410ad6f-6556-4203-8922-892f9d179474", "6eb2087a-28da-4911-a1f5-1a56d72f4c7e": "\\r\\n\\r\\npublic class Motor{\\r\\n private String tipo;\\r\\n private int potencia;\\r\\n\\r\\n public Motor(String tipo, int potencia){\\r\\n    this.tipo = tipo;\\r\\n    this.potencia = potencia;\\r\\n }\\r\\npublic String getTipo(){\\r\\n    return tipo;\\r\\n}\\r\\npublic static void imprimirInfo(){\\r\\n    System.out.println(\\"tipo:\\"+ tipo);\\r\\n    System.out.println(\\"potencia\\" + potencia + \\"HP\\");\\r\\n\\r\\n}\\r\\n\\r\\npublic class vehiculo{\\r\\n    private String marca;\\r\\n    \\r\\n}\\r\\n}", "8db47d7f-c0e5-4166-bfba-2fb651100cca": 2, "bd63a640-9636-4e50-a4a1-8d3ea42058a5": "representa la estructura estatica del sistema, muestra el molde de los objetos sus datos internos y como interactuan entre si. Es el plano arquitectonico que los desarrolladores usaran para escribir directamente java"}	2.63	\N	completado	0	2026-05-01 00:56:14.516709+00	2026-05-01 01:14:59.591+00	2026-05-01 00:56:14.516709+00	2026-05-01 02:36:14.377822+00	f	\N	\N	\N	0
f467f41a-aa10-49ce-acba-38fa6159f55a	ccc41a3c-261f-466c-913a-ca4d9c18e1d0	2b2cb673-f574-4f99-b152-c4f9c438ab0c	{"__session_id": "86d61a37-cada-4283-85db-a4f7815a0ae9", "6eb2087a-28da-4911-a1f5-1a56d72f4c7e": "class Motor {\\r\\n    String type;\\r\\n    int potencia;\\r\\n    public Motor (String tipo, int potencia){\\r\\n        System.out.printil(\\"Tipo de motor : \\" + tipo);\\r\\n        System.out.printil(\\"Potencia : \\" + tipo);\\r\\n    }\\r\\n}\\r\\nclass Vehiculo {\\r\\n    Motor motor;\\r\\n    public Vehiculo(Motor motor){\\r\\n        this.motor=motor;\\r\\n    }\\r\\n    public void mostrarMotor(){\\r\\n        motor.mostrarMotor();\\r\\n    }\\r\\n}\\r\\n\\r\\npublic class Main{\\r\\n    public static void main(String[] args){\\r\\n        Motor motor = new \\r\\n        Motor(\\"Gasolina\\", 130);\\r\\n        Vehiculo Vehiculo = new \\r\\n        Vehiculo(motor);\\r\\n        Vehiculo.mostrarMotor();\\r\\n    }\\r\\n}", "78edabd9-4e4f-4c2c-aeab-aeeb66e09a8a": "classDiagram \\nclass Motor {\\n    Strinf tipo\\n    int potencia\\n}\\n class \\n", "8db47d7f-c0e5-4166-bfba-2fb651100cca": 2, "bd63a640-9636-4e50-a4a1-8d3ea42058a5": "Es una representacion visual que muestra la estructura  de las clases, con sus relaciones, atributos y metodos   "}	2.94	\N	completado	0	2026-05-01 00:57:59.81163+00	2026-05-01 01:14:59.668+00	2026-05-01 00:57:59.81163+00	2026-05-08 01:06:55.974972+00	f	\N	\N	\N	0
55216976-feb7-46dc-882f-ee6bae98a3a7	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	0cf09e84-be38-4adf-8e74-44937461fc46	{"__breakdown": [{"qid": "88862e8e-d725-40ed-b4f0-51b0494c5b32", "type": "codigo", "earned": 1, "points": 1, "feedback": "La respuesta del estudiante cumple con todos los requisitos de la rúbrica. El código es correcto y funcional.", "ai_reasons": "El código es funcional y bien estructurado, lo que podría indicar una autoría humana. No hay indicios de patrones de lenguaje específicos de IA.", "ai_likelihood": 0.1}, {"qid": "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a", "type": "codigo", "earned": 0.2, "points": 1, "feedback": "La respuesta del estudiante tiene errores de sintaxis y no compila. El tipo de los valores del HashMap es incorrecto y la inicialización de `colombiaCiudades` es errónea. Además, el método `getCiudades` no está correctamente implementado para el tipo de HashMap esperado.", "ai_reasons": "La respuesta muestra errores de sintaxis básicos y una comprensión incompleta de los tipos genéricos en Java, lo cual es menos común en respuestas generadas por IA que suelen tener una sintaxis perfecta. Sin embargo, dado que está incompleto es posible que la IA no haya terminado de generar. La ausencia de comentarios y de un ejemplo completo de uso son indicativos neutros.", "ai_likelihood": 0.1}, {"qid": "70255d55-f4e9-4ee3-a2f7-474cc955a9a2", "type": "codigo", "earned": 0, "points": 1, "feedback": "Sin respuesta"}], "__session_id": "28adca0d-f690-4cc7-ac64-076bd74270bd", "__warning_events": [], "88862e8e-d725-40ed-b4f0-51b0494c5b32": "import java.util.ArrayList;\\r\\nimport java.util.HashMap;\\r\\n \\r\\npublic class Main {\\r\\n    public static ArrayList<String> filtrarMayoresDe30(ArrayList<HashMap<String, Object>> lista){\\r\\n        ArrayList<String> resultado = new ArrayList<>();\\r\\n    \\r\\n        for (HashMap<String, Object> persona : lista){\\r\\n            int edad = (int) persona.get(\\"edad\\");\\r\\n            if (edad>30){\\r\\n                String nombre = (String) persona.get(\\"nombre\\");\\r\\n            resultado.add(nombre);\\r\\n            }\\r\\n        }\\r\\n    \\r\\n    return resultado;\\r\\n }\\r\\n\\r\\n\\r\\npublic static void main(String[]args){System.out.println(\\"ok\\");\\r\\n}\\r\\n}\\r\\n", "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a": "import java.util.HashMap;\\r\\nimport java.util.HashSet;\\r\\n\\r\\npublic class Main {\\r\\n\\r\\n    public static HashSet<String> getCiudades(HashMap<String>> mapa, String pais){\\r\\n        if (mapa.containsKey(pais)){\\r\\n            return mapa.get(pais);\\r\\n        }\\r\\n        return new HashSet<>();\\r\\n    }\\r\\npublic static void main (String[]args){\\r\\n    HashMap<String> colombiaCiudades = new HashSet<>();\\r\\n    colombiaCiudades.add(\\"bogota\\");\\r\\n\\r\\n}\\r\\n\\r\\n\\r\\n\\r\\n\\r\\n}"}	2	\N	completado	0	2026-05-08 02:21:14.907002+00	2026-05-08 02:59:59.765+00	2026-05-08 02:21:14.907002+00	2026-05-08 03:00:07.105758+00	f	0.1	[0.10] El código es funcional y bien estructurado, lo que podría indicar una autoría humana. No hay indicios de patrones de lenguaje específicos de IA.\n[0.10] La respuesta muestra errores de sintaxis básicos y una comprensión incompleta de los tipos genéricos en Java, lo cual es menos común en respuestas generadas por IA que suelen tener una sintaxis perfecta. Sin embargo, dado que está incompleto es posible que la IA no haya terminado de generar. La ausencia de comentarios y de un ejemplo completo de uso son indicativos neutros.	\N	0
cb65a97c-ed9f-4a28-9042-e6f52c0701a8	174074b0-5e6f-4c2c-8dde-05b1bfe712dd	2b2cb673-f574-4f99-b152-c4f9c438ab0c	{"__breakdown": [{"qid": "88862e8e-d725-40ed-b4f0-51b0494c5b32", "type": "codigo", "earned": 0.8, "points": 1, "feedback": "El estudiante presenta una solución casi correcta. Se observa que comete errores tipográficos constantes en nombres de clases como `ArrayLits` en lugar de `ArrayList` y `object` en lugar de `Object`. Estos errores causan que el código no compile. Sin embargo, la lógica implementada es correcta y cumple con todos los requisitos de la rúbrica.", "ai_reasons": "La repetición constante de los mismos errores tipográficos, como \\"ArrayLits\\" en lugar de \\"ArrayList\\", sugiere un error humano recurrente en lugar de un error de IA, que usualmente mantiene consistencia en la generación de nombres de clases. Además, algunos de los errores como object en lowercase son errores comunes de tipografía al inicio de escribir código.", "ai_likelihood": 0.2}, {"qid": "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a", "type": "codigo", "earned": 1, "points": 1, "feedback": "La respuesta del estudiante es completamente correcta y cumple con todos los requisitos de la rúbrica.", "ai_reasons": "El código es conciso y claro, pero también bastante estándar para el problema planteado, lo que podría indicar una generación por IA. Sin embargo, no hay errores sutiles ni peculiaridades que sugieran fuertemente IA en lugar de un estudiante competente.", "ai_likelihood": 0.7}, {"qid": "70255d55-f4e9-4ee3-a2f7-474cc955a9a2", "type": "codigo", "earned": 0, "points": 1, "feedback": "Sin respuesta"}], "__session_id": "a3455c7b-5b29-4043-9164-d94734930547", "__warning_events": [], "88862e8e-d725-40ed-b4f0-51b0494c5b32": "import java.util.*;\\r\\nimport java.util.HashMap;\\r\\npublic class Main {\\r\\n    public static ArrayLits<String> mayores(ArrayLits<HashMap<String, Object>> lista){\\r\\n        ArrayLits<String> resultado = new arrayList<>();\\r\\n        for (HashMap<String,object> persona:lista){\\r\\n            String nombre = (String) persona.get(\\"nombre\\");\\r\\n            int edad =(Integer) persona.get(\\"edad\\");\\r\\n\\r\\n            if (edad>30){\\r\\n                resultado.add(nombre);\\r\\n            }\\r\\n        }\\r\\n        return resultado;\\r\\n    }\\r\\n\\r\\n    public static void main(String[] args){\\r\\n        ArrayLits<HashMap<String, Object>> personas = new ArrayLits<>();\\r\\n        HashMap<String, object> p1 = new HashMap<>();\\r\\n        p1.put(\\"nombre\\",\\"juan\\");\\r\\n        p1.put(\\"edad\\",25);\\r\\n        HashMap<String, object>p2= new HashMap<>();\\r\\n        p2.put(\\"nombre\\", \\"ile\\");\\r\\n        p2.put(\\"edad\\",32);\\r\\n        personas.add(p1);\\r\\n        personas.add(p2);\\r\\n        System.out.println(mayores(personas));\\r\\n    }\\r\\n}", "fbe8fe14-5b3a-4b22-ac3e-8c9ebbcfc21a": "import java.util.HashMap;\\r\\nimport java.util.HashSet;\\r\\n\\r\\npublic class Main {\\r\\n    public static HashSet<String> ciudades(HashMap<String, HashSet<String>> paises, String pais){\\r\\n        if (paises.containsKey(pais)){\\r\\n            return paises.get(pais);\\r\\n        }\\r\\n\\r\\n        return new HashSet<>();\\r\\n    }\\r\\n    public static void main (String[] args){\\r\\n        HashMap<String, HashSet<String>> paises = new HashMap<>();\\r\\n\\r\\n        HashSet<String> colombia = new HashSet<>();\\r\\n        colombia.add(\\"bogota\\");\\r\\n        colombia.add(\\"cali\\");\\r\\n\\r\\n        HashSet<String>mexico = new HashSet<>();\\r\\n        mexico.add(\\"moterrey\\");\\r\\n        mexico.add(\\"ciudad mexico\\");\\r\\n        paises.put(\\"colombia\\", colombia);\\r\\n        paises.put(\\"mexico\\", mexico); \\r\\n        System.out.println(ciudades(paises,\\"colombia\\"));\\r\\n        System.out.println(ciudades(paises,\\"lol\\"));\\r\\n    }\\r\\n}"}	3	\N	sospechoso	0	2026-05-08 02:10:43.487104+00	2026-05-08 02:49:16.241+00	2026-05-08 02:10:43.487104+00	2026-05-08 02:49:22.2097+00	t	0.7	[0.70] El código es conciso y claro, pero también bastante estándar para el problema planteado, lo que podría indicar una generación por IA. Sin embargo, no hay errores sutiles ni peculiaridades que sugieran fuertemente IA en lugar de un estudiante competente.\n[0.20] La repetición constante de los mismos errores tipográficos, como "ArrayLits" en lugar de "ArrayList", sugiere un error humano recurrente en lugar de un error de IA, que usualmente mantiene consistencia en la generación de nombres de clases. Además, algunos de los errores como object en lowercase son errores comunes de tipografía al inicio de escribir código.	\N	0
\.


--
-- Data for Name: user_roles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."user_roles" ("id", "user_id", "role", "created_at") FROM stdin;
7bb0d163-41d2-48e6-ade0-9d5fc795ca16	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	Estudiante	2026-04-26 04:19:11.251232+00
2990ea45-d33a-4763-a2d8-88db4a81742c	0cf09e84-be38-4adf-8e74-44937461fc46	Estudiante	2026-04-26 04:19:11.859462+00
bf407f7b-bff7-412c-b397-1eb4ec2cb1bb	4e923995-0e57-4430-a1d6-cca9b9261775	Estudiante	2026-04-26 04:19:12.336055+00
adb2f47f-91d1-4820-ac61-c4d256a905a2	0a02892e-8476-44da-90e8-384c064e6040	Estudiante	2026-04-26 04:19:12.79851+00
a3352df9-c488-44b2-9d61-80e921c70635	032a6335-5776-4677-8881-99db2cef9fe2	Estudiante	2026-04-26 04:19:13.254264+00
6bb447ec-2a99-41e6-af98-1eb2e54e0a76	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	Estudiante	2026-04-26 04:19:13.690234+00
ce6ca94b-95f0-42f7-9b36-deaecc69dd3e	d048a636-8a14-4fcd-aa3e-891cca899b32	Estudiante	2026-04-26 04:19:14.128436+00
3519f79b-c9a5-4383-a2c0-b71ec259b861	531392ff-60c0-471d-af30-5e58bc80e860	Estudiante	2026-04-26 04:19:14.593963+00
e6227a4b-d2cd-42e0-b228-96010bcd032f	2d709409-7b44-403d-a315-b8bb826aa8ca	Estudiante	2026-04-26 04:19:15.011193+00
b890f30d-38bb-4580-bc11-ed8c51cc1000	e5d5a97e-19e2-42a9-88fa-916eba925885	Estudiante	2026-04-26 04:19:15.482045+00
a1a3a7f7-ea9d-4bf8-aa29-b70dfddc0924	19e004a1-c1f2-4ca5-91d2-4c095058cb84	Estudiante	2026-04-26 04:19:15.945633+00
159d1417-464d-43bd-a67c-129231f3c4df	bce0ddee-4001-45e9-b323-719f80dc4f6d	Estudiante	2026-04-26 04:19:16.385707+00
458eb98c-df3f-4b0e-b789-d1ae972830f5	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	Estudiante	2026-04-26 04:19:16.864042+00
5bc97276-45e4-474b-990e-068dfcbe8dd3	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	Estudiante	2026-04-26 04:19:17.344588+00
c13d826c-e091-477d-b6b1-8d6e6a886057	2b2cb673-f574-4f99-b152-c4f9c438ab0c	Estudiante	2026-04-26 04:19:17.806395+00
6ace475c-d2a9-44c9-abe9-871fc20f08c0	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	Estudiante	2026-04-26 04:19:18.243793+00
676c6c21-0643-472b-9a55-e4e2a8784ee2	dac41f00-64e7-40b8-a207-31f1ee2718c0	Estudiante	2026-04-26 04:19:18.682068+00
4541853f-db78-4543-9275-b1d282fd52b3	9084565c-58dd-4e35-8793-a9cf198117b3	Estudiante	2026-05-05 03:08:07.143636+00
d7e8a9f5-a85b-4d8b-9649-c1ef5a6f8907	e8b3c430-2162-413b-8560-9e3a43e3577e	Admin	2026-04-26 02:48:38.56794+00
347d0128-1137-4484-ac5b-5dd98f806823	e8b3c430-2162-413b-8560-9e3a43e3577e	Docente	2026-04-26 02:48:38.737342+00
b6307e84-68a4-4d7b-ba19-9f747c9b03f0	e8b3c430-2162-413b-8560-9e3a43e3577e	Estudiante	2026-04-26 02:48:38.853553+00
31ee1883-d1fe-4367-aef5-f19a977d661f	2f19caf5-5927-4966-8f05-21860e4d56ac	Estudiante	2026-05-08 00:46:12.460783+00
4aad871a-9b42-4ad1-af23-054c0801bcac	158592d0-fd01-4425-9e70-3d4dce2104a8	Estudiante	2026-05-08 00:46:12.720901+00
5af5272e-e95b-4bb3-b387-b8186636d34a	83190bb0-b172-4cf6-8d4b-0023f0d1915e	Estudiante	2026-05-08 00:46:12.968657+00
e27cb9f0-45ae-4a5e-9101-fb4b9abc37f7	79209f37-2371-42d4-84cb-e17616337078	Estudiante	2026-05-08 00:46:13.21858+00
101d9c1e-4d3c-4def-8679-5a7086d825f4	06d4f666-f772-4a9c-807c-a523d353d02d	Estudiante	2026-05-08 00:46:13.455783+00
\.


--
-- Data for Name: workshop_assignments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."workshop_assignments" ("id", "workshop_id", "user_id", "created_at") FROM stdin;
0a21dce2-efde-4603-bfa1-0bc5361df1a8	57a96c1f-0340-4a0e-99b0-8da71d934669	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	2026-04-26 16:15:22.652858+00
b3cf401a-0d81-4a4d-8a4b-05b2fe845018	57a96c1f-0340-4a0e-99b0-8da71d934669	0cf09e84-be38-4adf-8e74-44937461fc46	2026-04-26 16:15:22.652858+00
c59c4a91-04ae-4d54-ac3a-01c780ea7e38	57a96c1f-0340-4a0e-99b0-8da71d934669	4e923995-0e57-4430-a1d6-cca9b9261775	2026-04-26 16:15:22.652858+00
f07a95ea-fb1d-41b5-a56e-1b9142d61558	57a96c1f-0340-4a0e-99b0-8da71d934669	0a02892e-8476-44da-90e8-384c064e6040	2026-04-26 16:15:22.652858+00
5acd6579-516c-4a1c-b934-6e22bf592a85	57a96c1f-0340-4a0e-99b0-8da71d934669	032a6335-5776-4677-8881-99db2cef9fe2	2026-04-26 16:15:22.652858+00
aaf6be10-2d2b-4429-b7d6-c8cd3d3a5e18	57a96c1f-0340-4a0e-99b0-8da71d934669	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	2026-04-26 16:15:22.652858+00
60c91b5a-4dbc-4496-915e-ec8b869cd754	57a96c1f-0340-4a0e-99b0-8da71d934669	d048a636-8a14-4fcd-aa3e-891cca899b32	2026-04-26 16:15:22.652858+00
9355c5f8-642b-4844-a082-5a45a4107cac	57a96c1f-0340-4a0e-99b0-8da71d934669	531392ff-60c0-471d-af30-5e58bc80e860	2026-04-26 16:15:22.652858+00
f9258d8c-e564-4893-bb37-3f56c32d3b9c	57a96c1f-0340-4a0e-99b0-8da71d934669	2d709409-7b44-403d-a315-b8bb826aa8ca	2026-04-26 16:15:22.652858+00
7ff09a33-9008-4380-b4f8-b01213da33b1	57a96c1f-0340-4a0e-99b0-8da71d934669	e5d5a97e-19e2-42a9-88fa-916eba925885	2026-04-26 16:15:22.652858+00
c29d2985-1c92-49a2-86a1-299cb6254429	57a96c1f-0340-4a0e-99b0-8da71d934669	19e004a1-c1f2-4ca5-91d2-4c095058cb84	2026-04-26 16:15:22.652858+00
63b6d94b-9338-40c8-a2e2-d2a8b9815948	57a96c1f-0340-4a0e-99b0-8da71d934669	bce0ddee-4001-45e9-b323-719f80dc4f6d	2026-04-26 16:15:22.652858+00
525c2db5-db54-4e6f-90bf-3ab4d5c7a061	57a96c1f-0340-4a0e-99b0-8da71d934669	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	2026-04-26 16:15:22.652858+00
9d53a70d-7e65-4c0e-95c8-ab2bc2a3d719	57a96c1f-0340-4a0e-99b0-8da71d934669	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	2026-04-26 16:15:22.652858+00
b716c2a0-141a-4ab8-b968-c0b8add6734c	57a96c1f-0340-4a0e-99b0-8da71d934669	2b2cb673-f574-4f99-b152-c4f9c438ab0c	2026-04-26 16:15:22.652858+00
47e0812d-47bb-400e-ab5d-f3177b07298b	57a96c1f-0340-4a0e-99b0-8da71d934669	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	2026-04-26 16:15:22.652858+00
5b57bf88-3cfd-490c-b5b9-41e3f05e77b0	57a96c1f-0340-4a0e-99b0-8da71d934669	dac41f00-64e7-40b8-a207-31f1ee2718c0	2026-04-26 16:15:22.652858+00
6c7a5ee1-f119-4263-b94a-1094d4d4d71f	57a96c1f-0340-4a0e-99b0-8da71d934669	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-04-26 16:15:24.979302+00
178b2f4b-9aa4-4349-a892-5c10e2870712	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	e8b3c430-2162-413b-8560-9e3a43e3577e	2026-05-03 16:46:34.022801+00
302e6d6d-47f2-4f30-97dd-57d5587fc44e	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	2026-05-03 16:46:34.022801+00
5e7e52a7-f570-41f1-8cfc-72226c0b4a2f	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	0cf09e84-be38-4adf-8e74-44937461fc46	2026-05-03 16:46:34.022801+00
d94b7f28-25b8-4d60-af25-623f00ddbafe	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	4e923995-0e57-4430-a1d6-cca9b9261775	2026-05-03 16:46:34.022801+00
c2a804e5-1f60-4ad4-9852-e6922d3b71db	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	0a02892e-8476-44da-90e8-384c064e6040	2026-05-03 16:46:34.022801+00
b9d8ac77-74f0-4c7d-ae94-d17146a7c958	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	032a6335-5776-4677-8881-99db2cef9fe2	2026-05-03 16:46:34.022801+00
c9a602a1-56aa-42a9-bbcf-d7865bd31c1c	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	2026-05-03 16:46:34.022801+00
82187bae-fbb7-4ed3-8859-d116971baac1	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	d048a636-8a14-4fcd-aa3e-891cca899b32	2026-05-03 16:46:34.022801+00
10f8e10f-9fc6-4cfc-b828-fda1a30a68b1	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	531392ff-60c0-471d-af30-5e58bc80e860	2026-05-03 16:46:34.022801+00
d2a556c6-b341-45c5-af4c-6f2a6fb969c4	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	2d709409-7b44-403d-a315-b8bb826aa8ca	2026-05-03 16:46:34.022801+00
7a12e175-b7fd-4e79-8d99-fbc21da9177a	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	e5d5a97e-19e2-42a9-88fa-916eba925885	2026-05-03 16:46:34.022801+00
1df07434-f825-4e6f-bcc7-8e295ca15e0f	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	19e004a1-c1f2-4ca5-91d2-4c095058cb84	2026-05-03 16:46:34.022801+00
7b0652d0-e6eb-45e6-a8fc-1f1019572e80	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	bce0ddee-4001-45e9-b323-719f80dc4f6d	2026-05-03 16:46:34.022801+00
d4f23bc0-e2bb-45de-a3f8-c00a42af5b53	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	2026-05-03 16:46:34.022801+00
58383bee-5187-486f-b57d-bfb294666bcf	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	b5074b3a-eb95-43dd-9224-bd3db8c27ef8	2026-05-03 16:46:34.022801+00
b67a3755-6fad-4e26-b17c-6c89fc27ffa0	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	2b2cb673-f574-4f99-b152-c4f9c438ab0c	2026-05-03 16:46:34.022801+00
07fe62c5-cc5c-4eec-9b75-a89fc6bf2809	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	2026-05-03 16:46:34.022801+00
3d3b1470-9288-4fcf-a4b9-608c1396997a	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	dac41f00-64e7-40b8-a207-31f1ee2718c0	2026-05-03 16:46:34.022801+00
6ce6518b-6c50-40d3-bd5a-a34592c4a825	57a96c1f-0340-4a0e-99b0-8da71d934669	9084565c-58dd-4e35-8793-a9cf198117b3	2026-05-06 18:27:47.832874+00
\.


--
-- Data for Name: workshop_group_members; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."workshop_group_members" ("group_id", "user_id", "joined_at") FROM stdin;
\.


--
-- Data for Name: workshop_groups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."workshop_groups" ("id", "workshop_id", "name", "signup_code", "created_by", "created_at") FROM stdin;
dbc9acc7-44ce-4db0-8b37-2dab033870c3	57a96c1f-0340-4a0e-99b0-8da71d934669	1	9bb378	\N	2026-05-07 21:52:18.213956+00
\.


--
-- Data for Name: workshop_questions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."workshop_questions" ("id", "workshop_id", "type", "content", "options", "position", "points", "expected_rubric", "starter_code", "test_cases", "language", "created_at") FROM stdin;
a955431a-b9c4-4878-a64b-6874985640ac	57a96c1f-0340-4a0e-99b0-8da71d934669	codigo	Escribe un método en Java que reciba un `ArrayList` de `String` y devuelva un `HashSet` con todos los elementos únicos de la lista.	\N	0	1	La solución debe crear un `HashSet` y añadir cada elemento del `ArrayList` a este. Debe manejar correctamente la declaración y el retorno de los tipos de datos.	\N	\N	java	2026-04-26 17:15:38.047576+00
4cd7583e-cd70-49d3-8cec-6a2f1052ec7c	57a96c1f-0340-4a0e-99b0-8da71d934669	codigo	Implementa una función en Java que tome un `String` y retorne un `HashMap` donde las claves sean los caracteres únicos del `String` y los valores sean el número de veces que cada carácter aparece en el `String`.	\N	1	1	La función debe inicializar un `HashMap<Character, Integer>`. Debe iterar sobre el `String`, y para cada carácter, si ya existe en el `HashMap`, incrementar su contador; de lo contrario, añadirlo con un valor de 1.	\N	\N	java	2026-04-26 17:15:38.047576+00
9a4435b4-6202-4f18-89d3-175f863e083f	57a96c1f-0340-4a0e-99b0-8da71d934669	codigo	Crea una función en Java que reciba dos `HashSet<Integer>` y devuelva un nuevo `HashSet<Integer>` que contenga la intersección de ambos (elementos comunes).	\N	2	1	La solución debe crear un nuevo `HashSet`. Debe iterar sobre uno de los `HashSet` de entrada y verificar si cada elemento está presente en el segundo `HashSet`. Los elementos comunes deben ser añadidos al nuevo `HashSet`.	\N	\N	java	2026-04-26 17:15:38.047576+00
a00d551e-3dc4-4966-b9f0-b05cbe043e99	57a96c1f-0340-4a0e-99b0-8da71d934669	codigo	Escribe un método en Java que reciba un `ArrayList` de `HashMap<String, String>` y devuelva un `HashSet<String>` con todos los valores únicos asociados a la clave 'nombre' en todos los mapas. Si un mapa no tiene la clave 'nombre', debe ignorarse.	\N	3	1	La solución debe inicializar un `HashSet<String>`. Debe iterar sobre el `ArrayList`, y para cada `HashMap`, verificar si contiene la clave 'nombre'. Si la tiene, el valor asociado debe ser añadido al `HashSet`.	\N	\N	java	2026-04-26 17:15:38.047576+00
4f2c49bf-48cb-4619-bcd7-b9cfa1e16d4b	57a96c1f-0340-4a0e-99b0-8da71d934669	codigo	Implementa en Java un método que reciba un `HashMap<String, ArrayList<Integer>>` y un `String` (clave). El método debe devolver la suma de todos los enteros en el `ArrayList` asociado a la clave dada. Si la clave no existe o el `ArrayList` está vacío, debe devolver 0.	\N	4	1	La función debe verificar si la clave existe en el `HashMap`. Si existe, debe iterar sobre el `ArrayList` asociado y sumar sus elementos. Debe manejar el caso de un `ArrayList` nulo o vacío, retornando 0 en esos casos.	\N	\N	java	2026-04-26 17:15:38.047576+00
56c3eeba-b046-424f-9989-45cce139e191	57a96c1f-0340-4a0e-99b0-8da71d934669	codigo	Escribe un programa en Java que cree un `HashMap` donde las claves sean nombres de ciudades (`String`) y los valores sean un `ArrayList` de nombres de personas (`String`) que viven en esa ciudad. Luego, imprime todas las personas que viven en una ciudad específica.	\N	5	1	La solución debe declarar e inicializar un `HashMap<String, ArrayList<String>>`. Debe añadir al menos dos ciudades con sus respectivas listas de personas. Debe implementar la lógica para recuperar y imprimir las personas de una ciudad dada.	\N	\N	java	2026-04-26 17:15:38.047576+00
f2764063-b03d-4d0b-aada-3e7ffdf1ab51	57a96c1f-0340-4a0e-99b0-8da71d934669	codigo	Implementa un método en Java que reciba un `ArrayList` de `String` (nombres de personas) y un `HashSet` de `String` (nombres de personas autorizadas). El método debe devolver un nuevo `ArrayList` de `String` con los nombres de las personas que están en la lista original y también están autorizadas.	\N	6	1	La función debe crear un nuevo `ArrayList`. Debe iterar sobre el `ArrayList` de entrada y, para cada nombre, verificar si está presente en el `HashSet` de autorizados. Si es así, el nombre debe ser añadido al nuevo `ArrayList`.	\N	\N	java	2026-04-26 17:15:38.047576+00
8c015875-9c49-4b49-90ab-fff19b1b73af	57a96c1f-0340-4a0e-99b0-8da71d934669	codigo	Escribe en Java una función que reciba un `HashMap<Integer, String>` y devuelva un `ArrayList<String>` con todos los valores del mapa.	\N	7	1	La función debe inicializar un `ArrayList<String>`. Debe iterar sobre los valores del `HashMap` y añadir cada valor al `ArrayList`.	\N	\N	java	2026-04-26 17:15:38.047576+00
5e4e5088-18de-40bd-8206-6f6d37ae4e94	57a96c1f-0340-4a0e-99b0-8da71d934669	codigo	Crea un método en Java que reciba un `ArrayList` de `Integer` y un `int` (valor límite). El método debe devolver un `HashSet<Integer>` con todos los números del `ArrayList` que sean mayores que el valor límite.	\N	8	1	La solución debe inicializar un `HashSet<Integer>`. Debe iterar sobre el `ArrayList`, y para cada número, verificar si es mayor que el valor límite. Si lo es, el número debe ser añadido al `HashSet`.	\N	\N	java	2026-04-26 17:15:38.047576+00
38d231f4-4a55-48e5-a5ee-5ca9eab80d57	57a96c1f-0340-4a0e-99b0-8da71d934669	codigo	Desarrolla en Java una función que reciba un `HashMap<String, HashSet<String>>`, donde la clave es el nombre de un grupo y el valor es un `HashSet` de nombres de personas que pertenecen a ese grupo. La función debe devolver un `HashSet<String>` con todos los nombres de personas únicas de todos los grupos.	\N	9	1	La función debe crear un `HashSet<String>` para almacenar todos los nombres únicos. Debe iterar sobre los valores (que son `HashSet<String>`) del `HashMap` y añadir todos los elementos de cada `HashSet` interno al conjunto de resultados.	\N	\N	java	2026-04-26 17:15:38.047576+00
3dac62cb-7d00-43b9-9fae-acebc0d7b37c	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	diagrama	Dibuja un diagrama de clases que represente la relación entre un 'Cliente' y sus 'Pedidos'. Considera que un cliente puede tener múltiples pedidos y un pedido pertenece a un solo cliente. Incluye atributos relevantes para cada clase.	\N	0	1	El diagrama debe mostrar dos clases: 'Cliente' y 'Pedido'.\n- La clase 'Cliente' debe tener atributos como 'id_cliente' (clave primaria), 'nombre', 'apellido' y 'direccion'.\n- La clase 'Pedido' debe tener atributos como 'id_pedido' (clave primaria), 'fecha_pedido', 'total' y 'id_cliente' (clave foránea).\n- Debe existir una relación de asociación entre 'Cliente' y 'Pedido' con una multiplicidad de 1 (Cliente) a * (Pedido), indicando que un cliente puede tener muchos pedidos.	\N	\N	\N	2026-05-03 16:47:10.599583+00
7b49e872-1d23-4a77-b9df-162f0beefd7f	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	diagrama	Diseña un diagrama de clases para modelar un sistema de gestión de bibliotecas. Incluye las clases 'Libro', 'Autor' y 'Editorial'. Un libro puede tener varios autores y una editorial, y un autor puede escribir varios libros. Una editorial publica varios libros.	\N	1	1	El diagrama debe incluir las clases 'Libro', 'Autor' y 'Editorial'.\n- 'Libro' debe tener atributos como 'isbn' (clave primaria), 'titulo', 'año_publicacion'.\n- 'Autor' debe tener atributos como 'id_autor' (clave primaria), 'nombre', 'apellido' y 'nacionalidad'.\n- 'Editorial' debe tener atributos como 'id_editorial' (clave primaria), 'nombre' y 'direccion'.\n- Debe haber una relación muchos a muchos entre 'Libro' y 'Autor' (un Libro puede tener varios 'Autor', un 'Autor' puede escribir varios 'Libro').\n- Debe haber una relación uno a muchos entre 'Editorial' y 'Libro' (una 'Editorial' publica muchos 'Libro').	\N	\N	\N	2026-05-03 16:47:10.599583+00
14d2915f-471d-4ed7-966b-6c7a564948e9	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	diagrama	Crea un diagrama de clases que represente la herencia en un sistema de vehículos. Considera una clase base 'Vehiculo' y clases derivadas como 'Coche', 'Moto' y 'Camion'. Incluye un atributo común en la clase base y atributos específicos en las clases derivadas.	\N	2	1	El diagrama debe incluir una clase base 'Vehiculo' con un atributo común como 'velocidad_maxima' o 'matricula'.\n- Debe haber tres clases derivadas: 'Coche', 'Moto' y 'Camion' que hereden de 'Vehiculo'.\n- 'Coche' debe tener un atributo específico como 'numero_puertas'.\n- 'Moto' debe tener un atributo específico como 'cilindrada'.\n- 'Camion' debe tener un atributo específico como 'capacidad_carga'.\n- Las flechas de herencia deben ir de las clases derivadas a la clase base.	\N	\N	\N	2026-05-03 16:47:10.599583+00
4c3e411f-4e15-4a56-bad6-50733ca519e2	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	diagrama	Diseña un diagrama de clases para un sistema de cursos en línea. Incluye las clases 'Curso', 'Profesor' y 'Estudiante'. Un curso tiene un profesor y puede tener muchos estudiantes. Un profesor puede impartir varios cursos. Un estudiante puede inscribirse en varios cursos.	\N	3	1	El diagrama debe incluir las clases 'Curso', 'Profesor' y 'Estudiante'.\n- 'Curso' debe tener atributos como 'id_curso' (clave primaria), 'nombre' y 'descripcion'.\n- 'Profesor' debe tener atributos como 'id_profesor' (clave primaria), 'nombre' y 'especialidad'.\n- 'Estudiante' debe tener atributos como 'id_estudiante' (clave primaria), 'nombre' y 'email'.\n- Debe haber una relación uno a muchos entre 'Profesor' y 'Curso' (un 'Profesor' puede impartir muchos 'Curso').\n- Debe haber una relación muchos a muchos entre 'Estudiante' y 'Curso' (un 'Estudiante' puede inscribirse en muchos 'Curso').	\N	\N	\N	2026-05-03 16:47:10.599583+00
d10e9727-1846-443e-a7f8-346487050b0f	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	diagrama	Elabora un diagrama de clases que muestre la composición entre las clases 'Ordenador' y 'CPU'. Un ordenador debe tener exactamente una CPU. Incluye atributos relevantes para ambas clases.	\N	4	1	El diagrama debe mostrar las clases 'Ordenador' y 'CPU'.\n- 'Ordenador' debe tener atributos como 'id_ordenador' (clave primaria), 'marca' y 'modelo'.\n- 'CPU' debe tener atributos como 'id_cpu' (clave primaria), 'fabricante' y 'velocidad_ghz'.\n- Debe existir una relación de composición (rombo relleno) entre 'Ordenador' y 'CPU', con una multiplicidad de 1 en el lado de 'CPU' (un 'Ordenador' tiene una 'CPU'), indicando que la 'CPU' no puede existir sin el 'Ordenador'.	\N	\N	\N	2026-05-03 16:47:10.599583+00
5d6e60ce-8be0-4778-94a2-18b54fad7665	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	diagrama	Representa en un diagrama de clases la agregación entre las clases 'Equipo' y 'Jugador' en un contexto deportivo. Un equipo tiene varios jugadores, y un jugador puede pertenecer a varios equipos a lo largo de su carrera pero solo a uno en un momento dado.	\N	5	1	El diagrama debe mostrar las clases 'Equipo' y 'Jugador'.\n- 'Equipo' debe tener atributos como 'id_equipo' (clave primaria), 'nombre' y 'deporte'.\n- 'Jugador' debe tener atributos como 'id_jugador' (clave primaria), 'nombre' y 'posicion'.\n- Debe existir una relación de agregación (rombo vacío) entre 'Equipo' y 'Jugador' con una multiplicidad de 1 (Equipo) a * (Jugador) en el lado del 'Jugador', indicando que un 'Equipo' está compuesto por muchos 'Jugador'.	\N	\N	\N	2026-05-03 16:47:10.599583+00
24c04bb7-f2a4-443b-b33d-09bee49fbbdd	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	diagrama	Crea un diagrama de clases para un sistema de gestión de empleados, incluyendo las clases 'Empleado', 'Departamento' y 'Puesto'. Un empleado trabaja en un departamento y ocupa un puesto. Un departamento tiene varios empleados, y un puesto puede ser ocupado por varios empleados (pero un empleado solo tiene un puesto).	\N	6	1	El diagrama debe incluir las clases 'Empleado', 'Departamento' y 'Puesto'.\n- 'Empleado' debe tener atributos como 'id_empleado' (clave primaria), 'nombre', 'apellido' y 'salario'.\n- 'Departamento' debe tener atributos como 'id_departamento' (clave primaria), 'nombre' y 'ubicacion'.\n- 'Puesto' debe tener atributos como 'id_puesto' (clave primaria), 'titulo' y 'nivel'.\n- Debe haber una relación uno a muchos entre 'Departamento' y 'Empleado' (un 'Departamento' tiene muchos 'Empleado').\n- Debe haber una relación uno a muchos entre 'Puesto' y 'Empleado' (un 'Puesto' puede ser ocupado por muchos 'Empleado' a lo largo del tiempo, pero un 'Empleado' solo tiene un 'Puesto' en un momento dado).	\N	\N	\N	2026-05-03 16:47:10.599583+00
\.


--
-- Data for Name: workshop_submission_answers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."workshop_submission_answers" ("id", "submission_id", "question_id", "answer_text", "selected_option", "code_content", "diagram_code", "ai_grade", "ai_feedback", "created_at", "updated_at", "ai_detected", "ai_detected_score", "ai_detected_reasons") FROM stdin;
5b789f38-a47c-487c-91e3-fb09156f3d1e	65b10f06-84a6-4712-8222-2772bd74dc1c	56c3eeba-b046-424f-9989-45cce139e191	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\n\r\npublic class Main {\r\n\r\n    public static void main(String[] args) {\r\n\r\n        HashMap<String, ArrayList<String>> ciudades = new HashMap<>();\r\n\r\n        ArrayList<String> cali = new ArrayList<>();\r\n        cali.add("Juan");\r\n        cali.add("Ana");\r\n        cali.add("Carlos");\r\n\r\n        ArrayList<String> bogota = new ArrayList<>();\r\n        bogota.add("Laura");\r\n        bogota.add("Pedro");\r\n\r\n        ciudades.put("Cali", cali);\r\n        ciudades.put("Bogotá", bogota);\r\n\r\n        String ciudadBuscada = "Cali";\r\n\r\n        if (ciudades.containsKey(ciudadBuscada)) {\r\n            System.out.println("Personas que viven en " + ciudadBuscada + ":");\r\n\r\n            for (String persona : ciudades.get(ciudadBuscada)) {\r\n                System.out.println("- " + persona);\r\n            }\r\n        } else {\r\n            System.out.println("No hay registros para la ciudad: " + ciudadBuscada);\r\n        }\r\n    }\r\n}	\N	1	El código es correcto, sigue todas las instrucciones de la rúbrica, compila y trabaja como se esperaba. La lógica es impecable, maneja el caso de que la ciudad buscada no exista en el mapa y la claridad es excelente.	2026-04-26 18:46:00.3914+00	2026-04-26 18:46:00.3914+00	f	\N	\N
8074cf2e-2fa7-4fb5-aacf-0fa562f8d284	65b10f06-84a6-4712-8222-2772bd74dc1c	a955431a-b9c4-4878-a64b-6874985640ac	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class Utils {\r\n\r\n    public static HashSet<String> obtenerElementosUnicos(ArrayList<String> lista) {\r\n        return new HashSet<>(lista);\r\n    }\r\n}	\N	1	El código es correcto y cumple con todos los requisitos del enunciado. Utiliza el constructor de `HashSet` que recibe una colección, lo cual es una forma concisa y eficiente de obtener los elementos únicos.	2026-04-26 18:45:50.870562+00	2026-04-26 18:45:50.870562+00	f	\N	\N
46a2abe2-811a-4539-813b-c690721fb91c	65b10f06-84a6-4712-8222-2772bd74dc1c	4cd7583e-cd70-49d3-8cec-6a2f1052ec7c	\N	\N	import java.util.HashMap;\r\n\r\npublic class Utils {\r\n\r\n    public static HashMap<Character, Integer> contarCaracteres(String texto) {\r\n        HashMap<Character, Integer> frecuencia = new HashMap<>();\r\n\r\n        if (texto == null || texto.isEmpty()) {\r\n            return frecuencia;\r\n        }\r\n\r\n        for (char c : texto.toCharArray()) {\r\n            frecuencia.put(c, frecuencia.getOrDefault(c, 0) + 1);\r\n        }\r\n\r\n        return frecuencia;\r\n    }\r\n}	\N	1	La solución es correcta y cumple con todos los requisitos. Maneja correctamente los casos nulos o vacíos, y utiliza `getOrDefault` de forma eficiente. El código es claro y conciso.	2026-04-26 18:45:52.660552+00	2026-04-26 18:45:52.660552+00	f	\N	\N
076974ad-1f16-4535-9f80-ef17747a1655	65b10f06-84a6-4712-8222-2772bd74dc1c	9a4435b4-6202-4f18-89d3-175f863e083f	\N	\N	import java.util.HashSet;\r\n\r\npublic class Utils {\r\n\r\n    public static HashSet<Integer> interseccion(HashSet<Integer> set1, HashSet<Integer> set2) {\r\n        HashSet<Integer> resultado = new HashSet<>();\r\n\r\n        if (set1 == null || set2 == null) {\r\n            return resultado;\r\n        }\r\n\r\n        HashSet<Integer> menor = set1.size() < set2.size() ? set1 : set2;\r\n        HashSet<Integer> mayor = set1.size() < set2.size() ? set2 : set1;\r\n\r\n        for (Integer elemento : menor) {\r\n            if (mayor.contains(elemento)) {\r\n                resultado.add(elemento);\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n}	\N	1	La solución del estudiante es impecable. Maneja correctamente los casos nulos, optimiza la iteración al recorrer el conjunto más pequeño y la lógica es clara y eficiente, cumpliendo exactamente con lo solicitado en la rúbrica.	2026-04-26 18:45:54.397274+00	2026-04-26 18:45:54.397274+00	f	\N	\N
03103f79-309d-468f-88bd-a86dc3c76f0c	65b10f06-84a6-4712-8222-2772bd74dc1c	a00d551e-3dc4-4966-b9f0-b05cbe043e99	\N	\N	mport java.util.ArrayList;\r\nimport java.util.HashMap;\r\nimport java.util.HashSet;\r\n\r\npublic class Utils {\r\n\r\n    public static HashSet<String> obtenerNombresUnicos(ArrayList<HashMap<String, String>> lista) {\r\n        HashSet<String> nombres = new HashSet<>();\r\n\r\n        if (lista == null || lista.isEmpty()) {\r\n            return nombres;\r\n        }\r\n\r\n        for (HashMap<String, String> mapa : lista) {\r\n            if (mapa != null && mapa.containsKey("nombre")) {\r\n                String valor = mapa.get("nombre");\r\n                if (valor != null) {\r\n                    nombres.add(valor);\r\n                }\r\n            }\r\n        }\r\n\r\n        return nombres;\r\n    }\r\n}	\N	1	El código es correcto. Maneja adecuadamente los casos nulos y vacíos, y sigue la lógica esperada de la rúbrica. El manejo de las importaciones es correcto.	2026-04-26 18:45:56.547057+00	2026-04-26 18:45:56.547057+00	f	\N	\N
f0b8b026-19a7-40c8-b420-8a8ef233a04c	65b10f06-84a6-4712-8222-2772bd74dc1c	4f2c49bf-48cb-4619-bcd7-b9cfa1e16d4b	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\n\r\npublic class Utils {\r\n\r\n    public static int sumarValores(HashMap<String, ArrayList<Integer>> mapa, String clave) {\r\n        if (mapa == null || clave == null) {\r\n            return 0;\r\n        }\r\n\r\n        ArrayList<Integer> lista = mapa.get(clave);\r\n\r\n        if (lista == null || lista.isEmpty()) {\r\n            return 0;\r\n        }\r\n\r\n        int suma = 0;\r\n        for (Integer valor : lista) {\r\n            if (valor != null) {\r\n                suma += valor;\r\n            }\r\n        }\r\n\r\n        return suma;\r\n    }\r\n}	\N	1	El código es correcto y cumple con todos los requisitos del enunciado, incluyendo el manejo de casos borde como clave no existente, `ArrayList` vacío o nulo, y `HashMap` o clave nulos. Además, considera el caso de elementos nulos dentro del `ArrayList`, lo cual es un excelente detalle. La lógica es clara y eficiente.	2026-04-26 18:45:58.594318+00	2026-04-26 18:45:58.594318+00	f	\N	\N
756867e8-5ef7-4d1f-a97d-ab84c2d83e5d	65b10f06-84a6-4712-8222-2772bd74dc1c	f2764063-b03d-4d0b-aada-3e7ffdf1ab51	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class Utils {\r\n\r\n    public static ArrayList<String> filtrarAutorizados(\r\n            ArrayList<String> personas,\r\n            HashSet<String> autorizados) {\r\n\r\n        ArrayList<String> resultado = new ArrayList<>();\r\n\r\n        if (personas == null || autorizados == null) {\r\n            return resultado;\r\n        }\r\n\r\n        for (String persona : personas) {\r\n            if (persona != null && autorizados.contains(persona)) {\r\n                resultado.add(persona);\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica esperada, maneja casos borde como listas nulas y nombres nulos, y es claro y legible.	2026-04-26 18:46:02.761151+00	2026-04-26 18:46:02.761151+00	f	\N	\N
67edbd55-7608-4598-86f5-cb263949288e	65b10f06-84a6-4712-8222-2772bd74dc1c	8c015875-9c49-4b49-90ab-fff19b1b73af	\N	\N	import java.util.HashMap;\r\nimport java.util.ArrayList;\r\n\r\npublic class Main {\r\n    public static void main(String[] args) {\r\n        HashMap<Integer, String> mapa = new HashMap<>();\r\n        mapa.put(1, "Juan");\r\n        mapa.put(2, "Ana");\r\n        mapa.put(3, "Carlos");\r\n\r\n        ArrayList<String> valores = Utils.obtenerValores(mapa);\r\n\r\n        System.out.println(valores); // [Juan, Ana, Carlos]\r\n    }\r\n}	\N	0.3	El estudiante solo incluyó el método main, la respuesta no es la solución completa.	2026-04-26 18:46:04.144475+00	2026-04-26 18:46:04.144475+00	f	\N	\N
b18611ba-94f1-4682-afdd-d9aa98d4171e	65b10f06-84a6-4712-8222-2772bd74dc1c	5e4e5088-18de-40bd-8206-6f6d37ae4e94	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class Utils {\r\n\r\n    public static HashSet<Integer> mayoresQue(ArrayList<Integer> lista, int limite) {\r\n        HashSet<Integer> resultado = new HashSet<>();\r\n\r\n        if (lista == null || lista.isEmpty()) {\r\n            return resultado;\r\n        }\r\n\r\n        for (Integer num : lista) {\r\n            if (num != null && num > limite) {\r\n                resultado.add(num);\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es correcto, sigue todos los puntos de la rúbrica y maneja adecuadamente los casos borde como listas vacías o nulas, e incluso elementos nulos en el ArrayList. Compila y funciona como se espera.	2026-04-26 18:46:06.205611+00	2026-04-26 18:46:06.205611+00	f	\N	\N
4e12d1f7-34cb-4a5b-be7e-f5a46497c48b	65b10f06-84a6-4712-8222-2772bd74dc1c	38d231f4-4a55-48e5-a5ee-5ca9eab80d57	\N	\N	import java.util.HashMap;\r\nimport java.util.HashSet;\r\n\r\npublic class Utils {\r\n\r\n    public static HashSet<String> obtenerPersonasUnicas(\r\n            HashMap<String, HashSet<String>> grupos) {\r\n\r\n        HashSet<String> resultado = new HashSet<>();\r\n\r\n        if (grupos == null || grupos.isEmpty()) {\r\n            return resultado;\r\n        }\r\n\r\n        for (HashSet<String> personas : grupos.values()) {\r\n            if (personas != null && !personas.isEmpty()) {\r\n                resultado.addAll(personas);\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica esperada, maneja casos borde como `HashMap` nulo o vacío, y `HashSet` internos nulos o vacíos. La claridad es excelente.	2026-04-26 18:46:08.124921+00	2026-04-26 18:46:08.124921+00	f	\N	\N
b9eaef78-21b5-469e-b9c9-65221f54ac0f	58faf5b2-4828-44ce-bb9b-6052c929bcb1	a955431a-b9c4-4878-a64b-6874985640ac	\N	\N	public static HashSet<String> obtenerUnicos(ArrayList<String> lista) {\nreturn new HashSet<>(lista);\n}	\N	1	El código es conciso, correcto y eficiente. Utiliza el constructor de `HashSet` que recibe una `Collection` para inicializarlo directamente con los elementos del `ArrayList`, lo que automáticamente maneja la unicidad.	2026-04-27 07:12:08.150444+00	2026-04-27 07:12:08.150444+00	f	\N	\N
c9877ec3-e9a1-4bef-868d-7dba9261593f	58faf5b2-4828-44ce-bb9b-6052c929bcb1	4cd7583e-cd70-49d3-8cec-6a2f1052ec7c	\N	\N	public static HashMap<Character, Integer> contarCaracteres(String texto) {\n    HashMap<Character, Integer> mapa = new HashMap<>();\n    for (char c: texto.toCharArray()) {\n        mapa.put(c, mapa.getOrDefault(c, 0)+1);\n    }\nreturn mapa;\n}	\N	1	La respuesta es completamente correcta y sigue la lógica esperada en la rúbrica. El código es conciso y eficiente al usar `getOrDefault`.	2026-04-27 07:12:10.017644+00	2026-04-27 07:12:10.017644+00	f	\N	\N
39fd0ef3-b385-4b9f-801c-b75fd5e98c03	58faf5b2-4828-44ce-bb9b-6052c929bcb1	9a4435b4-6202-4f18-89d3-175f863e083f	\N	\N	public static HashSet<Integer> interseccion(HashSet<Integer> set1, HashSet<Integer> set2) {\n    HashSet<Integer> resultado = new HashSet<>(set1);\n    resultado.retainAll(set2);\n    return resultado;\n}	\N	1	Excelente solución. Es concisa, correcta y eficiente. Utiliza el método `retainAll` de `HashSet`, que es la forma idiomática y más eficiente de calcular la intersección de dos conjuntos en Java.	2026-04-27 07:12:12.083679+00	2026-04-27 07:12:12.083679+00	f	\N	\N
029b7331-667d-421f-a2ab-c96268e04f87	58faf5b2-4828-44ce-bb9b-6052c929bcb1	a00d551e-3dc4-4966-b9f0-b05cbe043e99	\N	\N	public static HashSet<String> obtenerNombresUnicos(ArrayList<HashMap<String, String>> lista) {\n    HashSet<String> nombres = new HashSet<>();\n    for (HashMap<String, String> mapa : lista) {\n        String nombre = mapa.get("nombre");\n        if (nombre != null) {\n            nombres.add(nombre);\n        }\n    } return nombres;\n}	\N	1	El código es correcto y cumple con todos los requisitos del enunciado. La lógica es clara y maneja correctamente el caso donde la clave 'nombre' no existe en un mapa.	2026-04-27 07:12:14.260456+00	2026-04-27 07:12:14.260456+00	f	\N	\N
fd0b1bee-99fb-4137-840f-b3dc7e843553	58faf5b2-4828-44ce-bb9b-6052c929bcb1	4f2c49bf-48cb-4619-bcd7-b9cfa1e16d4b	\N	\N	public static int sumarValores(HashMap<String, ArrayList<Integer>> mapa, String clave) {\n    ArrayList<Integer> lista = mapa.get(clave);\n    if (lista == null) return 0;\n    int suma = 0; \n    for (int num : lista) {\n        suma += num;\n    }\n    return suma;\n}	\N	0.9	La solución es casi correcta y eficiente. Sin embargo, no maneja explícitamente el caso de un ArrayList vacío (aunque en la práctica `for (int num : lista)` simplemente no ejecutará el bucle, lo que resulta en una suma de 0, lo cual es el comportamiento esperado). Pero si la clave no existe, `mapa.get(clave)` devolverá `null`, lo que se maneja correctamente. La claridad es excelente.	2026-04-27 07:12:16.727907+00	2026-04-27 07:12:16.727907+00	f	\N	\N
7a4ccbae-5f4b-452a-95ba-829e81c918ba	58faf5b2-4828-44ce-bb9b-6052c929bcb1	56c3eeba-b046-424f-9989-45cce139e191	\N	\N	public static void ejercicio6() {\n    HashMap<String, ArrayList<String>> ciudades = new HashMap<>();\nciudades.put("medellin", new ArrayList<>(Arrays.asList("Ana", "luis", "carlos")));\nciudades.put("bogota", new ArrayList<>(Arrays.asList("Maria", "luis", "carlos")));\nciudades.put("cali", new ArrayList<>(Arrays.asList("Sofia", "Rafael", "carlos")));\nString ciudadBuscada = "medellin"; \nif (ciudades.containsKey(ciudadBuscada)){\n    System.out.println("personas en" + ciudadBuscada + "-" );\nfor (String persona : ciudades.get(ciudadBuscada)) {\n    System.out.println(persona);\n}\n} else {\n    System.out.println("la ciudad no existe");\n}\n}	\N	1	El código es correcto, sigue todos los puntos de la rúbrica y funciona perfectamente. Está bien estructurado, es claro y cumple con el enunciado. Como mejora podrías usar un `prompt` para que el usuario pueda introducir la ciudad por teclado. 	2026-04-27 07:12:18.561681+00	2026-04-27 07:12:18.561681+00	f	\N	\N
95da4428-3722-4e69-b19d-8c8a0a6bf1d8	58faf5b2-4828-44ce-bb9b-6052c929bcb1	f2764063-b03d-4d0b-aada-3e7ffdf1ab51	\N	\N	public static ArrayList<String> filtrarAutorizados(ArrayList<String> nombres, HashSet<String> autorizados) {\n    ArrayList<String> resultados = new ArrayList<>();\n    for (String nombre : nombres) {\n    if (autorizados.contains(nombre)) {\n        resultados.add(nombre);\n    }\n    }\n    return resultados;\n}	\N	1	El código es correcto y cumple con todos los requisitos. Es claro y conciso; el manejo de tipos genéricos es apropiado, y el uso de `HashSet.contains()` garantiza eficiencia. La creación de un nuevo `ArrayList` para los resultados es también el comportamiento esperado.	2026-04-27 07:12:21.327307+00	2026-04-27 07:12:21.327307+00	f	\N	\N
0c0a37f3-bd46-458c-ab2e-58b1715c7743	58faf5b2-4828-44ce-bb9b-6052c929bcb1	8c015875-9c49-4b49-90ab-fff19b1b73af	\N	\N	public static ArrayList<String> obtenerValores(HashMap<Integer, String> mapa) {\n    return new ArrayList<>(mapa.values());\n    \n}	\N	1	El código es correcto y conciso. Utiliza un constructor de `ArrayList` que recibe una `Collection` para inicializarlo con los valores del `HashMap`, lo cual es una excelente práctica. Además el código es eficiente y de fácil lectura. El código compilará sin problemas y entregará el resultado esperado.	2026-04-27 07:12:23.317714+00	2026-04-27 07:12:23.317714+00	f	\N	\N
d588667a-ca05-41f2-ac4f-a26e3a1e993b	58faf5b2-4828-44ce-bb9b-6052c929bcb1	5e4e5088-18de-40bd-8206-6f6d37ae4e94	\N	\N	public static HashSet<Integer> mayoresQue(ArrayList<Integer> lista, int limite) {\n    HashSet<Integer> resultado = new HashSet<>();\n    for (Integer num : lista) {\n    if (num > limite) {\n        resultado.add(num);\n    }\n    }\n    return resultado;\n}	\N	1	El código es correcto, sigue la lógica propuesta en la rúbrica y maneja adecuadamente los elementos de Java para este problema.	2026-04-27 07:12:25.11273+00	2026-04-27 07:12:25.11273+00	f	\N	\N
309b3d5b-57d7-4def-9bdf-b9976e5c648e	58faf5b2-4828-44ce-bb9b-6052c929bcb1	38d231f4-4a55-48e5-a5ee-5ca9eab80d57	\N	\N	public static HashSet<String> obtenerPersonasUnicas(HashMap<String, HashSet<String>> grupos) {\n    HashSet<String> resultado = new HashSet<>();\n    for (HashSet<String> personas : grupos.values()) {\n        resultado.addAll(personas);\n    }\n    return resultado;\n}\n\n// :) 	\N	1	El código es correcto, sigue la lógica propuesta en la rúbrica y es claro. Se manejan correctamente los tipos de datos y la iteración.	2026-04-27 07:12:27.122639+00	2026-04-27 07:12:27.122639+00	f	\N	\N
569e798b-1fd1-4e86-ad3b-7305bdda07b1	fcb93985-d50a-4b34-8372-8c5e3197de3e	a955431a-b9c4-4878-a64b-6874985640ac	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class Main {\r\n    \r\n    public static HashSet<String> obtenerUnicos(ArrayList<String> lista) {\r\n        return new HashSet<>(lista);\r\n    }\r\n    \r\n    public static void main(String[] args) {\r\n        ArrayList<String> lista = new ArrayList<>();\r\n        lista.add("Perro");\r\n        lista.add("Gato");\r\n        lista.add("Perro");\r\n        lista.add("Loro");\r\n        lista.add("Gato");\r\n        \r\n        HashSet<String> resultado = obtenerUnicos(lista);\r\n        System.out.println("Elementos únicos: " + resultado);\r\n    }\r\n}	\N	1	El código es correcto, conciso y cumple con todos los requisitos del enunciado. Utiliza el constructor del `HashSet` que recibe una `Collection`, lo cual es una forma eficiente y elegante de resolver el problema.	2026-04-28 03:10:58.751271+00	2026-04-28 03:10:58.751271+00	f	\N	\N
24a00b3f-419f-46ad-9e54-09ea4cd9e931	fcb93985-d50a-4b34-8372-8c5e3197de3e	4cd7583e-cd70-49d3-8cec-6a2f1052ec7c	\N	\N		\N	0	Sin respuesta	2026-04-28 03:10:58.9364+00	2026-04-28 03:10:58.9364+00	f	\N	\N
cfa29fb3-c350-43fb-8afb-89934d875972	fcb93985-d50a-4b34-8372-8c5e3197de3e	9a4435b4-6202-4f18-89d3-175f863e083f	\N	\N		\N	0	Sin respuesta	2026-04-28 03:10:59.106355+00	2026-04-28 03:10:59.106355+00	f	\N	\N
f1e9a789-ce49-4a1d-b834-88eb71736e1f	fcb93985-d50a-4b34-8372-8c5e3197de3e	a00d551e-3dc4-4966-b9f0-b05cbe043e99	\N	\N		\N	0	Sin respuesta	2026-04-28 03:10:59.280691+00	2026-04-28 03:10:59.280691+00	f	\N	\N
2925f1b0-e480-4703-8a74-4d3b758eb4b4	fcb93985-d50a-4b34-8372-8c5e3197de3e	4f2c49bf-48cb-4619-bcd7-b9cfa1e16d4b	\N	\N		\N	0	Sin respuesta	2026-04-28 03:10:59.449104+00	2026-04-28 03:10:59.449104+00	f	\N	\N
9c108266-27c4-4d2b-bed4-647d987d4d08	fcb93985-d50a-4b34-8372-8c5e3197de3e	56c3eeba-b046-424f-9989-45cce139e191	\N	\N		\N	0	Sin respuesta	2026-04-28 03:10:59.615596+00	2026-04-28 03:10:59.615596+00	f	\N	\N
b623d747-b1de-473a-becd-654ae3d058e8	fcb93985-d50a-4b34-8372-8c5e3197de3e	f2764063-b03d-4d0b-aada-3e7ffdf1ab51	\N	\N		\N	0	Sin respuesta	2026-04-28 03:10:59.791886+00	2026-04-28 03:10:59.791886+00	f	\N	\N
169fb158-63fa-48ef-8afc-1925ca03e6f0	fcb93985-d50a-4b34-8372-8c5e3197de3e	8c015875-9c49-4b49-90ab-fff19b1b73af	\N	\N		\N	0	Sin respuesta	2026-04-28 03:10:59.960539+00	2026-04-28 03:10:59.960539+00	f	\N	\N
bbf40909-a0a3-4413-bbea-61f33ccad85f	fcb93985-d50a-4b34-8372-8c5e3197de3e	5e4e5088-18de-40bd-8206-6f6d37ae4e94	\N	\N		\N	0	Sin respuesta	2026-04-28 03:11:00.129111+00	2026-04-28 03:11:00.129111+00	f	\N	\N
16c7e535-c727-4833-a8fa-91b9102a3545	fcb93985-d50a-4b34-8372-8c5e3197de3e	38d231f4-4a55-48e5-a5ee-5ca9eab80d57	\N	\N		\N	0	Sin respuesta	2026-04-28 03:11:00.298834+00	2026-04-28 03:11:00.298834+00	f	\N	\N
daa6d763-783f-40e0-8259-c73186342841	e03bcd1f-b33b-4b47-a415-03c1a8228134	a955431a-b9c4-4878-a64b-6874985640ac	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class Punto1 {\r\n    public static void main(String[] args) {\r\n        //Crear una lista con elementos duplicados\r\n        ArrayList<String> listaNombres = new ArrayList<>();\r\n        listaNombres.add("Ana");\r\n        listaNombres.add("Pedro");\r\n        listaNombres.add("Ana"); //Duplicado\r\n        listaNombres.add("Luis");\r\n\r\n        //Llamar el método y guardar el resultado\r\n        HashSet<String> nombresUnicos = convertirAUnicos(listaNombres);\r\n\r\n        //Imprimir el resultado\r\n        System.out.println("Lista original: " + listaNombres);\r\n        System.out.println("HashSet (unicos): " + nombresUnicos);\r\n    }\r\n\r\n    public static HashSet<String> convertirAUnicos(ArrayList<String> lista){\r\n        HashSet<String> conjunto = new HashSet<>(lista);\r\n        return conjunto;\r\n    }\r\n}	\N	1	El código es correcto y cumple con todos los requisitos. Utiliza el constructor de `HashSet` que recibe directamente un `Collection`, lo que es una forma concisa y eficiente de obtener los elementos únicos.	2026-04-30 02:15:06.911832+00	2026-04-30 02:15:06.911832+00	f	\N	\N
b2b95fe5-dfde-4065-beb9-d646bb7becd8	e03bcd1f-b33b-4b47-a415-03c1a8228134	4cd7583e-cd70-49d3-8cec-6a2f1052ec7c	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\n\r\npublic class Punto2 {\r\n    public static void main(String[] args) {\r\n        \r\n        String texto = "Programacion en java";\r\n\r\n        //Llamar el método\r\n        HashMap<Character, Integer> resultado = contarFrecuencia(texto);\r\n        \r\n        //Imprimir el resultado\r\n        System.out.println("Frecuencia de caracteres para: '" + texto + "'");\r\n        resultado.forEach((caracter, cantidad) -> {\r\n            System.out.println("'" + caracter + "': " + cantidad);\r\n        });\r\n    }\r\n\r\n    public static HashMap<Character, Integer> contarFrecuencia(String entrada){\r\n        //Crear el mapa\r\n        HashMap<Character, Integer> mapaFrecuencia = new HashMap<>();\r\n\r\n        //Convertir el String en un arreglo de caracteres\r\n        for (char c : entrada.toCharArray()){\r\n            mapaFrecuencia.put(c, mapaFrecuencia.getOrDefault(c, 0) + 1);\r\n        }\r\n        return mapaFrecuencia;\r\n    }\r\n\r\n}	\N	1	El código es correcto, sigue la lógica propuesta en la rúbrica y maneja bien el caso de caracteres repetidos. La claridad es buena y el uso de `getOrDefault` es eficiente.	2026-04-30 02:15:09.317796+00	2026-04-30 02:15:09.317796+00	f	\N	\N
0d3c0bbd-4997-4b4d-a9a5-8177bf13d1f3	e03bcd1f-b33b-4b47-a415-03c1a8228134	9a4435b4-6202-4f18-89d3-175f863e083f	\N	\N	import java.util.HashSet;\r\nimport java.util.ArrayList;\r\n\r\npublic class Punto3 {\r\n    public static void main(String[] args) {\r\n        HashSet<Integer> numeros1 = new HashSet<>();\r\n        numeros1.add(20);\r\n        numeros1.add(18);\r\n        numeros1.add(11);\r\n        numeros1.add(30);\r\n\r\n        HashSet<Integer> numeros2 = new HashSet<>();\r\n        numeros2.add(18);\r\n        numeros2.add(30);\r\n        numeros2.add(31);\r\n        numeros2.add(14);\r\n\r\n        HashSet<Integer> repetidos = interseccion(numeros1, numeros2);\r\n\r\n        System.out.println("Conjunto 1: " + numeros1);\r\n        System.out.println("Conjunto 2: " + numeros2);\r\n        System.out.println("HashSet (Intersección): " + repetidos);\r\n    }\r\n\r\n    public static HashSet<Integer> interseccion(HashSet<Integer> set1, HashSet<Integer> set2){\r\n        HashSet<Integer> interseccion = new HashSet<>(set1);\r\n        interseccion.retainAll(set2);\r\n        return interseccion;\r\n    }\r\n    \r\n}	\N	1	La solución es completamente correcta y eficiente. Aunque no sigue la rúbrica estrictamente al iterar, utiliza un método más idiomático y eficiente para Java (`retainAll`), que es preferible. Inicializar el HashSet con `set1` es también una buena práctica.	2026-04-30 02:15:12.29554+00	2026-04-30 02:15:12.29554+00	f	\N	\N
a589dad3-1d67-4de9-b359-7582851668c0	e03bcd1f-b33b-4b47-a415-03c1a8228134	a00d551e-3dc4-4966-b9f0-b05cbe043e99	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\nimport java.util.HashSet;\r\n\r\npublic class Punto4 {\r\n    public static void main(String[] args) {\r\n        //Crear lista de mapas\r\n        ArrayList<HashMap<String, String>> listaUsuarios = new ArrayList<>();\r\n\r\n        HashMap<String, String> u1 = new HashMap<>();\r\n        u1.put("nombre", "Ana");\r\n        u1.put("id", "123");\r\n\r\n        HashMap<String, String> u2 = new HashMap<>();\r\n        u2.put("nombre", "Juan");\r\n\r\n        HashMap<String, String> u3 = new HashMap<>();\r\n        u3.put("nombre", "Ana");\r\n\r\n        HashMap<String, String> u4 = new HashMap<>();\r\n        u4.put("edad", "25");\r\n\r\n        listaUsuarios.add(u1);\r\n        listaUsuarios.add(u2);\r\n        listaUsuarios.add(u3);\r\n        listaUsuarios.add(u4);\r\n\r\n        //Llamar al método\r\n        HashSet<String> nombresUnicos = obtenerNombresUnicos(listaUsuarios);\r\n\r\n        //Resultado\r\n        System.out.println("Nombres unicos encontrados: "+ nombresUnicos);\r\n    }\r\n\r\n    public static HashSet<String> obtenerNombresUnicos(ArrayList<HashMap<String, String>> lista){\r\n        HashSet<String> resultado = new HashSet<>();\r\n        //Recorrer cada mapa\r\n        for (HashMap<String, String> mapa : lista){\r\n            //Verificar si el mapa contiene la clave nombre\r\n            if (mapa.containsKey("Nombre")){\r\n                //Obtener el valor y añadirlo al HashSet\r\n                String nombre = mapa.get("Nombre");\r\n                resultado.add(nombre);\r\n            }\r\n        }\r\n        return resultado;\r\n    }\r\n}	\N	0.7	El código es casi correcto y sigue la lógica esperada. Sin embargo, hay un pequeño error de capitalización en la clave "Nombre" al verificar si el mapa la contiene (`if (mapa.containsKey("Nombre"))`). El enunciado y la creación de los mapas usan "nombre" en minúsculas, lo que provoca que el método no encuentre los nombres correctamente. Si se corrige esta minúscula, el código funcionará perfectamente.	2026-04-30 02:15:15.255851+00	2026-04-30 02:15:15.255851+00	f	\N	\N
6b45ea31-36bc-4b85-9759-ae724a4bdc30	5727ca21-785d-46fd-9779-2950fbf251f9	8c015875-9c49-4b49-90ab-fff19b1b73af	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\n\r\npublic class Utilidades {\r\n\r\n    public static ArrayList<String> obtenerValores(HashMap<Integer, String> mapa) {\r\n        return new ArrayList<>(mapa.values());\r\n    }\r\n}	\N	1	El código es correcto y conciso. Utiliza el constructor de `ArrayList` que acepta una `Collection` para inicializarse directamente con los valores del mapa, lo cual es una solución elegante.	2026-04-30 02:44:15.158264+00	2026-04-30 02:44:15.158264+00	f	\N	\N
35feb360-076a-439a-b992-246a3d42e374	e03bcd1f-b33b-4b47-a415-03c1a8228134	4f2c49bf-48cb-4619-bcd7-b9cfa1e16d4b	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\n\r\npublic class Punto5 {\r\n    public static void main(String[] args) {\r\n        //Crear el mapa de datos\r\n        HashMap<String, ArrayList<Integer>> mapaDatos = new HashMap<>();\r\n\r\n        //Caso con datos\r\n        ArrayList<Integer> ventas = new ArrayList<>();\r\n        ventas.add(5600);\r\n        ventas.add(4700);\r\n        ventas.add(2300);\r\n        mapaDatos.put("Ventas", ventas);\r\n\r\n        //Caso lista vacía\r\n        mapaDatos.put("Gastos", new ArrayList<>());\r\n\r\n        //Probar el método\r\n        System.out.println("Suma ventas: " + sumarValores(mapaDatos, "Ventas"));\r\n        System.out.println("Suma gastos: " + sumarValores(mapaDatos, "Gastos"));\r\n        System.out.println("Suma desconocido: " + sumarValores(mapaDatos, "Otros"));\r\n    }\r\n\r\n    //Sumar los elementos de la lista asociados a una clave\r\n    public static int sumarValores(HashMap<String, ArrayList<Integer>> mapa, String clave){\r\n        //Verificar si la clave existe en el mapa\r\n        if (!mapa.containsKey(clave)){\r\n            return 0;\r\n        }\r\n        //Obtener la lista asociada a la clave\r\n        ArrayList<Integer> lista = mapa.get(clave);\r\n        //Verificar si la lista es nula o está vacía\r\n        if (lista == null || lista.isEmpty()){\r\n            return 0;\r\n        }\r\n        //Sumar los elementos de la lista\r\n        int sumaTotal = 0;\r\n        for (Integer numero : lista){\r\n            sumaTotal += numero;\r\n        }\r\n        return sumaTotal;\r\n    }\r\n}	\N	1	El código es correcto, cumple con todos los requisitos del enunciado y maneja adecuadamente los casos borde. La lógica es clara y el código es fácil de entender.	2026-04-30 02:15:17.312263+00	2026-04-30 02:15:17.312263+00	f	\N	\N
757d34ea-a839-4c35-a137-9b3f11570eb6	e03bcd1f-b33b-4b47-a415-03c1a8228134	8c015875-9c49-4b49-90ab-fff19b1b73af	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\nimport java.util.Collection;\r\n\r\npublic class Punto8 {\r\n    public static void main(String[] args) {\r\n        //Crear el mapa y agregar datos\r\n        HashMap<Integer, String> productos = new HashMap<>();\r\n        productos.put(750, "Parlante");\r\n        productos.put(490, "Teclado");\r\n        productos.put(331, "Mouse");\r\n\r\n        //Agregar a la función\r\n        ArrayList<String> listaValores = obtenerValoresComoLista(productos);\r\n\r\n        System.out.println("Lista de valores: " + listaValores);\r\n    }\r\n\r\n    public static ArrayList<String> obtenerValoresComoLista(HashMap<Integer, String> mapa){\r\n        ArrayList<String> valores = new ArrayList<>(mapa.values());\r\n\r\n        return valores;\r\n    }\r\n}	\N	1	El código es correcto y cumple con lo solicitado en el enunciado de forma eficiente. Inicializa un `ArrayList` y lo llena con los valores del `HashMap` utilizando el constructor que recibe una `Collection`. La inclusión de un método `main` para probar la función es un plus.	2026-04-30 02:15:23.488992+00	2026-04-30 02:15:23.488992+00	f	\N	\N
d2b29885-3d06-4ce0-aff5-2372df01c6a5	e03bcd1f-b33b-4b47-a415-03c1a8228134	56c3eeba-b046-424f-9989-45cce139e191	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\nimport java.util.HashSet;;\r\n\r\npublic class Punto6 {\r\n    public static void main(String[] args) {\r\n        //Crear el HashMap\r\n        HashMap<String, ArrayList<String>> ciudades = new HashMap<>();\r\n\r\n        //Agregar datos\r\n        agregarPersona(ciudades, "Madrid", "Carlos");\r\n        agregarPersona(ciudades, "Madrid", "Edilma");\r\n        agregarPersona(ciudades, "Cali", "David");\r\n        agregarPersona(ciudades, "Bogotá", "Sofia");\r\n        agregarPersona(ciudades, "Medellin", "Sara");\r\n\r\n        //Consultar una ciudad específica\r\n        String ciudadAConsultar = "Bogotá";\r\n        imprimirHabitantes(ciudades, ciudadAConsultar);\r\n    }\r\n\r\n    //Método para agregar una person a una ciudad de forma segura\r\n    public static void agregarPersona(HashMap<String, ArrayList<String>> mapa, String ciudad, String nombre){\r\n        //Si la ciudad no existe en el mapa\r\n        if (!mapa.containsKey(ciudad)){\r\n            mapa.put(ciudad, new ArrayList<>());\r\n        }\r\n        mapa.get(ciudad).add(nombre);\r\n    }\r\n    \r\n    //Método para imprimir los habitantes de una ciudad\r\n    public static void imprimirHabitantes(HashMap<String, ArrayList<String>> mapa, String ciudad){\r\n        if (mapa.containsKey(ciudad)){\r\n            System.out.println("Habitantes en " + ciudad + ": " + mapa.get(ciudad));\r\n        } else {\r\n            System.out.println("La ciudad '" + ciudad + "' no tiene registros");\r\n        }\r\n    }\r\n\r\n}	\N	1	El código es correcto, sigue las instrucciones del enunciado y utiliza buenas prácticas como la creación de métodos auxiliares. Maneja el caso de que la ciudad no tenga registros. Utiliza las estructuras de datos adecuadas.	2026-04-30 02:15:19.246092+00	2026-04-30 02:15:19.246092+00	f	\N	\N
755e9447-f2b2-4381-b5f9-e2d255dfa8bb	e03bcd1f-b33b-4b47-a415-03c1a8228134	5e4e5088-18de-40bd-8206-6f6d37ae4e94	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class Punto9 {\r\n    public static void main(String[] args) {\r\n        //Crear una lista de prueba\r\n        ArrayList<Integer> numeros = new ArrayList<>();\r\n        numeros.add(10);\r\n        numeros.add(25);\r\n        numeros.add(5);\r\n        numeros.add(25);\r\n        numeros.add(40);\r\n\r\n        int limite = 20;\r\n\r\n        HashSet<Integer> resultado = filtrarMayoresQue(numeros, limite);\r\n\r\n        System.out.println("Numeros mayores que " + limite + ": " + resultado);\r\n\r\n    }\r\n\r\n    public static HashSet<Integer> filtrarMayoresQue(ArrayList<Integer> lista, int limite){\r\n        HashSet<Integer> mayores = new HashSet<>();\r\n\r\n        for (Integer num : lista){\r\n            if (num > limite){\r\n                mayores.add(num);\r\n            }\r\n        }\r\n        return mayores;\r\n    }\r\n    \r\n}	\N	1	El código es correcto, sigue la lógica propuesta en la rúbrica y maneja los casos borde correctamente (por ejemplo, números duplicados en el ArrayList no se duplican en el HashSet). La claridad del código es buena y compila sin errores.	2026-04-30 02:15:25.369227+00	2026-04-30 02:15:25.369227+00	f	\N	\N
68ccbe1c-16c4-4729-8fe5-39d89ef8758a	e03bcd1f-b33b-4b47-a415-03c1a8228134	f2764063-b03d-4d0b-aada-3e7ffdf1ab51	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\nimport java.util.List;\r\n\r\npublic class Punto7 {\r\n    public static void main(String[] args) {\r\n        //Lista de personas que intentan ingresar\r\n        ArrayList<String> personasEntrada = new ArrayList<>();\r\n        personasEntrada.add("Valentina");\r\n        personasEntrada.add("Paula");\r\n        personasEntrada.add("David");\r\n        personasEntrada.add("Samuel");\r\n\r\n        //Conjunto de personas autorizadas\r\n        HashSet<String> autorizados = new HashSet<>();\r\n        autorizados.add("Valentina");\r\n        autorizados.add("Sofia");\r\n        autorizados.add("David");\r\n\r\n        //Llamada al método de filtrado\r\n        ArrayList<String> admitidos = filtrarAutorizados(personasEntrada, autorizados);\r\n\r\n        //Resultado\r\n        System.out.println("Personas admitidas: " + admitidos);\r\n    }\r\n\r\n    public static ArrayList<String> filtrarAutorizados(ArrayList<String> listaOriginal, HashSet<String> listaAutorizados){\r\n        ArrayList<String> resultado = new ArrayList<>();\r\n\r\n        for (String persona : listaOriginal){\r\n            if (listaAutorizados.contains(persona)){\r\n                resultado.add(persona);\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es correcto, sigue al pie de la letra la rúbrica y cumple con el enunciado. La lógica es clara y el manejo de los casos borde (listas vacías o sin coincidencias) se maneja correctamente de forma implícita. La sintaxis y la estructura son adecuadas para Java.	2026-04-30 02:15:21.495152+00	2026-04-30 02:15:21.495152+00	f	\N	\N
fbb22467-9319-417f-bc15-ff23a1ab3a0f	e03bcd1f-b33b-4b47-a415-03c1a8228134	38d231f4-4a55-48e5-a5ee-5ca9eab80d57	\N	\N	import java.util.HashMap;\r\nimport java.util.HashSet;\r\nimport java.util.Map;\r\n\r\npublic class Punto10 {\r\n    public static void main(String[] args) {\r\n        HashMap<String, HashSet<String>> grupos = new HashMap<>();\r\n\r\n        HashSet<String> rock = new HashSet<>();\r\n        rock.add("Valentina");\r\n        rock.add("Leidy");\r\n\r\n        HashSet<String> jazz = new HashSet<>();\r\n        jazz.add("Juan");\r\n        jazz.add("Sara");\r\n\r\n        grupos.put("Rock", rock);\r\n        grupos.put("Jazz", jazz);\r\n\r\n        HashSet<String> todosLosIntegrantes = obtenerTodosLosNombres(grupos);\r\n\r\n        System.out.println("Lista unica de integrantes: "+ todosLosIntegrantes);\r\n    }\r\n\r\n    public static HashSet<String> obtenerTodosLosNombres(HashMap<String, HashSet<String>> mapaGrupos){\r\n        HashSet<String> unificados = new HashSet<>();\r\n\r\n        for (HashSet<String> grupo : mapaGrupos.values()){\r\n            unificados.addAll(grupo);\r\n        }\r\n\r\n        return unificados;\r\n    }\r\n}	\N	1	El código es correcto. Implementa la lógica solicitada de manera eficiente utilizando `addAll` para unir los `HashSet` internos en uno solo. Es claro y conciso.	2026-04-30 02:15:27.642147+00	2026-04-30 02:15:27.642147+00	f	\N	\N
f7d72af2-ff3b-461c-98f0-1b2ca42cd156	5727ca21-785d-46fd-9779-2950fbf251f9	a955431a-b9c4-4878-a64b-6874985640ac	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class Utilidades {\r\n\r\n    public static HashSet<String> obtenerUnicos(ArrayList<String> lista) {\r\n        return new HashSet<>(lista);\r\n    }\r\n\r\n}	\N	1	El código es correcto y cumple con los requisitos del problema. Utiliza el constructor de `HashSet` que recibe una `Collection` para un rendimiento óptimo y una sintaxis concisa. La solución es eficiente y clara.	2026-04-30 02:44:00.670645+00	2026-04-30 02:44:00.670645+00	f	\N	\N
7c43ff71-9a39-4c05-a735-a36d5b4bcabe	5727ca21-785d-46fd-9779-2950fbf251f9	4cd7583e-cd70-49d3-8cec-6a2f1052ec7c	\N	\N	import java.util.HashMap;\r\n\r\npublic class Utilidades {\r\n\r\n    public static HashMap<Character, Integer> contarCaracteres(String texto) {\r\n        HashMap<Character, Integer> mapa = new HashMap<>();\r\n\r\n        for (char c : texto.toCharArray()) {\r\n            if (mapa.containsKey(c)) {\r\n                mapa.put(c, mapa.get(c) + 1);\r\n            } else {\r\n                mapa.put(c, 1);\r\n            }\r\n        }\r\n\r\n        return mapa;\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica propuesta en la rúbrica y maneja adecuadamente la iteración y actualización del HashMap. Es claro y conciso.	2026-04-30 02:44:02.395488+00	2026-04-30 02:44:02.395488+00	f	\N	\N
0143ada8-c747-4744-ae8c-913a06309077	5727ca21-785d-46fd-9779-2950fbf251f9	9a4435b4-6202-4f18-89d3-175f863e083f	\N	\N	import java.util.HashSet;\r\n\r\npublic class Utilidades {\r\n\r\n    public static HashSet<Integer> interseccion(HashSet<Integer> set1, HashSet<Integer> set2) {\r\n        // Creamos una copia para no modificar el set original\r\n        HashSet<Integer> resultado = new HashSet<>(set1);\r\n\r\n        // Conserva solo los elementos que también están en set2\r\n        resultado.retainAll(set2);\r\n\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es conciso y correcto. La utilización de `retainAll()` es una forma eficiente y idiomática de encontrar la intersección de dos conjuntos en Java. El manejo de la creación de una copia del primer conjunto para no modificar los originales es un buen detalle.	2026-04-30 02:44:05.045038+00	2026-04-30 02:44:05.045038+00	f	\N	\N
266210a6-748d-49bf-9359-8b9d30faf8f8	5727ca21-785d-46fd-9779-2950fbf251f9	a00d551e-3dc4-4966-b9f0-b05cbe043e99	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\nimport java.util.HashSet;\r\n\r\npublic class Utilidades {\r\n\r\n    public static HashSet<String> obtenerNombresUnicos(ArrayList<HashMap<String, String>> lista) {\r\n        HashSet<String> resultado = new HashSet<>();\r\n\r\n        for (HashMap<String, String> mapa : lista) {\r\n            if (mapa != null && mapa.containsKey("nombre")) {\r\n                String nombre = mapa.get("nombre");\r\n                if (nombre != null) {\r\n                    resultado.add(nombre);\r\n                }\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es correcto, sigue todos los puntos de la rúbrica, es claro y maneja bien los casos borde como mapas nulos, nombres nulos y mapas sin la clave 'nombre'.	2026-04-30 02:44:06.924893+00	2026-04-30 02:44:06.924893+00	f	\N	\N
35e67425-b96e-482b-b746-be54409dcb4f	5727ca21-785d-46fd-9779-2950fbf251f9	4f2c49bf-48cb-4619-bcd7-b9cfa1e16d4b	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\n\r\npublic class Utilidades {\r\n\r\n    public static int sumarValores(HashMap<String, ArrayList<Integer>> mapa, String clave) {\r\n        if (!mapa.containsKey(clave)) {\r\n            return 0;\r\n        }\r\n\r\n        ArrayList<Integer> lista = mapa.get(clave);\r\n\r\n        if (lista == null || lista.isEmpty()) {\r\n            return 0;\r\n        }\r\n\r\n        int suma = 0;\r\n        for (Integer num : lista) {\r\n            if (num != null) { \r\n                suma += num;\r\n            }\r\n        }\r\n\r\n        return suma;\r\n    }\r\n}	\N	1	El código es correcto. Maneja adecuadamente los casos en los que la clave no existe, la lista es nula o vacía, y suma correctamente los valores. También considera elementos nulos dentro de la lista, lo cual es una buena práctica. La estructura general es clara y fácil de entender.	2026-04-30 02:44:09.505547+00	2026-04-30 02:44:09.505547+00	f	\N	\N
bf4b8d02-9b7e-420d-b195-985e85d394a0	5727ca21-785d-46fd-9779-2950fbf251f9	f2764063-b03d-4d0b-aada-3e7ffdf1ab51	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class Utilidades {\r\n\r\n    public static ArrayList<String> filtrarAutorizados(\r\n            ArrayList<String> personas,\r\n            HashSet<String> autorizados) {\r\n\r\n        ArrayList<String> resultado = new ArrayList<>();\r\n\r\n        for (String persona : personas) {\r\n            if (autorizados.contains(persona)) {\r\n                resultado.add(persona);\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es correcto, sigue al pie de la letra la rúbrica, no tiene errores de compilación ni de lógica. Es claro y maneja correctamente los casos borde, como listas vacías o sets vacíos. La eficiencia es buena al usar `contains` en un `HashSet`.	2026-04-30 02:44:13.081844+00	2026-04-30 02:44:13.081844+00	f	\N	\N
78d18a96-a0a3-4d76-a19c-0c62ac97604a	5727ca21-785d-46fd-9779-2950fbf251f9	56c3eeba-b046-424f-9989-45cce139e191	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\n\r\npublic class Main {\r\n    public static void main(String[] args) {\r\n\r\n        // Crear el HashMap\r\n        HashMap<String, ArrayList<String>> ciudades = new HashMap<>();\r\n\r\n        // Crear listas de personas por ciudad\r\n        ArrayList<String> bogota = new ArrayList<>();\r\n        bogota.add("Juan");\r\n        bogota.add("Maria");\r\n\r\n        ArrayList<String> medellin = new ArrayList<>();\r\n        medellin.add("Carlos");\r\n        medellin.add("Ana");\r\n\r\n        ArrayList<String> cali = new ArrayList<>();\r\n        cali.add("Luis");\r\n        cali.add("Sofia");\r\n\r\n        // Asociar ciudades con personas\r\n        ciudades.put("Bogotá", bogota);\r\n        ciudades.put("Medellín", medellin);\r\n        ciudades.put("Cali", cali);\r\n\r\n        String ciudadBuscada = "Bogotá";\r\n\r\n        if (ciudades.containsKey(ciudadBuscada)) {\r\n            System.out.println("Personas que viven en " + ciudadBuscada + ":");\r\n\r\n            for (String persona : ciudades.get(ciudadBuscada)) {\r\n                System.out.println("- " + persona);\r\n            }\r\n        } else {\r\n            System.out.println("La ciudad no está en el mapa.");\r\n        }\r\n    }\r\n}	\N	1	El código es correcto, sigue la rubrica y maneja bien el caso de que la ciudad no sea encontrada. Es claro, conciso y funcional.	2026-04-30 02:44:11.118077+00	2026-04-30 02:44:11.118077+00	f	\N	\N
2bcd16fd-1b5b-4c3a-b8b3-0a1b57866357	5727ca21-785d-46fd-9779-2950fbf251f9	5e4e5088-18de-40bd-8206-6f6d37ae4e94	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class Utilidades {\r\n\r\n    public static HashSet<Integer> mayoresQue(ArrayList<Integer> lista, int limite) {\r\n        HashSet<Integer> resultado = new HashSet<>();\r\n\r\n        for (Integer num : lista) {\r\n            if (num != null && num > limite) {\r\n                resultado.add(num);\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es correcto y cumple con todos los requisitos del enunciado. Inicializa el `HashSet`, itera sobre el `ArrayList`, verifica la condición y añade los elementos correspondientes. Además, maneja el caso de `null` en el `ArrayList` que es una buena práctica.	2026-04-30 02:44:17.364618+00	2026-04-30 02:44:17.364618+00	f	\N	\N
0a682732-ce43-4bf6-a61d-0496892098a4	5727ca21-785d-46fd-9779-2950fbf251f9	38d231f4-4a55-48e5-a5ee-5ca9eab80d57	\N	\N	import java.util.HashMap;\r\nimport java.util.HashSet;\r\n\r\npublic class Utilidades {\r\n\r\n    public static HashSet<String> obtenerPersonasUnicas(\r\n            HashMap<String, HashSet<String>> grupos) {\r\n\r\n        HashSet<String> resultado = new HashSet<>();\r\n\r\n        if (grupos == null) return resultado;\r\n\r\n        for (HashSet<String> personas : grupos.values()) {\r\n            if (personas != null) {\r\n                resultado.addAll(personas); // agrega todos evitando duplicados\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es correcto y cumple con todos los requisitos. Incluye un manejo adecuado del caso de entrada nula.	2026-04-30 02:44:19.311784+00	2026-04-30 02:44:19.311784+00	f	\N	\N
6a931677-7605-4cfc-9598-cd6f83dd012e	7b14d839-a306-4f18-b894-3a2e8f40f4bb	a955431a-b9c4-4878-a64b-6874985640ac	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class Veterinaria {\r\n\r\n    public static HashSet<String> obtenerUnicos(ArrayList<String> lista) {\r\n        return new HashSet<>(lista);\r\n    }\r\n\r\n    public static void main(String[] args) {\r\n\r\n        ArrayList<String> nombres = new ArrayList<>();\r\n        nombres.add("Luna");\r\n        nombres.add("Max");\r\n        nombres.add("Luna");\r\n        nombres.add("Rocky");\r\n\r\n        HashSet<String> unicos = obtenerUnicos(nombres);\r\n\r\n        System.out.println(unicos);\r\n    }\r\n}	\N	1	El código es correcto y cumple con la rúbrica. Utiliza de forma eficiente el constructor de `HashSet` que recibe una `Collection`, lo cual simplifica el código y es una buena práctica. La lógica es impecable, maneja los tipos de datos correctamente y el caso borde de elementos duplicados se resuelve intrínsecamente por la naturaleza del `HashSet`. La claridad del código es excelente.	2026-04-30 03:25:14.639969+00	2026-04-30 03:25:14.639969+00	f	\N	\N
9bb59574-5418-4901-84d7-4c749fae57e9	7b14d839-a306-4f18-b894-3a2e8f40f4bb	4cd7583e-cd70-49d3-8cec-6a2f1052ec7c	\N	\N	import java.util.HashMap;\r\n\r\npublic class veterinaria {\r\n\r\npublic static HashMap<Character, Integer> contarCaracteres(String texto) {\r\n    HashMap<Character, Integer> mapa = new HashMap<>();\r\n\r\n    for (int i = 0; i < texto.length(); i++) {\r\n        char c = texto.charAt(i);\r\n\r\n        // Si ya existe, suma 1; si no, inicia en 1\r\n        mapa.put(c, mapa.getOrDefault(c, 0) + 1);\r\n    }\r\n\r\n    return mapa;\r\n}\r\npublic static void main(String[] args) {\r\n    String palabra = "veterinaria";\r\n\r\n    HashMap<Character, Integer> resultado = contarCaracteres(palabra);\r\n\r\n    System.out.println(resultado);\r\n}\r\n}	\N	1	La solución es correcta. Implementa la lógica de manera eficiente utilizando `getOrDefault` para manejar la suma o inicialización del contador de caracteres. También incluye un `main` para probar la función, lo cual es útil.	2026-04-30 03:25:16.756404+00	2026-04-30 03:25:16.756404+00	f	\N	\N
e7d7122a-0f79-4119-adc0-077a3ce462c9	7b14d839-a306-4f18-b894-3a2e8f40f4bb	9a4435b4-6202-4f18-89d3-175f863e083f	\N	\N	import java.util.HashSet;\r\npublic class veterinaria {\r\n    public static void main(String[] args) {\r\n        HashSet<Integer> set1 = new HashSet<>();\r\n        set1.add(1);\r\n        set1.add(2);\r\n        set1.add(3);\r\n\r\n        HashSet<Integer> set2 = new HashSet<>();\r\n        set2.add(2);\r\n        set2.add(3);\r\n        set2.add(4);\r\n\r\n        HashSet<Integer> resultado = interseccion(set1, set2);\r\n        System.out.println("Intersección: " + resultado); \r\n    }\r\npublic static HashSet<Integer> interseccion(HashSet<Integer> set1, HashSet<Integer> set2) {\r\n    HashSet<Integer> resultado = new HashSet<>(set1); \r\n    resultado.retainAll(set2); \r\n    return resultado;\r\n}\r\n}	\N	1	El código es correcto y cumple con la funcionalidad solicitada. Utiliza el método `retainAll` de forma eficiente para encontrar la intersección, lo cual es una solución elegante. La estructura del programa es correcta y se incluyen ejemplos de uso que facilitan la comprensión.	2026-04-30 03:25:18.833494+00	2026-04-30 03:25:18.833494+00	f	\N	\N
017502d7-4ac0-4f85-b6fe-83dbc15dfec0	7b14d839-a306-4f18-b894-3a2e8f40f4bb	a00d551e-3dc4-4966-b9f0-b05cbe043e99	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\nimport java.util.HashSet;\r\n\r\npublic class Main {\r\n\r\n    public static void main(String[] args) {\r\n\r\n        ArrayList<HashMap<String, String>> lista = new ArrayList<>();\r\n\r\n        HashMap<String, String> m1 = new HashMap<>();\r\n        m1.put("nombre", "Luna");\r\n\r\n        HashMap<String, String> m2 = new HashMap<>();\r\n        m2.put("nombre", "Max");\r\n\r\n        HashMap<String, String> m3 = new HashMap<>();\r\n        m3.put("otro", "dato"); \r\n\r\n        HashMap<String, String> m4 = new HashMap<>();\r\n        m4.put("nombre", "Luna"); \r\n\r\n        lista.add(m1);\r\n        lista.add(m2);\r\n        lista.add(m3);\r\n        lista.add(m4);\r\n\r\n        HashSet<String> resultado = obtenerNombresUnicos(lista);\r\n\r\n        System.out.println(resultado);\r\n    }\r\n\r\n    \r\n    public static HashSet<String> obtenerNombresUnicos(ArrayList<HashMap<String, String>> lista) {\r\n        HashSet<String> nombres = new HashSet<>();\r\n\r\n        for (HashMap<String, String> mapa : lista) {\r\n            if (mapa.containsKey("nombre")) {\r\n                String valor = mapa.get("nombre");\r\n                if (valor != null && !valor.isEmpty()) {\r\n                    nombres.add(valor);\r\n                }\r\n            }\r\n        }\r\n\r\n        return nombres;\r\n    }\r\n}\r\n\r\n    return nombres;\r\n}	\N	1	El código del estudiante es impecable. Sigue todas las directrices de la rúbrica y maneja los casos borde (valores null o vacíos para la clave 'nombre') adecuadamente, lo que demuestra un pensamiento robusto. El uso del método `main` para probar exhaustivamente la solución es una práctica excelente.	2026-04-30 03:25:21.013237+00	2026-04-30 03:25:21.013237+00	f	\N	\N
154b9314-fc0d-4aa8-acec-001e7e02d8ec	7b14d839-a306-4f18-b894-3a2e8f40f4bb	4f2c49bf-48cb-4619-bcd7-b9cfa1e16d4b	\N	\N	import java.util.HashMap;\r\nimport java.util.ArrayList;\r\n\r\npublic class Ejercicio {\r\n\r\n    public static void main(String[] args) {\r\n\r\n        HashMap<String, ArrayList<Integer>> datos = new HashMap<>();\r\n\r\n        ArrayList<Integer> listaVentas = new ArrayList<>();\r\n        listaVentas.add(10);\r\n        listaVentas.add(20);\r\n        listaVentas.add(30);\r\n\r\n        ArrayList<Integer> listaVacia = new ArrayList<>();\r\n\r\n        ArrayList<Integer> listaGastos = new ArrayList<>();\r\n        listaGastos.add(5);\r\n        listaGastos.add(15);\r\n\r\n        datos.put("ventas", listaVentas);\r\n        datos.put("vacio", listaVacia);\r\n        datos.put("gastos", listaGastos);\r\n\r\n        System.out.println("Suma ventas: " + sumarLista(datos, "ventas"));\r\n        System.out.println("Suma vacio: " + sumarLista(datos, "vacio"));\r\n        System.out.println("Suma gastos: " + sumarLista(datos, "gastos"));\r\n        System.out.println("Suma inexistente: " + sumarLista(datos, "otro"));\r\n    }\r\n\r\n    public static int sumarLista(HashMap<String, ArrayList<Integer>> mapa, String clave) {\r\n\r\n        if (!mapa.containsKey(clave) || mapa.get(clave).isEmpty()) {\r\n            return 0;\r\n        }\r\n\r\n        int suma = 0;\r\n        for (int num : mapa.get(clave)) {\r\n            suma += num;\r\n        }\r\n\r\n        return suma;\r\n    }\r\n}	\N	1	El código es correcto y cumple con todos los requisitos del enunciado. Maneja adecuadamente los casos de clave inexistente y ArrayList vacío o nulo (aunque este último se simplifica al usar `.isEmpty()` que ya lo considera). La lógica es clara y el código compila y funciona correctamente. Una pequeña mejora podría ser verificar si `mapa.get(clave)` devuelve `null` explícitamente antes de llamar a `.isEmpty()`, aunque en este contexto `isEmpty()` ya lo maneja al ser llamado sobre un posible `null` que produciría un `NullPointerException` si no se considera (`mapa.get(clave)` devuelve `null` si la clave no existe, lo cual es manejado por `containsKey`).	2026-04-30 03:25:23.856986+00	2026-04-30 03:25:23.856986+00	f	\N	\N
db6be866-e2cd-4597-91eb-a463c7475400	7b14d839-a306-4f18-b894-3a2e8f40f4bb	8c015875-9c49-4b49-90ab-fff19b1b73af	\N	\N	import java.util.HashMap;\r\nimport java.util.ArrayList;\r\n\r\npublic class Main {\r\n\r\n    public static void main(String[] args) {\r\n\r\n        HashMap<Integer, String> mapa = new HashMap<>();\r\n        mapa.put(1, "Luna");\r\n        mapa.put(2, "Max");\r\n        mapa.put(3, "Rocky");\r\n\r\n        ArrayList<String> valores = obtenerValores(mapa);\r\n\r\n        System.out.println(valores);\r\n    }\r\n\r\n    public static ArrayList<String> obtenerValores(HashMap<Integer, String> mapa) {\r\n        return new ArrayList<>(mapa.values());\r\n    }\r\n}	\N	1	El código es correcto, conciso y eficiente. Cumple con todos los requisitos del enunciado y la rúbrica, inicializando un ArrayList con los valores del HashMap. Además, la función `main` demuestra su uso con un ejemplo claro.	2026-04-30 03:25:30.382555+00	2026-04-30 03:25:30.382555+00	f	\N	\N
b8b3b75d-c8f3-4624-9e95-6032e9c5cce4	7b14d839-a306-4f18-b894-3a2e8f40f4bb	56c3eeba-b046-424f-9989-45cce139e191	\N	\N	import java.util.HashMap;\r\nimport java.util.ArrayList;\r\n\r\npublic class CiudadesPersonas {\r\n\r\n    public static void main(String[] args) {\r\n\r\n        HashMap<String, ArrayList<String>> mapa = new HashMap<>();\r\n\r\n        ArrayList<String> bogota = new ArrayList<>();\r\n        bogota.add("Juan");\r\n        bogota.add("Maria");\r\n        bogota.add("Carlos");\r\n\r\n        ArrayList<String> medellin = new ArrayList<>();\r\n        medellin.add("Ana");\r\n        medellin.add("Luis");\r\n\r\n        ArrayList<String> cali = new ArrayList<>();\r\n        cali.add("Pedro");\r\n\r\n        // 🔥 Guardamos en minúscula\r\n        mapa.put("bogota", bogota);\r\n        mapa.put("medellin", medellin);\r\n        mapa.put("cali", cali);\r\n\r\n        // 🔥 Consulta también en minúscula\r\n        String ciudadBuscada = "Bogota".toLowerCase().trim();\r\n\r\n        if (mapa.containsKey(ciudadBuscada)) {\r\n\r\n            ArrayList<String> personas = mapa.get(ciudadBuscada);\r\n\r\n            if (personas.isEmpty()) {\r\n                System.out.println("No hay personas registradas en " + ciudadBuscada);\r\n            } else {\r\n                System.out.println("Personas en " + ciudadBuscada + ":");\r\n                for (String persona : personas) {\r\n                    System.out.println(persona);\r\n                }\r\n            }\r\n\r\n        } else {\r\n            System.out.println("La ciudad no existe en el sistema.");\r\n        }\r\n    }\r\n}	\N	1	El código es correcto, sigue todas las instrucciones del enunciado y la rúbrica. Además, considera un caso borde importante como el formato de la ciudad buscada, lo que demuestra un buen nivel de detalle. El uso de `toLowerCase()` y `trim()` tanto al guardar como al buscar la ciudad es una excelente práctica para evitar errores de coincidencia.	2026-04-30 03:25:25.989722+00	2026-04-30 03:25:25.989722+00	f	\N	\N
cbb04a92-7461-442b-b3e8-c0ca517eb6e1	7b14d839-a306-4f18-b894-3a2e8f40f4bb	5e4e5088-18de-40bd-8206-6f6d37ae4e94	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class Main {\r\n\r\n    public static void main(String[] args) {\r\n\r\n        ArrayList<Integer> numeros = new ArrayList<>();\r\n        numeros.add(5);\r\n        numeros.add(10);\r\n        numeros.add(15);\r\n        numeros.add(20);\r\n        numeros.add(10); // duplicado\r\n\r\n        int limite = 10;\r\n\r\n        HashSet<Integer> resultado = mayoresQue(numeros, limite);\r\n\r\n        System.out.println(resultado);\r\n    }\r\n\r\n    public static HashSet<Integer> mayoresQue(ArrayList<Integer> lista, int limite) {\r\n        HashSet<Integer> resultado = new HashSet<>();\r\n\r\n        for (int num : lista) {\r\n            if (num > limite) {\r\n                resultado.add(num);\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica propuesta en la rúbrica y maneja los casos esperados.  La inclusión de un método `main` con un ejemplo es un buen extra que demuestra el funcionamiento.	2026-04-30 03:25:32.099458+00	2026-04-30 03:25:32.099458+00	f	\N	\N
05451e60-0fa1-46fc-b839-e786775ddbf3	7b14d839-a306-4f18-b894-3a2e8f40f4bb	f2764063-b03d-4d0b-aada-3e7ffdf1ab51	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class Main {\r\n\r\n    public static void main(String[] args) {\r\n\r\n        ArrayList<String> lista = new ArrayList<>();\r\n        lista.add("Juan");\r\n        lista.add("Maria");\r\n        lista.add("Carlos");\r\n        lista.add("Ana");\r\n\r\n        HashSet<String> autorizados = new HashSet<>();\r\n        autorizados.add("Maria");\r\n        autorizados.add("Ana");\r\n\r\n        ArrayList<String> resultado = filtrarAutorizados(lista, autorizados);\r\n\r\n        System.out.println(resultado);\r\n    }\r\n\r\n    public static ArrayList<String> filtrarAutorizados(\r\n            ArrayList<String> nombres,\r\n            HashSet<String> autorizados) {\r\n\r\n        ArrayList<String> resultado = new ArrayList<>();\r\n\r\n        for (String nombre : nombres) {\r\n            if (autorizados.contains(nombre)) {\r\n                resultado.add(nombre);\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es funcionalmente correcto, cumple con la rúbrica y demuestra un buen entendimiento del uso de `ArrayList` y `HashSet` en Java. La lógica es clara y el manejo de casos borde (como listas vacías o sin coincidencias) sería correcto. Además, el estudiante incluyó un método `main` para probar un ejemplo, lo cual es muy útil para verificar la funcionalidad.	2026-04-30 03:25:28.423153+00	2026-04-30 03:25:28.423153+00	f	\N	\N
9ac6d448-d637-4747-a073-656ab293b617	7b14d839-a306-4f18-b894-3a2e8f40f4bb	38d231f4-4a55-48e5-a5ee-5ca9eab80d57	\N	\N	import java.util.HashMap;\r\nimport java.util.HashSet;\r\n\r\npublic class Main {\r\n\r\n    public static void main(String[] args) {\r\n\r\n        HashMap<String, HashSet<String>> grupos = new HashMap<>();\r\n\r\n        HashSet<String> grupoA = new HashSet<>();\r\n        grupoA.add("Juan");\r\n        grupoA.add("Maria");\r\n\r\n        HashSet<String> grupoB = new HashSet<>();\r\n        grupoB.add("Carlos");\r\n        grupoB.add("Maria"); // repetido\r\n\r\n        HashSet<String> grupoC = new HashSet<>();\r\n        grupoC.add("Ana");\r\n\r\n        grupos.put("Grupo A", grupoA);\r\n        grupos.put("Grupo B", grupoB);\r\n        grupos.put("Grupo C", grupoC);\r\n\r\n        HashSet<String> resultado = obtenerPersonasUnicas(grupos);\r\n\r\n        System.out.println(resultado);\r\n    }\r\n\r\n    public static HashSet<String> obtenerPersonasUnicas(\r\n            HashMap<String, HashSet<String>> grupos) {\r\n\r\n        HashSet<String> resultado = new HashSet<>();\r\n\r\n        for (HashSet<String> personas : grupos.values()) {\r\n            resultado.addAll(personas);\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es correcto, cumple con los requisitos del enunciado y la rúbrica. La lógica es clara y maneja correctamente los casos de nombres repetidos al usar `HashSet`.	2026-04-30 03:25:34.193561+00	2026-04-30 03:25:34.193561+00	f	\N	\N
19f683f8-0072-4ede-8fef-adcdd7ec6fc6	e2edb38f-43fc-434d-b5cf-76a1e8a73880	a955431a-b9c4-4878-a64b-6874985640ac	\N	\N	public class Hash[\r\n\r\n    public HashSet<String> calcularValorTotal(ArrayList<String>lista) {\r\n        return new HasSet<>(lista);\r\n    }\r\n]	\N	0.4	El código tiene errores de sintaxis (llaves no balanceadas, y un error tipográfico en `HasSet` en lugar de `HashSet`). Además, el nombre del método `calcularValorTotal` no es descriptivo para la tarea de obtener elementos únicos. Sin embargo, la lógica de inicializar un `HashSet` directamente con un `ArrayList` es una forma concisa y correcta de obtener elementos únicos si se corrigieran los errores.	2026-04-30 04:53:48.199833+00	2026-04-30 04:53:48.199833+00	f	\N	\N
dec0677c-46c9-47f1-ae45-85e0c4d6f9e1	e2edb38f-43fc-434d-b5cf-76a1e8a73880	4cd7583e-cd70-49d3-8cec-6a2f1052ec7c	\N	\N	public class Hash{\r\n\r\n   public HashMap<Character, Integer> contarCaracteres (String texto){\r\n\r\n    HashMap <Character , Integer > mapa = new HashMap<>();\r\n\r\n    for(char letra : texto.toCharArray()) {\r\n        if (mapa.containsKey(letra)) {\r\n            mapa.put(letra,mapa.get(letra)+ 1);\r\n\r\n        }else {\r\n            mapa.put(letra, 1);\r\n        }\r\n    }\r\n    return mapa;\r\n   }\r\n\r\n   \r\n}	\N	1	La solución es correcta y cumple con todos los requisitos. El código es claro, eficiente y maneja adecuadamente los caracteres del `String` para contarlos en el `HashMap`.	2026-04-30 04:53:50.191464+00	2026-04-30 04:53:50.191464+00	f	\N	\N
40dc8350-0484-4f5c-ad3d-b6b5214d58e7	e2edb38f-43fc-434d-b5cf-76a1e8a73880	9a4435b4-6202-4f18-89d3-175f863e083f	\N	\N	public Hash{\r\n\r\n    public HashSet<Integer> interseccion(HashSet<integer> setA, HashSet<Integer> setB){\r\n        HashSet<Integer> igual = new HashSet<>();\r\n\r\n        for(int numero : setA) {\r\n            if (setB.contains(numero)){\r\n                igual.add(numero);\r\n            }\r\n        }\r\n        return igual;\r\n    }\r\n}	\N	0.7	El código es funcionalmente correcto y sigue la lógica esperada para encontrar la intersección de dos conjuntos. Sin embargo, tiene un error de sintaxis al inicio (`public Hash{`) que impide que compile. Si se corrige esto, el código sería casi perfecto. Se pudo haber utilizado el método `retainAll` para una solución más concisa, pero la implementación manual es válida según la rúbrica.	2026-04-30 04:53:52.443728+00	2026-04-30 04:53:52.443728+00	f	\N	\N
3441f672-8a8f-4756-beda-ef5f44ab8b77	e2edb38f-43fc-434d-b5cf-76a1e8a73880	a00d551e-3dc4-4966-b9f0-b05cbe043e99	\N	\N	public class Hash{\r\n\r\n    public HashSet<String> obtenerNombres(ArrayList<HashMap<String, String>>lista){\r\n        HashSet<String>nombres = new hashSet<>();\r\n\r\n        for(HashMap<String,String>mapa : lista){\r\n            if(mapa.containsKey("nombre")) {\r\n                nombre.add(mapa.get("nombre"));\r\n            }\r\n        }\r\n        return nombres;\r\n    }\r\n}	\N	0.7	El código es casi correcto. Hay un pequeño error de tipeo en la línea `nombre.add(mapa.get("nombre"));` donde debería ser `nombres.add(mapa.get("nombre"));` para que compile y funcione correctamente. Además, la inicialización de `HashSet` en `hashSet<>()` debería ser `new HashSet<>()`. El código es claro y sigue la lógica esperada, considerando el caso de que la clave 'nombre' no exista. Sin estos errores, el puntaje sería 1.	2026-04-30 04:53:54.653793+00	2026-04-30 04:53:54.653793+00	f	\N	\N
6be1f4c7-f845-4137-938c-badc8e585ca2	e2edb38f-43fc-434d-b5cf-76a1e8a73880	4f2c49bf-48cb-4619-bcd7-b9cfa1e16d4b	\N	\N	public class Hash{\r\n\r\n    public int sumarValores(HashMap<String, ArrayList<Integer>>mapa,String clave){\r\n        if(!mapa.containsKey(clave) || mapa.get(clave).isEmpty()){\r\n            return 0;\r\n        }\r\n        int suma = 0;\r\n        for(int numero: mapa.get(clave)){\r\n            suma += numero;\r\n        }\r\n        return suma;\r\n    }\r\n}	\N	0.9	El código es funcionalmente correcto y cumple con los requisitos del problema. Maneja adecuadamente el caso de que la clave no exista o el ArrayList esté vacío. Sin embargo, hay un pequeño detalle en la línea `mapa.get(clave).isEmpty()`. Si `mapa.get(clave)` devuelve `null` (lo cual es posible si la clave existe pero el valor asociado es null), se producirá un `NullPointerException`. Sería más robusto verificar primero si `mapa.get(clave) == null` antes de llamar `isEmpty()`.	2026-04-30 04:53:56.754912+00	2026-04-30 04:53:56.754912+00	f	\N	\N
826bd969-11a9-4f4e-a525-a1101aa042f7	e2edb38f-43fc-434d-b5cf-76a1e8a73880	f2764063-b03d-4d0b-aada-3e7ffdf1ab51	\N	\N	public class Hash{\r\n\r\n    public ArrayList<String> filtrarAutorizados(ArrayList<String>personas,HashSet<String>autorizados){\r\n        ArrayList<String> resultado = new ArrayList<>();\r\n        for(String persona : personas){\r\n            if (autorizados.contains(persona)) {\r\n                resultado.add(persona);\r\n            }\r\n        }\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es correcto y cumple con todos los requisitos de la rúbrica. Es claro, conciso y maneja adecuadamente las estructuras de datos. No se encontraron errores de compilación ni lógicos.	2026-04-30 04:54:01.55629+00	2026-04-30 04:54:01.55629+00	f	\N	\N
a381a94f-8efa-4f1d-97e7-97b1d23e5090	e2edb38f-43fc-434d-b5cf-76a1e8a73880	8c015875-9c49-4b49-90ab-fff19b1b73af	\N	\N	Hashmap<Integer, String > mapa = new HashMap<>();\r\nmapa.put(1, "Miguel");\r\nmapa.put(2, "Ana");\r\nmapa.put(3, "Claudia");\r\nmapa.put(4, "Pablo");\r\n\r\nSystem.out.println(obtenerValores(mapa));	\N	0.2	El estudiante no ha proporcionado la función que se pide, solo un ejemplo de uso. Sin embargo, el ejemplo es correcto en su inicialización y adición de elementos al HashMap, y la llamada a la función es la esperada.	2026-04-30 04:54:03.207248+00	2026-04-30 04:54:03.207248+00	f	\N	\N
d75c121e-8420-4466-abaa-bcde193d6b31	e2edb38f-43fc-434d-b5cf-76a1e8a73880	56c3eeba-b046-424f-9989-45cce139e191	\N	\N	import java.util.HashMap;\r\nimport java.util.ArrayList;\r\n\r\npublic class Hash{\r\n\r\npublic static void personasCitadinas(HashMap<String, ArrayList<String>>ciudades, String ciudad){\r\n\r\n    if (!ciudades.containsKey(ciudad)){\r\n        System.out.println("NO HAY REGISTROS PARA:" + ciudad);\r\n        return;\r\n    }\r\n    ArrayList<String>personas = ciudades.get(ciudad);\r\n\r\n    if(personas.isEmpty()){\r\n        System.out.println(ciudad + "NO TIENE PERSONAS REGISTRADAS.");\r\n        return;\r\n    }\r\n    System.out.println("PERSONAS EN " + ciudad + ":");\r\n    for (String persona: personas){\r\n        System.out.println(" -" + persona);\r\n    }\r\n}\r\npublic static void main (string [ args]){\r\n\r\n    HashMap<String, ArrayList<String>>ciudades = new HashMap<>();\r\n\r\n    ciudades.put("Cali", new ArrayList<>(Arrays.asList("Miguel","Claudia","Ana")));\r\n    ciudades.put("Bogota", new ArrayList<>(Arrays.asList("Pablo","Sofia","Andres")));\r\n    ciudades.put("Medellin", new ArrayList<>(Arrays.asList("Laura","Camilo",)));\r\n    ciudades.put("Palmira", new ArrayList<>());\r\n\r\n    personasCitadinas(ciudades,"Cali");\r\n    System.out.println();\r\n     personasCitadinas(ciudades,"Bogota");\r\n    System.out.println();\r\n     personasCitadinas(ciudades,"Palmira");\r\n    System.out.println();\r\n     personasCitadinas(ciudades,"Cartagena");\r\n    System.out.println();\r\n\r\n}\r\n\r\n}	\N	0.7	El código es funcional y cumple con la mayoría de los requisitos. Sin embargo, hay un error de compilación crítico relacionado con `Arrays.asList` que debe ser corregido para obtener la máxima puntuación. Además, el `main` debería tener la primera letra de `String` en mayúscula. El manejo de un ArrayList vacío es correcto.	2026-04-30 04:53:59.323764+00	2026-04-30 04:53:59.323764+00	f	\N	\N
e5acbcba-50ed-48bf-825b-10c56653cebe	e2edb38f-43fc-434d-b5cf-76a1e8a73880	5e4e5088-18de-40bd-8206-6f6d37ae4e94	\N	\N	public Hash{\r\n\r\n    publlic HashSet<Integer> filtrarMayores(ArrayList<Integer> numeros , int limite){\r\n        HashSet<Integer> resultado = new HashSet <>();\r\n\r\n        for(int numero : numeros) {\r\n            if (numero > limite) {\r\n                resultado.add(numero);\r\n            }\r\n        }\r\n        return resultado;\r\n    }\r\n}	\N	0.7	El código es funcionalmente correcto. Sin embargo, no compilaría debido a un error de sintaxis al inicio (le falta `Set` o un nombre de clase adecuado) y a un error tipográfico en `public` (`publlic`). La lógica para filtrar y añadir elementos al `HashSet` es correcta y cumple con los requisitos del enunciado.	2026-04-30 04:54:05.356432+00	2026-04-30 04:54:05.356432+00	f	\N	\N
e5724ec8-950b-4196-8a3d-2ef00c72a7a4	e2edb38f-43fc-434d-b5cf-76a1e8a73880	38d231f4-4a55-48e5-a5ee-5ca9eab80d57	\N	\N	public class Hash{\r\n\r\n    public static Hashset<String> obtenerPersonasUnicas(HashMap<String, HashSet<String>>grupos){\r\n        HashSet<String> resultado = new HashSet<>();\r\n\r\n        for(HashSet<String> personas : grupos.values()){\r\n            resultado.addAll (personas);\r\n        }\r\n        return resultado;\r\n    }\r\n    public static void main (String[] args){\r\n\r\n        HashMap<String, HashSet<String>> grupos = new HashMap<>();\r\n\r\n        grupos.put("Equipo A", new HashSet<>(Arrays.asList("Miguel","Ana", "Claudia")));\r\n         grupos.put("Equipo B", new HashSet<>(Arrays.asList("Pablo","Ana", "Laura")));\r\n          grupos.put("Equipo C", new HashSet<>(Arrays.asList("Miguel","Camilo")));\r\n\r\n          System.out.println(obtenerPersonasUnicas(grupos));\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica propuesta en el enunciado y maneja eficientemente el almacenamiento de nombres únicos utilizando `HashSet`. Compila y funciona como se esperaba. La inclusión de un método `main` para probar la función es un buen añadido.	2026-04-30 04:54:08.046765+00	2026-04-30 04:54:08.046765+00	f	\N	\N
498323ee-89b6-4131-a833-2b752ab5dfd9	08d1b215-abbb-49ec-96e8-3210cfb4826f	a955431a-b9c4-4878-a64b-6874985640ac	\N	\N	 \r\n public static HashSet<String> obtenerUnicos(ArrayList<String> lista) {\r\n    return new HashSet<>(lista);\r\n    }	\N	1	El estudiante ha proporcionado una solución concisa y correcta. El constructor de `HashSet` que acepta una `Collection` es la forma más idiomática y eficiente de realizar esta tarea. La solución es totalmente correcta y clara.	2026-04-30 04:59:32.028259+00	2026-04-30 04:59:32.028259+00	f	\N	\N
fe83d9d2-fc71-45d1-b4e8-118369aef9ca	08d1b215-abbb-49ec-96e8-3210cfb4826f	4cd7583e-cd70-49d3-8cec-6a2f1052ec7c	\N	\N	public class  {\r\npublic static HashMap<Character, Integer> contarCaracteres(String texto) {\r\n   HashMap<Character, Integer> mapa = new HashMap<>();\r\n\r\n        for (int i = 0; i < texto.length(); i++) {\r\n            char c = texto.charAt(i);\r\n\r\n            // Si el carácter ya existe, incrementa su contador\r\n            if (mapa.containsKey(c)) {\r\n                mapa.put(c, mapa.get(c) + 1);\r\n            } else {\r\n                // Si no existe, lo agrega con valor 1\r\n                mapa.put(c, 1);\r\n            }\r\n        }\r\n             return mapa;\r\n    }\r\n}	\N	1	El código es correcto y sigue la lógica planteada en la rúbrica. Maneja adecuadamente la iteración sobre el string, la verificación de existencia de la clave en el mapa y la actualización o inserción del contador. Sin embargo, la clase no tiene nombre.	2026-04-30 04:59:34.224626+00	2026-04-30 04:59:34.224626+00	f	\N	\N
12aaeb11-cb71-40df-a33e-33f69f2d9add	08d1b215-abbb-49ec-96e8-3210cfb4826f	9a4435b4-6202-4f18-89d3-175f863e083f	\N	\N	public class  {\r\n       public static HashSet<Integer> interseccion(HashSet<Integer> set1, HashSet<Integer> set2) {\r\n        \r\n\r\n      HashSet<Integer> resultado = new HashSet<>(set1);\r\n\r\n     resultado.retainAll(set2);\r\n\r\n     return resultado;\r\n       \r\n}\r\npublic static void main(String[] args) {\r\n        HashSet<Integer> a = new HashSet<>();\r\n        a.add(1);\r\n        a.add(2);\r\n        a.add(3);\r\n\r\n        HashSet<Integer> b = new HashSet<>();\r\n        b.add(2);\r\n        b.add(3);\r\n        b.add(4);\r\n\r\n        HashSet<Integer> inter = interseccion(a, b);\r\n\r\n        System.out.println("Intersección: " + inter); // [2, 3]\r\n    }\r\n}	\N	1	El código es correcto y cumple con los requisitos del enunciado. Utiliza `retainAll` que es una forma eficiente y concisa de obtener la intersección de dos `HashSet`. La explicación para el usuario (la rúbrica esperada) indicaba iterar, pero esta solución es superior y más idiomática en Java.	2026-04-30 04:59:36.870992+00	2026-04-30 04:59:36.870992+00	f	\N	\N
db6f4e7e-d259-44fe-be9e-643c88f2803c	08d1b215-abbb-49ec-96e8-3210cfb4826f	a00d551e-3dc4-4966-b9f0-b05cbe043e99	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\nimport java.util.HashSet;\r\n\r\npublic class Ejemplo {\r\n\r\n    public static HashSet<String> obtenerNombresUnicos(ArrayList<HashMap<String, String>> lista) {\r\n        HashSet<String> nombresUnicos = new HashSet<>();\r\n\r\n        for (HashMap<String, String> mapa : lista) {\r\n            if (mapa.containsKey("nombre")) {\r\n                String nombre = mapa.get("nombre");\r\n                if (nombre != null) { \r\n                    nombresUnicos.add(nombre);\r\n                }\r\n            }\r\n        }\r\n\r\n        return nombresUnicos;\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica propuesta en la rúbrica y maneja adecuadamente el caso de que el valor asociado a la clave 'nombre' sea nulo. Compila y funciona como se espera.	2026-04-30 04:59:39.337633+00	2026-04-30 04:59:39.337633+00	f	\N	\N
099c4864-26b9-4940-a6f5-78a114bb1d09	08d1b215-abbb-49ec-96e8-3210cfb4826f	4f2c49bf-48cb-4619-bcd7-b9cfa1e16d4b	\N	\N	import java.util.HashMap;\r\nimport java.util.ArrayList;\r\n\r\npublic class  {\r\n\r\n    public static int sumarValores(HashMap<String, ArrayList<Integer>> mapa, String clave) {\r\n        \r\n        if (!mapa.containsKey(clave)) {\r\n            return 0;\r\n        }\r\n\r\n        ArrayList<Integer> lista = mapa.get(clave);\r\n\r\n        \r\n        if (lista == null || lista.isEmpty()) {\r\n            return 0;\r\n        }\r\n\r\n        int suma = 0;\r\n\r\n        \r\n        for (Integer num : lista) {\r\n            if (num != null) { \r\n                suma += num;\r\n            }\r\n        }\r\n\r\n        return suma;\r\n    }\r\n\r\n    \r\n    public static void main(String[] args) {\r\n        HashMap<String, ArrayList<Integer>> mapa = new HashMap<>();\r\n\r\n        ArrayList<Integer> lista = new ArrayList<>();\r\n        lista.add(10);\r\n        lista.add(20);\r\n        lista.add(30);\r\n\r\n        mapa.put("numeros", lista);\r\n\r\n        int resultado = sumarValores(mapa, "numeros");\r\n        System.out.println("Suma: " + resultado); // Suma: 60\r\n    }\r\n}	\N	1	El código es correcto y cumple con todas las especificaciones de la rúbrica. Maneja adecuadamente los casos de clave no existente, lista vacía y elementos nulos en la lista.	2026-04-30 04:59:41.183946+00	2026-04-30 04:59:41.183946+00	f	\N	\N
6b74b2ac-5b33-4053-8b70-dee0c3ce4815	08d1b215-abbb-49ec-96e8-3210cfb4826f	56c3eeba-b046-424f-9989-45cce139e191	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\n\r\npublic class  {\r\n\r\n    public static void main(String[] args) {\r\n\r\n        \r\n        HashMap<String, ArrayList<String>> mapa = new HashMap<>();\r\n\r\n        \r\n        ArrayList<String> personasCali = new ArrayList<>();\r\n        personasCali.add("Juan");\r\n        personasCali.add("Maria");\r\n        personasCali.add("Pedro");\r\n\r\n        ArrayList<String> personasBogota = new ArrayList<>();\r\n        personasBogota.add("Ana");\r\n        personasBogota.add("Luis");\r\n\r\n        ArrayList<String> personasMedellin = new ArrayList<>();\r\n        personasMedellin.add("Carlos");\r\n        personasMedellin.add("Sofia");\r\n\r\n       \r\n        mapa.put("Cali", personasCali);\r\n        mapa.put("Bogota", personasBogota);\r\n        mapa.put("Medellin", personasMedellin);\r\n\r\n        \r\n        String ciudadBuscada = "Cali";\r\n\r\n        \r\n        if (mapa.containsKey(ciudadBuscada)) {\r\n            ArrayList<String> personas = mapa.get(ciudadBuscada);\r\n\r\n            System.out.println("Personas que viven en " + ciudadBuscada + ":");\r\n\r\n            \r\n            for (String persona : personas) {\r\n                System.out.println(persona);\r\n            }\r\n        } else {\r\n            System.out.println("La ciudad no existe en el mapa.");\r\n        }\r\n    }\r\n}	\N	1	El código es correcto y cumple con todos los requisitos del enunciado: declara, inicializa y puebla el `HashMap` correctamente, y luego busca e imprime las personas de una ciudad específica. El manejo de la ciudad no encontrada también es adecuado.	2026-04-30 04:59:43.021013+00	2026-04-30 04:59:43.021013+00	f	\N	\N
9b19c4d1-2023-4bae-bc1d-382766a739f2	75404f12-b06e-473d-b49f-0e2f57881775	38d231f4-4a55-48e5-a5ee-5ca9eab80d57	\N	\N	import java.util.HashMap;\r\nimport java.util.HashSet;\r\n\r\npublic class funcion1 {\r\n\r\n    public static HashSet<String> metodo1(HashMap<String, HashSet<String>> mapa) {\r\n        HashSet<String> resultado = new HashSet<>();\r\n\r\n        for (HashSet<String> grupo : mapa.values()) {\r\n            resultado.addAll(grupo);\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica esperada y no tiene errores. Es conciso y claro.	2026-04-30 22:27:18.771041+00	2026-04-30 22:27:18.771041+00	f	\N	\N
39ff8590-07ed-4531-af70-9953682336b0	08d1b215-abbb-49ec-96e8-3210cfb4826f	f2764063-b03d-4d0b-aada-3e7ffdf1ab51	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class  {\r\n\r\n    public static ArrayList<String> obtenerAutorizados(ArrayList<String> nombres, HashSet<String> autorizados) {\r\n        ArrayList<String> resultado = new ArrayList<>();\r\n\r\n        \r\n        if (nombres == null || autorizados == null) {\r\n            return resultado;\r\n        }\r\n\r\n        for (String nombre : nombres) {\r\n            if (autorizados.contains(nombre)) {\r\n                resultado.add(nombre);\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n\r\n   \r\n    public static void main(String[] args) {\r\n        ArrayList<String> nombres = new ArrayList<>();\r\n        nombres.add("Ana");\r\n        nombres.add("Luis");\r\n        nombres.add("Carlos");\r\n        nombres.add("Ana");\r\n\r\n        HashSet<String> autorizados = new HashSet<>();\r\n        autorizados.add("Ana");\r\n        autorizados.add("Carlos");\r\n\r\n        ArrayList<String> resultado = obtenerAutorizados(nombres, autorizados);\r\n\r\n        System.out.println(resultado); \r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica propuesta en la rúbrica y maneja adecuadamente los casos borde (listas nulas). Además, incluye un método `main` para probar la funcionalidad, lo cual es un plus. Solo hay un detalle, el nombre de la clase está vacio.	2026-04-30 04:59:45.278145+00	2026-04-30 04:59:45.278145+00	f	\N	\N
a8bdd458-4cc2-4e32-b933-456beeb2c5f3	08d1b215-abbb-49ec-96e8-3210cfb4826f	38d231f4-4a55-48e5-a5ee-5ca9eab80d57	\N	\N	import java.util.HashMap;\r\nimport java.util.HashSet;\r\n\r\npublic class  {\r\n\r\n    public static HashSet<String> obtenerPersonasUnicas(HashMap<String, HashSet<String>> grupos) {\r\n        HashSet<String> personasUnicas = new HashSet<>();\r\n\r\n       \r\n        for (HashSet<String> grupo : grupos.values()) {\r\n            if (grupo != null) {\r\n                personasUnicas.addAll(grupo);\r\n            }\r\n        }\r\n\r\n        return personasUnicas;\r\n    }\r\n\r\n    \r\n    public static void main(String[] args) {\r\n        HashMap<String, HashSet<String>> grupos = new HashMap<>();\r\n\r\n        HashSet<String> grupo1 = new HashSet<>();\r\n        grupo1.add("Ana");\r\n        grupo1.add("Luis");\r\n\r\n        HashSet<String> grupo2 = new HashSet<>();\r\n        grupo2.add("Luis");\r\n        grupo2.add("Carlos");\r\n\r\n        grupos.put("Grupo A", grupo1);\r\n        grupos.put("Grupo B", grupo2);\r\n\r\n        HashSet<String> resultado = obtenerPersonasUnicas(grupos);\r\n\r\n        System.out.println(resultado); \r\n    }\r\n}	\N	1	El código es correcto, cumple con los requisitos del enunciado y la rúbrica. Maneja adecuadamente el caso de `HashSet` nulos dentro del `HashMap` y la lógica es clara.	2026-04-30 04:59:51.83582+00	2026-04-30 04:59:51.83582+00	f	\N	\N
128a2863-aadb-4bd6-a46d-1989cca14baf	08d1b215-abbb-49ec-96e8-3210cfb4826f	8c015875-9c49-4b49-90ab-fff19b1b73af	\N	\N	import java.util.*;\r\n\r\npublic class  {\r\n\r\n    public static ArrayList<String> obtenerValores(HashMap<Integer, String> mapa) {\r\n        ArrayList<String> listaValores = new ArrayList<>();\r\n\r\n        for (String valor : mapa.values()) {\r\n            listaValores.add(valor);\r\n        }\r\n\r\n        return listaValores;\r\n    }\r\n\r\n    \r\n    public static void main(String[] args) {\r\n        HashMap<Integer, String> mapa = new HashMap<>();\r\n        mapa.put(1, "Juan");\r\n        mapa.put(2, "Ana");\r\n        mapa.put(3, "Carlos");\r\n\r\n        ArrayList<String> resultado = obtenerValores(mapa);\r\n        System.out.println(resultado);\r\n    }\r\n}	\N	1	El código es correcto, cumple con todos los requisitos de la rúbrica y funciona perfectamente. Está bien estructurado y es fácil de entender.	2026-04-30 04:59:47.121618+00	2026-04-30 04:59:47.121618+00	f	\N	\N
08abe65a-15cc-4922-b61c-b128a31b7450	08d1b215-abbb-49ec-96e8-3210cfb4826f	5e4e5088-18de-40bd-8206-6f6d37ae4e94	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class  {\r\n\r\n    public static HashSet<Integer> filtrarMayores(ArrayList<Integer> lista, int limite) {\r\n        HashSet<Integer> resultado = new HashSet<>();\r\n\r\n        for (Integer num : lista) {\r\n            if (num > limite) {\r\n                resultado.add(num);\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n\r\n    \r\n    public static void main(String[] args) {\r\n        ArrayList<Integer> numeros = new ArrayList<>();\r\n        numeros.add(5);\r\n        numeros.add(10);\r\n        numeros.add(3);\r\n        numeros.add(20);\r\n        numeros.add(10); \r\n\r\n        int limite = 8;\r\n\r\n        HashSet<Integer> mayores = filtrarMayores(numeros, limite);\r\n\r\n        System.out.println(mayores); \r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica propuesta en la rúbrica y maneja adecuadamente los tipos de datos. El método `filtrarMayores` crea un `HashSet` correctamente, itera sobre el `ArrayList` y añade los números que cumplen la condición. Además, el `main` demuestra el funcionamiento de manera clara, incluyendo un caso donde hay duplicados en el `ArrayList` original que se eliminan por la naturaleza del `HashSet`.	2026-04-30 04:59:49.382097+00	2026-04-30 04:59:49.382097+00	f	\N	\N
93543730-8522-4219-a32b-3fff5d88243d	2d20aa17-984c-4ffb-8622-66888f3a66b4	a955431a-b9c4-4878-a64b-6874985640ac	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class UnicaLista {\r\n\r\n    public static HashSet<String> ElementosUnicos (ArrayList<String> Lista) {\r\n        return new HashSet<>(Lista);\r\n    }\r\n\r\n    \r\n    public static void main(String[] args) {\r\n        ArrayList<String> Lista = new ArrayList<>();\r\n        list.add("manzana");\r\n        list.add("banana");\r\n        list.add("manzana");   \r\n        list.add("cereza");\r\n        list.add("banana");    \r\n        list.add("durazno");\r\n\r\n        HashSet<String> ListaUnica = ElementosUnicos(Lista);\r\n\r\n        System.out.println("Lista original: " + Lista);\r\n        System.out.println("Elementos únicos: " + ListaUnica);\r\n    }\r\n}	\N	1	El código es funcionalmente correcto. Resuelve el problema de manera concisa y eficiente al aprovechar el constructor de `HashSet` que recibe una `Collection`. Sin embargo, hay un error tipográfico en la función `main` en las líneas donde se añaden elementos a la lista (`list.add` en lugar de `Lista.add`). Aún así, esto es un error menor que no afecta la lógica central de la solución al problema planteado.	2026-04-30 06:08:14.831814+00	2026-04-30 06:08:14.831814+00	f	\N	\N
68ab961b-5486-4512-be76-02f901e29239	2d20aa17-984c-4ffb-8622-66888f3a66b4	4cd7583e-cd70-49d3-8cec-6a2f1052ec7c	\N	\N	import java.util.HashMap;\r\n\r\npublic class FrecuenciaCaracteres {\r\n\r\n    public static HashMap<Character, Integer> contarCaracteres(String texto) {\r\n        \r\n        HashMap<Character, Integer> mapa = new HashMap<>();\r\n\r\n        for (int i = 0; i < texto.length(); i++) {\r\n\r\n            char letra = texto.charAt(i);\r\n\r\n            if (mapa.containsKey(letra)) {\r\n               \r\n                int conteoActual = mapa.get(letra);\r\n                mapa.put(letra, conteoActual + 1);\r\n            } else {\r\n                \r\n                mapa.put(letra, 1);\r\n            }\r\n        }\r\n\r\n        return mapa;\r\n    }\r\n\r\n    public static void main(String[] args) {\r\n\r\n        String texto = "banana";\r\n        HashMap<Character, Integer> resultado = contarCaracteres(texto);\r\n\r\n        System.out.println("Texto: " + texto);\r\n        System.out.println("Resultado: " + resultado);\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica propuesta en la rúbrica y maneja adecuadamente la creación y actualización del HashMap. La claridad es buena y el método `main` demuestra su uso. Además, considera las dependencias necesarias. Sin embargo, en el `main` falta la tilde en "caracteres" para `FrecuenciaCaracteres`, pero esto no afecta la funcionalidad.	2026-04-30 06:08:17.308476+00	2026-04-30 06:08:17.308476+00	f	\N	\N
ca8541d3-1d56-45e6-a02e-a5fea21da34f	2d20aa17-984c-4ffb-8622-66888f3a66b4	9a4435b4-6202-4f18-89d3-175f863e083f	\N	\N	import java.util.HashSet;\r\n\r\npublic class InterseccionConjuntos {\r\n\r\n    public static HashSet<Integer> interseccion(HashSet<Integer> conjunto1, HashSet<Integer> conjunto2) {\r\n\r\n        HashSet<Integer> resultado = new HashSet<>();\r\n\r\n        for (int numero : conjunto1) {\r\n\r\n            if (conjunto2.contains(numero)) {\r\n                \r\n                resultado.add(numero);\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n\r\n    public static void main(String[] args) {\r\n\r\n        HashSet<Integer> conjunto1 = new HashSet<>();\r\n        conjunto1.add(1);\r\n        conjunto1.add(2);\r\n        conjunto1.add(3);\r\n        conjunto1.add(4);\r\n\r\n        HashSet<Integer> conjunto2 = new HashSet<>();\r\n        conjunto2.add(3);\r\n        conjunto2.add(4);\r\n        conjunto2.add(5);\r\n        conjunto2.add(6);\r\n\r\n        HashSet<Integer> comunes = interseccion(conjunto1, conjunto2);\r\n\r\n        System.out.println("Conjunto 1: " + conjunto1);\r\n        System.out.println("Conjunto 2: " + conjunto2);\r\n        System.out.println("Elementos comunes: " + comunes);\r\n    }\r\n}	\N	1	La solución es correcta y sigue la lógica esperada. Crea un nuevo HashSet, itera sobre uno de los conjuntos de entrada y verifica si cada elemento está presente en el segundo, añadiendo los elementos comunes al nuevo conjunto. El código es claro y maneja bien el caso de conjuntos vacíos o sin elementos en común. Además, incluye un método `main` para probar la funcionalidad, lo cual es un plus. ¡Excelente trabajo!	2026-04-30 06:08:19.546303+00	2026-04-30 06:08:19.546303+00	f	\N	\N
80de1198-f165-4342-9c1e-83a14d46f944	2d20aa17-984c-4ffb-8622-66888f3a66b4	a00d551e-3dc4-4966-b9f0-b05cbe043e99	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\nimport java.util.HashSet;\r\n\r\npublic class NombresUnicos {\r\n\r\n    public static HashSet<String> obtenerNombres(ArrayList<HashMap<String, String>> lista) {\r\n\r\n        HashSet<String> nombres = new HashSet<>();\r\n\r\n        for (HashMap<String, String> mapa : lista) {\r\n\r\n            if (mapa.containsKey("nombre")) {\r\n                nombres.add(mapa.get("nombre"));\r\n            }\r\n\r\n        }\r\n\r\n        return nombres;\r\n    }\r\n\r\n    public static void main(String[] args) {\r\n\r\n        HashMap<String, String> persona1 = new HashMap<>();\r\n        persona1.put("nombre", "Ana");\r\n\r\n        HashMap<String, String> persona2 = new HashMap<>();\r\n        persona2.put("nombre", "Luis");\r\n\r\n        HashMap<String, String> persona3 = new HashMap<>();\r\n        persona3.put("nombre", "Ana"); \r\n\r\n        \r\n        ArrayList<HashMap<String, String>> lista = new ArrayList<>();\r\n        lista.add(persona1);\r\n        lista.add(persona2);\r\n        lista.add(persona3);\r\n        \r\n\r\n        System.out.println("Nombres únicos: " + obtenerNombres(lista));\r\n    }\r\n}	\N	1	El código es correcto. Compila y cubre todos los casos según lo solicitado en el enunciado, incluyendo la inicialización del HashSet, la iteración y la verificación de la clave ``nombre`` para agregar el valor. Además, incluye un método ``main`` para demostrar su funcionamiento.	2026-04-30 06:08:26.514075+00	2026-04-30 06:08:26.514075+00	f	\N	\N
c325bbbb-eaea-4514-a769-ffeaf1beea1e	2d20aa17-984c-4ffb-8622-66888f3a66b4	8c015875-9c49-4b49-90ab-fff19b1b73af	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\n\r\npublic class ValoresDelMapa {\r\n\r\n    public static ArrayList<String> obtenerValores(HashMap<Integer, String> mapa) {\r\n\r\n        ArrayList<String> valores = new ArrayList<>();\r\n\r\n        for (String valor : mapa.values()) {\r\n            valores.add(valor);\r\n        }\r\n\r\n        return valores;\r\n    }\r\n\r\n    public static void main(String[] args) {\r\n\r\n        HashMap<Integer, String> mapa = new HashMap<>();\r\n        mapa.put(1, "Angie");\r\n        mapa.put(2, "Juan");\r\n        mapa.put(3, "Gabriela");\r\n\r\n        ArrayList<String> resultado = obtenerValores(mapa);\r\n\r\n        System.out.println("Valores: " + resultado);\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica esperada y no tiene errores. Incluye un ejemplo de uso en el método `main` que demuestra su funcionamiento correctamente.	2026-04-30 06:08:38.692932+00	2026-04-30 06:08:38.692932+00	f	\N	\N
67f56328-0470-4c09-aa7c-c0fb208bab78	2d20aa17-984c-4ffb-8622-66888f3a66b4	4f2c49bf-48cb-4619-bcd7-b9cfa1e16d4b	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\n\r\npublic class SumaValores {\r\n\r\n    public static int sumarValores(HashMap<String, ArrayList<Integer>> mapa, String clave) {\r\n\r\n        if (!mapa.containsKey(clave) || mapa.get(clave).isEmpty()) {\r\n            return 0;\r\n        }\r\n\r\n        int suma = 0;\r\n\r\n        for (int numero : mapa.get(clave)) {\r\n            suma = suma + numero;\r\n        }\r\n\r\n        return suma;\r\n    }\r\n\r\n    public static void main(String[] args) {\r\n\r\n        ArrayList<Integer> listaA = new ArrayList<>();\r\n        listaA.add(10);\r\n        listaA.add(20);\r\n        listaA.add(30);\r\n\r\n        HashMap<String, ArrayList<Integer>> mapa = new HashMap<>();\r\n        mapa.put("A", listaA);\r\n\r\n        System.out.println("Suma de A: " + sumarValores(mapa, "A")); // 60\r\n        System.out.println("Suma de X: " + sumarValores(mapa, "X")); // 0\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica propuesta en la rúbrica y maneja adecuadamente los casos borde. Compila y funciona como se espera. La claridad es buena.	2026-04-30 06:08:30.503664+00	2026-04-30 06:08:30.503664+00	f	\N	\N
55e4d764-8a8f-48e7-9574-e8a82fe39f09	2d20aa17-984c-4ffb-8622-66888f3a66b4	5e4e5088-18de-40bd-8206-6f6d37ae4e94	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class NumerosMayores {\r\n\r\n    public static HashSet<Integer> filtrarMayores(ArrayList<Integer> numeros, int limite) {\r\n\r\n        HashSet<Integer> resultado = new HashSet<>();\r\n\r\n        for (int numero : numeros) {\r\n            if (numero > limite) {\r\n                resultado.add(numero);\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n\r\n    public static void main(String[] args) {\r\n\r\n        ArrayList<Integer> numeros = new ArrayList<>();\r\n        numeros.add(5);\r\n        numeros.add(12);\r\n        numeros.add(3);\r\n        numeros.add(8);\r\n\r\n        System.out.println("Mayores a 7: " + filtrarMayores(numeros, 7));\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica esperada y resuelve el problema de manera eficiente. La inicialización del HashSet, la iteración y la condición de añadir son las adecuadas. Además, incluye un método `main` para probar la funcionalidad, lo cual es un plus.	2026-04-30 06:08:41.502786+00	2026-04-30 06:08:41.502786+00	f	\N	\N
fe5a8410-6c62-459c-9f2a-ab96437dd6a4	2d20aa17-984c-4ffb-8622-66888f3a66b4	56c3eeba-b046-424f-9989-45cce139e191	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\n\r\npublic class PersonasPorCiudad {\r\n\r\n    public static void main(String[] args) {\r\n\r\n        HashMap<String, ArrayList<String>> ciudades = new HashMap<>();\r\n\r\n        ArrayList<String> personasCali = new ArrayList<>();\r\n        personasCali.add("Angie");\r\n        personasCali.add("Luis");\r\n        personasCali.add("Gabriela");\r\n\r\n        ArrayList<String> personasMedellin = new ArrayList<>();\r\n        personasMedellin.add("Carlos");\r\n        personasMedellin.add("Sofia");\r\n\r\n        ciudades.put("Cali", personasCali);\r\n        ciudades.put("Medellin", personasMedellin);\r\n\r\n        String ciudadBuscada = "Cali";\r\n\r\n        if (ciudades.containsKey(ciudadBuscada)) {\r\n            System.out.println("Personas en " + ciudadBuscada + ": " + ciudades.get(ciudadBuscada));\r\n        } else {\r\n            System.out.println("La ciudad no existe.");\r\n        }\r\n    }\r\n}	\N	1	El código es correcto y cumple con todos los requisitos del enunciado y la rúbrica. Declara el HashMap, añade al menos dos ciudades con sus listas y busca e imprime las personas de una ciudad específica. La lógica es clara y maneja el caso de ciudad no encontrada.	2026-04-30 06:08:33.88003+00	2026-04-30 06:08:33.88003+00	f	\N	\N
ea7b6934-7fa1-45e3-ac05-df6d187a41eb	2d20aa17-984c-4ffb-8622-66888f3a66b4	38d231f4-4a55-48e5-a5ee-5ca9eab80d57	\N	\N	import java.util.HashMap;\r\nimport java.util.HashSet;\r\n\r\npublic class PersonasUnicas {\r\n\r\n    public static HashSet<String> obtenerPersonas(HashMap<String, HashSet<String>> grupos) {\r\n\r\n        HashSet<String> resultado = new HashSet<>();\r\n\r\n        for (HashSet<String> personas : grupos.values()) {\r\n            resultado.addAll(personas);\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n\r\n    public static void main(String[] args) {\r\n\r\n        HashSet<String> grupo1 = new HashSet<>();\r\n        grupo1.add("Angie");\r\n        grupo1.add("Luis");\r\n\r\n        HashSet<String> grupo2 = new HashSet<>();\r\n        grupo2.add("Maria");\r\n        grupo2.add("Angie"); \r\n\r\n        HashMap<String, HashSet<String>> grupos = new HashMap<>();\r\n        grupos.put("Grupo A", grupo1);\r\n        grupos.put("Grupo B", grupo2);\r\n\r\n        System.out.println("Personas únicas: " + obtenerPersonas(grupos));\r\n    }\r\n}	\N	1	La solución es correcta y cumple con todos los requisitos. Maneja correctamente la iteración y el uso de `HashSet` para asegurar la unicidad de los nombres.	2026-04-30 06:08:44.835235+00	2026-04-30 06:08:44.835235+00	f	\N	\N
0eaecbe2-78c5-4d6a-b365-d4ef382b29b9	2d20aa17-984c-4ffb-8622-66888f3a66b4	f2764063-b03d-4d0b-aada-3e7ffdf1ab51	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class PersonasAutorizadas {\r\n\r\n    public static ArrayList<String> filtrarAutorizadas(ArrayList<String> personas, HashSet<String> autorizadas) {\r\n\r\n        ArrayList<String> resultado = new ArrayList<>();\r\n\r\n        for (String persona : personas) {\r\n            if (autorizadas.contains(persona)) {\r\n                resultado.add(persona);\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n\r\n    public static void main(String[] args) {\r\n\r\n        ArrayList<String> personas = new ArrayList<>();\r\n        personas.add("Angie");\r\n        personas.add("Juan");\r\n        personas.add("Gabriela");\r\n        personas.add("Carlos");\r\n\r\n        HashSet<String> autorizadas = new HashSet<>();\r\n        autorizadas.add("Angie");\r\n        autorizadas.add("Gabriela");\r\n\r\n        ArrayList<String> resultado = filtrarAutorizadas(personas, autorizadas);\r\n\r\n        System.out.println("Personas autorizadas: " + resultado);\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica propuesta en la rúbrica y maneja adecuadamente los tipos de datos. Incluye un método `main` para probar la funcionalidad, lo cual es muy útil para demostrar su correcto funcionamiento.	2026-04-30 06:08:37.066327+00	2026-04-30 06:08:37.066327+00	f	\N	\N
2cf5c364-26c2-44b3-b4b0-e6cc39d0d638	df24dc30-acaa-4c36-8e1c-fd7af7c4426a	a955431a-b9c4-4878-a64b-6874985640ac	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic static HashSet<String> obtenerUnicos(ArrayList<String> lista) {\r\n    HashSet<String> conjunto = new HashSet<>();\r\n\r\n    for (String elemento : lista) {\r\n        conjunto.add(elemento);\r\n    }\r\n\r\n    return conjunto;\r\n}\r\n	\N	1	El código es correcto y cumple con todas las especificaciones. Es conciso, eficiente y maneja correctamente los tipos de datos. La lógica es impecable. El código compila y funciona según lo esperado.	2026-04-30 14:24:07.809269+00	2026-04-30 14:24:07.809269+00	f	\N	\N
7e15bac5-482d-4fd4-b087-b6fa2ad7e289	df24dc30-acaa-4c36-8e1c-fd7af7c4426a	4cd7583e-cd70-49d3-8cec-6a2f1052ec7c	\N	\N	import java.util.HashMap;\r\n\r\npublic static HashMap<Character, Integer> contarCaracteres(String texto) {\r\n    HashMap<Character, Integer> mapa = new HashMap<>();\r\n\r\n    for (int i = 0; i < texto.length(); i++) {\r\n        char c = texto.charAt(i);\r\n\r\n        if (mapa.containsKey(c)) {\r\n            mapa.put(c, mapa.get(c) + 1);\r\n        } else {\r\n            mapa.put(c, 1);\r\n        }\r\n    }\r\n\r\n    return mapa;\r\n}	\N	1	El código es correcto. Implementa de manera eficiente y clara la lógica solicitada para contar la frecuencia de los caracteres en un `String` utilizando un `HashMap`. Maneja adecuadamente los casos cuando un carácter ya existe o es nuevo en el mapa. También tiene en cuenta el caso de un `String` vacío, donde devolvería un `HashMap` vacío, lo cual es correcto.	2026-04-30 14:24:30.053611+00	2026-04-30 14:24:30.053611+00	f	\N	\N
b0409ebc-a5c6-46a7-a02c-e2f516a17ef5	df24dc30-acaa-4c36-8e1c-fd7af7c4426a	9a4435b4-6202-4f18-89d3-175f863e083f	\N	\N	import java.util.HashSet;\r\n\r\npublic static HashSet<Integer> interseccion(HashSet<Integer> set1, HashSet<Integer> set2) {\r\n    HashSet<Integer> resultado = new HashSet<>();\r\n\r\n    for (Integer num : set1) {\r\n        if (set2.contains(num)) {\r\n            resultado.add(num);\r\n        }\r\n    }\r\n	\N	1	El código es correcto, sigue la lógica esperada y no tiene errores de sintaxis ni de compilación. Es conciso y eficiente para la tarea propuesta. Se recomienda incluir los `imports` necesarios. Se recomienda encerrar la función en una clase para que el código sea completo y compilable.	2026-04-30 14:24:40.507601+00	2026-04-30 14:24:40.507601+00	f	\N	\N
ccd12403-64eb-4f76-be28-3410162401b4	df24dc30-acaa-4c36-8e1c-fd7af7c4426a	a00d551e-3dc4-4966-b9f0-b05cbe043e99	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\nimport java.util.HashSet;\r\n\r\npublic static HashSet<String> obtenerNombres(ArrayList<HashMap<String, String>> lista) {\r\n    HashSet<String> resultado = new HashSet<>();\r\n\r\n    for (HashMap<String, String> mapa : lista) {\r\n        if (mapa.containsKey("nombre")) {\r\n            resultado.add(mapa.get("nombre"));\r\n        }\r\n    }	\N	0	Sin retroalimentación	2026-04-30 14:25:00.212032+00	2026-04-30 14:25:00.212032+00	f	\N	\N
9bbeeaa6-d720-4a9a-9757-6e8faba88416	df24dc30-acaa-4c36-8e1c-fd7af7c4426a	4f2c49bf-48cb-4619-bcd7-b9cfa1e16d4b	\N	\N	import java.util.HashMap;\r\nimport java.util.ArrayList;\r\n\r\npublic static int sumarLista(HashMap<String, ArrayList<Integer>> mapa, String clave) {\r\n    if (!mapa.containsKey(clave) || mapa.get(clave).isEmpty()) {\r\n        return 0;\r\n    }\r\n\r\n    int suma = 0;\r\n    ArrayList<Integer> lista = mapa.get(clave);\r\n\r\n    for (Integer num : lista) {\r\n        suma += num;\r\n    }\r\n\r\n    return suma;\r\n}	\N	0.7	El código es casi correcto y sigue una lógica adecuada para resolver el problema. Sin embargo, tiene un error potencial: si `mapa.get(clave)` devuelve `null` (lo cual es posible si la clave existe pero el valor asociado es `null`), `mapa.get(clave).isEmpty()` lanzaría una `NullPointerException`. Falta una verificación explícita para el caso de un `ArrayList` nulo. Además, el método no está encapsulado en una clase.	2026-04-30 14:25:23.141802+00	2026-04-30 14:25:23.141802+00	f	\N	\N
879d4ed6-10f0-4b17-ac83-c868178ee3b5	df24dc30-acaa-4c36-8e1c-fd7af7c4426a	56c3eeba-b046-424f-9989-45cce139e191	\N	\N		\N	0	Sin respuesta	2026-04-30 14:25:23.48038+00	2026-04-30 14:25:23.48038+00	f	\N	\N
ab096a47-dd99-4448-b3b3-6bc4f0d18c6d	df24dc30-acaa-4c36-8e1c-fd7af7c4426a	f2764063-b03d-4d0b-aada-3e7ffdf1ab51	\N	\N		\N	0	Sin respuesta	2026-04-30 14:25:23.81403+00	2026-04-30 14:25:23.81403+00	f	\N	\N
8d566204-fa26-4106-8d8f-f2f1fe13e4c6	df24dc30-acaa-4c36-8e1c-fd7af7c4426a	8c015875-9c49-4b49-90ab-fff19b1b73af	\N	\N	import java.util.HashMap;\r\nimport java.util.ArrayList;\r\n\r\npublic class Ejercicio {\r\n    public static ArrayList<String> obtenerValores(HashMap<Integer, String> mapa) {\r\n        return new ArrayList<>(mapa.values());\r\n    }\r\n}	\N	1	El código es conciso y usa la funcionalidad integrada de Java para convertir directamente los valores del mapa en un `ArrayList`. Es correcto, eficiente y cumple con la rúbrica.	2026-04-30 14:25:26.253722+00	2026-04-30 14:25:26.253722+00	f	\N	\N
a6fbd55d-fda2-41a4-b3c7-5577cae342dd	df24dc30-acaa-4c36-8e1c-fd7af7c4426a	5e4e5088-18de-40bd-8206-6f6d37ae4e94	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class Ejercicio {\r\n    public static HashSet<Integer> mayoresQueLimite(ArrayList<Integer> lista, int limite) {\r\n        HashSet<Integer> resultado = new HashSet<>();\r\n        \r\n        for (Integer num : lista) {\r\n            if (num > limite) {\r\n                resultado.add(num);\r\n            }\r\n        }\r\n        \r\n        return resultado;\r\n    }\r\n}	\N	1	El código es correcto. Cumple con la inicialización del HashSet, la iteración sobre el ArrayList y la adición condicional de elementos. La lógica es clara y el manejo de casos borde (como un ArrayList vacío o sin elementos mayores que el límite) funciona correctamente.	2026-04-30 14:25:34.894346+00	2026-04-30 14:25:34.894346+00	f	\N	\N
4c3614ac-62fb-4f4e-ae6a-7d3fd805df5d	75404f12-b06e-473d-b49f-0e2f57881775	5e4e5088-18de-40bd-8206-6f6d37ae4e94	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class funcion1 {\r\n\r\n    public static HashSet<Integer> metodo1(ArrayList<Integer> lista, int limite) {\r\n        HashSet<Integer> resultado = new HashSet<>();\r\n\r\n        for (int numero : lista) {\r\n            if (numero > limite) {\r\n                resultado.add(numero);\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica propuesta en la rúbrica y maneja adecuadamente los tipos de datos. Compila y funciona correctamente.	2026-04-30 22:27:16.747456+00	2026-04-30 22:27:16.747456+00	f	\N	\N
4c299f4f-2f33-4900-b143-d7ac4683b617	04e14093-1777-40ff-bee1-07c015be7fb8	a955431a-b9c4-4878-a64b-6874985640ac	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class SolucionTaller1 {\r\n public HashSet<String>\r\n ObtenerElementoUnico(ArrayList<String>lista){\r\n  return new HashSet<>(lista);  \r\n }   \r\n}	\N	1	El código es conciso y correcto. La forma más eficiente de convertir un `ArrayList` a un `HashSet` es a través del constructor de `HashSet` que recibe una `Collection` como argumento. Declara correctamente los tipos de datos y el retorno.	2026-04-30 22:34:24.740974+00	2026-04-30 22:34:24.740974+00	f	\N	\N
5cd733a3-b2a8-4036-bb5c-1ecd07745797	df24dc30-acaa-4c36-8e1c-fd7af7c4426a	38d231f4-4a55-48e5-a5ee-5ca9eab80d57	\N	\N	import java.util.HashMap;\r\nimport java.util.HashSet;\r\n\r\npublic class Ejercicio {\r\n\r\n    public static HashSet<String> obtenerPersonasUnicas(HashMap<String, HashSet<String>> grupos) {\r\n        // HashSet para guardar los nombres únicos\r\n        HashSet<String> resultado = new HashSet<>();\r\n\r\n        // Recorremos cada grupo\r\n        for (HashSet<String> personas : grupos.values()) {\r\n            // Agregamos todas las personas al resultado\r\n            resultado.addAll(personas);\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n\r\n    // Ejemplo de uso\r\n    public static void main(String[] args) {\r\n        HashMap<String, HashSet<String>> grupos = new HashMap<>();\r\n\r\n        HashSet<String> grupo1 = new HashSet<>();\r\n        grupo1.add("Ana");\r\n        grupo1.add("Luis");\r\n\r\n        HashSet<String> grupo2 = new HashSet<>();\r\n        grupo2.add("Luis");\r\n        grupo2.add("Carlos");\r\n\r\n        grupos.put("Grupo A", grupo1);\r\n        grupos.put("Grupo B", grupo2);\r\n\r\n        HashSet<String> resultado = obtenerPersonasUnicas(grupos);\r\n\r\n        System.out.println(resultado);\r\n    }\r\n}\r\n	\N	1	La respuesta del estudiante es correcta y cumple con todos los requisitos. El código es claro, conciso y maneja adecuadamente el tipo de entrada y salida esperado. La lógica es impecable, utilizando `HashSet` para asegurar la unicidad de los nombres y `addAll` para una agregación eficiente. Además, incluye un `main` con un ejemplo de uso que valida la funcionalidad.	2026-04-30 14:25:43.245821+00	2026-04-30 14:25:43.245821+00	f	\N	\N
5bc05e4f-3312-472c-8e47-2692a0a0add3	75404f12-b06e-473d-b49f-0e2f57881775	a955431a-b9c4-4878-a64b-6874985640ac	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class UtilidadesColecciones {\r\n\r\n    public static HashSet<String> obtenerElementosUnicos(ArrayList<String> lista) {\r\n        if (lista == null) {\r\n            return new HashSet<>();\r\n        }\r\n       \r\n        return new HashSet<>(lista);\r\n    }\r\n}	\N	1	El código es correcto y cumple con los requisitos del enunciado. Utiliza el constructor de `HashSet` que recibe una `Collection` para inicializarlo directamente con los elementos del `ArrayList`, lo cual es una solución elegante y eficiente. Además, se considera el caso de una lista nula devolviendo un `HashSet` vacío, lo cual es un buen manejo de un caso borde.	2026-04-30 22:27:02.221796+00	2026-04-30 22:27:02.221796+00	f	\N	\N
eea63adb-6a7b-4e0b-98d8-c70e9df22cd4	75404f12-b06e-473d-b49f-0e2f57881775	4cd7583e-cd70-49d3-8cec-6a2f1052ec7c	\N	\N	import java.util.HashMap;\r\n\r\npublic class funcion1 {\r\n\r\n    public static HashMap<Character, Integer> metodo1(String texto) {\r\n        HashMap<Character, Integer> mapa = new HashMap<>();\r\n\r\n        for (int i = 0; i < texto.length(); i++) {\r\n            char letra = texto.charAt(i);\r\n\r\n            if (mapa.containsKey(letra)) {\r\n                int actual = mapa.get(letra);\r\n                mapa.put(letra, actual + 1);\r\n            } else {\r\n                mapa.put(letra, 1);\r\n            }\r\n        }\r\n\r\n        return mapa;\r\n    }\r\n}	\N	1	El código es correcto, sigue al pie de la letra la rúbrica y maneja bien el enunciado del problema. Además, el manejo de casos borde es adecuado, por ejemplo, cadenas vacías o con un solo carácter.	2026-04-30 22:27:03.963347+00	2026-04-30 22:27:03.963347+00	f	\N	\N
aea46e3c-47a8-4297-bc8c-0025456b5ce3	75404f12-b06e-473d-b49f-0e2f57881775	9a4435b4-6202-4f18-89d3-175f863e083f	\N	\N	import java.util.HashSet;\r\n\r\npublic class funcion1 {\r\n\r\n    public static HashSet<Integer> metodo1(HashSet<Integer> conjunto1, HashSet<Integer> conjunto2) {\r\n        HashSet<Integer> resultado = new HashSet<>();\r\n\r\n        for (Integer numero : conjunto1) {\r\n            if (conjunto2.contains(numero)) {\r\n                resultado.add(numero);\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es correcto. Cumple con todos los requisitos de la rúbrica: crea un nuevo HashSet, itera sobre uno de los conjuntos de entrada y utiliza el método `contains` para verificar la existencia de elementos en el segundo conjunto, añadiendo los elementos comunes al conjunto resultante. Además, el código es claro y fácil de entender.	2026-04-30 22:27:06.061235+00	2026-04-30 22:27:06.061235+00	f	\N	\N
cdf550c1-6516-4511-9fdb-dee70b7bd13c	75404f12-b06e-473d-b49f-0e2f57881775	a00d551e-3dc4-4966-b9f0-b05cbe043e99	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\nimport java.util.HashSet;\r\n\r\npublic class funcion1 {\r\n\r\n    public static HashSet<String> metodo1(ArrayList<HashMap<String, String>> lista) {\r\n        HashSet<String> resultado = new HashSet<>();\r\n\r\n        for (HashMap<String, String> mapa : lista) {\r\n            if (mapa.containsKey("nombre")) {\r\n                resultado.add(mapa.get("nombre"));\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es correcto y sigue las indicaciones de la rúbrica. Inicializa un HashSet, itera sobre el ArrayList, verifica la existencia de la clave "nombre" y añade el valor si existe. Es eficiente y claro.	2026-04-30 22:27:08.23059+00	2026-04-30 22:27:08.23059+00	f	\N	\N
372d67b1-3875-4db4-8a68-8af67cc8f894	75404f12-b06e-473d-b49f-0e2f57881775	4f2c49bf-48cb-4619-bcd7-b9cfa1e16d4b	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\n\r\npublic class funcion1 {\r\n\r\n    public static int metodo1(HashMap<String, ArrayList<Integer>> mapa, String clave) {\r\n        if (!mapa.containsKey(clave)) {\r\n            return 0;\r\n        }\r\n\r\n        ArrayList<Integer> lista = mapa.get(clave);\r\n        \r\n        if (lista == null || lista.isEmpty()) {\r\n            return 0;\r\n        }\r\n\r\n        int suma = 0;\r\n        for (int numero : lista) {\r\n            suma += numero;\r\n        }\r\n\r\n        return suma;\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica propuesta en el enunciado y maneja adecuadamente los casos borde. Compila y funciona como se espera.	2026-04-30 22:27:09.761502+00	2026-04-30 22:27:09.761502+00	f	\N	\N
d014872e-bd56-4e23-a5c8-448233516ef6	75404f12-b06e-473d-b49f-0e2f57881775	56c3eeba-b046-424f-9989-45cce139e191	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\n\r\npublic class funcion1 {\r\n\r\n    public static void main(String[] args) {\r\n        HashMap<String, ArrayList<String>> mapa = new HashMap<>();\r\n\r\n        ArrayList<String> lista1 = new ArrayList<>();\r\n        lista1.add("Ana");\r\n        lista1.add("Luis");\r\n        mapa.put("Cali", lista1);\r\n\r\n        ArrayList<String> lista2 = new ArrayList<>();\r\n        lista2.add("Pedro");\r\n        mapa.put("Bogota", lista2);\r\n\r\n        String ciudadBusqueda = "Cali";\r\n\r\n        if (mapa.containsKey(ciudadBusqueda)) {\r\n            ArrayList<String> personas = mapa.get(ciudadBusqueda);\r\n            for (String persona : personas) {\r\n                System.out.println(persona);\r\n            }\r\n        }\r\n    }\r\n}	\N	1	El código es correcto, cumple con todos los requisitos de la rúbrica y funciona perfectamente. Está bien estructurado y es fácil de entender.	2026-04-30 22:27:11.426409+00	2026-04-30 22:27:11.426409+00	f	\N	\N
7e670130-fb96-4be5-8bca-5223f3a13c1b	75404f12-b06e-473d-b49f-0e2f57881775	f2764063-b03d-4d0b-aada-3e7ffdf1ab51	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class funcion1 {\r\n\r\n    public static ArrayList<String> metodo1(ArrayList<String> listaNombres, HashSet<String> autorizados) {\r\n        ArrayList<String> resultado = new ArrayList<>();\r\n\r\n        for (String nombre : listaNombres) {\r\n            if (autorizados.contains(nombre)) {\r\n                resultado.add(nombre);\r\n            }\r\n        }\r\n\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica esperada, maneja adecuadamente los tipos de datos y es claro. Se crea un nuevo ArrayList para el resultado y se itera sobre la lista de nombres para verificar su autorización en el HashSet.	2026-04-30 22:27:13.175808+00	2026-04-30 22:27:13.175808+00	f	\N	\N
7cf47d78-a61c-427b-ac5d-ebfb3dc02582	75404f12-b06e-473d-b49f-0e2f57881775	8c015875-9c49-4b49-90ab-fff19b1b73af	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\n\r\npublic class funcion1 {\r\n\r\n    public static ArrayList<String> metodo1(HashMap<Integer, String> mapa) {\r\n        ArrayList<String> lista = new ArrayList<>();\r\n\r\n        for (String valor : mapa.values()) {\r\n            lista.add(valor);\r\n        }\r\n\r\n        return lista;\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica propuesta en la rúbrica y es claro. ¡Bien hecho!	2026-04-30 22:27:14.590369+00	2026-04-30 22:27:14.590369+00	f	\N	\N
8a6d9d3f-4cc4-453f-851e-02280b118cde	04e14093-1777-40ff-bee1-07c015be7fb8	4cd7583e-cd70-49d3-8cec-6a2f1052ec7c	\N	\N	import java.util.HashMap;\r\n\r\npublic class Main{\r\npublic static HashMap<Character,Integer>ContarCaracteres(String texto){\r\n    HashMap<Character,Integer>mapafrecuencias = new HashMap<>();\r\n\r\n    if (texto == null){\r\n        return mapafrecuencias;\r\n    }\r\n    for (char c : texto,toCharArray()){\r\n        mapafrecuencias.put(c,mapafrecuencias.getOrDefault(c,0) + 1);\r\n    }\r\nreturn mapafrecuencias;\r\n\r\n}    \r\n}\r\n\r\n	\N	0.7	El código es funcionalmente correcto y la lógica es adecuada. Sin embargo, hay un error de sintaxis al intentar llamar a `toCharArray()` en el String `texto`. Esto causaría un error de compilación. Además, el manejo del caso del String nulo es correcto al retornar un mapa vacío, de lo contrario un `NullPointerException` en el bucle for-each sería lanzado si el chequeo no estuviera ahí. Por si esto fuera poco, no se tiene en cuenta los espacios. La función no es estática, y debería serlo para poder ser llamada sin la necesidad de crear un objeto de la clase Main.	2026-04-30 22:34:27.10233+00	2026-04-30 22:34:27.10233+00	f	\N	\N
3e770429-b49a-4131-ab2a-f13e98590783	04e14093-1777-40ff-bee1-07c015be7fb8	9a4435b4-6202-4f18-89d3-175f863e083f	\N	\N	import java.util.HashSet;\r\npublic HashSet<Integer>\r\nobtenerInterseccion(HashSet<Integer> Elemento1, HashSet<Integer>Elemento2){\r\nHashSet<Integer> Interseccion = new HashSet<>(Elemento1);\r\nInterseccion.retainAll(Elemento2);\r\nreturn Interseccion;    \r\n}	\N	1	El código es conciso y correcto. La función `retainAll` de `HashSet` es una forma eficiente de obtener la intersección, lo cual demuestra un buen conocimiento de la API de Java. La solución cumple con todos los requisitos. Aunque la rúbrica sugiere iterar, esta solución es aún mejor al usar las funcionalidades existentes de la librería.	2026-04-30 22:34:29.318491+00	2026-04-30 22:34:29.318491+00	f	\N	\N
4980ec93-c049-4315-89e4-5c9f0391c932	04e14093-1777-40ff-bee1-07c015be7fb8	4f2c49bf-48cb-4619-bcd7-b9cfa1e16d4b	\N	\N	import java.util.HashMap;\r\nimport java.util.ArrayList;\r\n\r\npublic int sumarListaPorClave(HashMap<String,ArrayList<Integer>>mapa, String Clave){\r\nif(mapa == null) || !\r\nmapa.containsKey(Clave){\r\n    return 0;\r\n}   \r\nArrayList<Integer> lista = mapa.get(clave);\r\nif (lista == null || lista.isEmpty()){\r\n    return 0;\r\n}\r\nint suma = 0;\r\nfor (Integer numero : lista){\r\n    suma += numero;\r\n}\r\nreturn suma;\r\n}	\N	0.4	El código tiene errores de compilación graves y no sigue las convenciones de Java. Los errores son:&#x20;  \n1.  **Error de sintaxis en `if (mapa == null) || !mapa.containsKey(Clave)`:** El operador `||` se está usando incorrectamente, debería estar dentro del paréntesis del `if` o se debe separar en dos `if`s.  \n2.  **Uso inconsistente de mayúsculas y minúsculas en la clave:** Se utiliza `Clave` en la definición del método y en `containsKey`, pero luego se usa `clave` al llamar a `mapa.get(clave);`. Java es sensible a mayúsculas y minúsculas, lo que generaría un error.  \n3.  **La función no está dentro de una clase:** En Java, los métodos deben pertenecer a una clase.  \n\nSi bien el intento de lógica para manejar casos borde (mapa nulo, clave no existente, lista nula o vacía) es correcto, los errores de sintaxis y compilación impiden que funcione. La falta de consistencia en el uso de mayúsculas/minúsculas para la clave también es un problema importante.	2026-04-30 22:34:35.761819+00	2026-04-30 22:34:35.761819+00	f	\N	\N
e0a5e096-482f-4db9-87e8-b0b0698f1b61	04e14093-1777-40ff-bee1-07c015be7fb8	56c3eeba-b046-424f-9989-45cce139e191	\N	\N	import java.util.HashMap;\r\nimport java.util.ArrayList;\r\n\r\npublic class RegistroCiudades{\r\n  public static void main(String[]args){\r\n    HashMap<String,ArrayList<String>> ciudadesMap = new HashMap<>();\r\n    ArrayList<String> personasCali = new ArrayList<>();\r\n    personasCali.add("Nikol");\r\n    personasCali.add("Sofia");\r\n\r\n    ArrayList<String> personasBogota = new ArrayList();\r\n    personasBogota.add("David");\r\n    personasBogota.add("Jose");\r\n    \r\n    ciudadesMap.put("Cali",personasCali);\r\n    ciudadesMap.put("Bogota", personasBogota);\r\n\r\n    String ciudadBuscar = "Cali";\r\n    if (ciudadesMap.containsKey(ciudadBuscar)){\r\n      System.out.println("Personas en " + ciudadBuscar + ": " + ciudadesMap.get(ciudadBuscar));  \r\n    }\r\n    else{\r\n    System.out.println("La ciudad no se encuentra en el registro");    \r\n    }\r\n  }  \r\n}	\N	1	El código es correcto, cumple con todos los requisitos de la rúbrica y funciona perfectamente. Se declara e inicializa el HashMap correctamente, se añaden las ciudades y personas, y se busca e imprime la información de una ciudad específica de manera eficiente. El manejo del caso en que la ciudad no se encuentre es adecuado.	2026-04-30 22:34:38.305149+00	2026-04-30 22:34:38.305149+00	f	\N	\N
54e739dd-3c80-47db-9770-06307909ce7c	04e14093-1777-40ff-bee1-07c015be7fb8	8c015875-9c49-4b49-90ab-fff19b1b73af	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\n\r\npublic class Resolver {\r\n  public ArrayList<String> obtenerValores(HashMap<Integer,String> mapa){\r\n    return new ArrayList<>(mapa.values());\r\n  }  \r\n}	\N	1	El código es conciso y correcto. Aprovecha el constructor de `ArrayList` que recibe una `Collection` para inicializarlo directamente con los valores del `HashMap`.	2026-04-30 22:34:42.03986+00	2026-04-30 22:34:42.03986+00	f	\N	\N
d3d07a1a-e751-4ea2-83ed-d0d705f28029	04e14093-1777-40ff-bee1-07c015be7fb8	5e4e5088-18de-40bd-8206-6f6d37ae4e94	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class Ingresar {\r\n    public HashSet<Integer>IngresarMayores(ArrayList<Integer> lista, int limite){\r\n   HashSet<Integer> resultado = new HashSet<>();\r\n   for (Integer numero : lista){\r\n    if (numero > limite){\r\n        resultado.add(numero);\r\n    }\r\n   }\r\n   return resultado;     \r\n    }\r\n}	\N	1	El código es correcto y cumple con todos los requisitos del enunciado. Inicializa un `HashSet`, itera sobre el `ArrayList` y añade correctamente los números que son mayores que el valor límite. La lógica es clara y no presenta errores.	2026-04-30 22:34:44.442445+00	2026-04-30 22:34:44.442445+00	f	\N	\N
8c023dca-a0ad-4486-9a3a-de14ef9b5f3d	04e14093-1777-40ff-bee1-07c015be7fb8	a00d551e-3dc4-4966-b9f0-b05cbe043e99	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\nimport java.util.HashMap;\r\n\r\npublic class Solucion{\r\n    public HashSet<String>obtenerNombres(ArrayList<HashMap<String,String>>listaDeMapas){\r\n     HashSet<String>nombre = new HashSet<>();\r\n     for (HashMap<String,String> mapa : listaDeMapas){\r\n        (mapa.containsKey("nombre")){\r\n            nombre.add(mapa.get("nombre"));\r\n        }\r\n     }   \r\n     return nombre;\r\n    }\r\n\r\n}	\N	0.7	El código es casi correcto y sigue la lógica solicitada en la rúbrica. Sin embargo, tiene un error de sintaxis en el bucle for donde falta la palabra clave `if` antes de la condición `(mapa.containsKey("nombre"))`. Esto causaría un error de compilación. Una vez corregido, el código funcionaría perfectamente.	2026-04-30 22:34:31.676545+00	2026-04-30 22:34:31.676545+00	f	\N	\N
851f5940-2c7c-4f6e-b2ca-ee65ea989cb7	04e14093-1777-40ff-bee1-07c015be7fb8	f2764063-b03d-4d0b-aada-3e7ffdf1ab51	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class PermisoPersonal {\r\n    public ArrayList<String> PermisoAutorizados(ArrayList<String> personas, HashSet<String>autorizado){\r\n    ArrayList<String> resultado = new ArrayList<>();\r\n\r\n    for (String nombre : personas){\r\n        if \r\n        (autorizados.contains(nombre)){\r\n            resultado.add(nombre);\r\n        }\r\n    }    \r\n    return resultado;\r\n    }\r\n}	\N	1	El código es correcto y cumple con todos los requisitos. Crea un nuevo `ArrayList`, itera sobre la lista de personas y verifica la autorización con el `HashSet` de manera eficiente. La lógica es clara y no presenta errores. Muy bien nombrado.	2026-04-30 22:34:40.143949+00	2026-04-30 22:34:40.143949+00	f	\N	\N
6f2bd094-0aa6-47e2-8038-8af941a7901d	04e14093-1777-40ff-bee1-07c015be7fb8	38d231f4-4a55-48e5-a5ee-5ca9eab80d57	\N	\N	import java.util.HashMap;\r\nimport java.util.HashSet;\r\n\r\npublic class GestionGrupo{\r\n    public HashSet<String> obtenerPersonasUnicas(HashMap<String, HashSet<String>> grupos){\r\n        HashSet<String> todaslaspersonas = new HashSet<>();\r\n        for (HashSet<String> personasdelgrupo : grupos.values()){\r\n            todaslaspersonas.addAll(personasdelgrupo);\r\n        }\r\n    return todaslaspersonas;\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica esperada y no tiene errores. Cumple con la rúbrica al crear un `HashSet` para almacenar los nombres únicos e iterar sobre los valores del `HashMap` para añadir todos los elementos al conjunto de resultados.	2026-04-30 22:34:46.239994+00	2026-04-30 22:34:46.239994+00	f	\N	\N
9c62cb5a-7603-4020-84da-8167ac3710cf	8a71b60a-27b2-4bb2-a38e-993726c89c0e	a955431a-b9c4-4878-a64b-6874985640ac	\N	\N	import java.util.*;\r\npublic class puntoUno{\r\n    public static HashSet<String> getPuntoUno(ArrayList<String> lista){\r\n        return new HashSet<>(lista);\r\n    }\r\n    public static void main(String[] args){\r\n        ArrayList<String> lista = new ArrayList<>();\r\n        lista.add("Jean Paul");\r\n        lista.add("Juan");\r\n        lista.add("Viviana");\r\n        lista.add("Jean Paul");\r\n        lista.add("Viviana");\r\n    \r\n        HashSet<String> retorno = getPuntoUno(lista);\r\n        System.out.println(retorno);\r\n    }\r\n}	\N	1	El código es conciso y correcto. Aprovecha la funcionalidad de los constructores de `HashSet` para inicializarlo directamente a partir del `ArrayList`, lo cual es una manera eficiente y clara de resolver el problema. El manejo de tipos genéricos es adecuado y el método `main` demuestra su correcto funcionamiento.	2026-04-30 23:10:53.658498+00	2026-04-30 23:10:53.658498+00	f	\N	\N
f0ff6080-3c57-4b21-afa7-da3e237dd33b	8a71b60a-27b2-4bb2-a38e-993726c89c0e	4cd7583e-cd70-49d3-8cec-6a2f1052ec7c	\N	\N	import java.util.*;\r\n\r\npublic class puntoDos{\r\n    public static HashMap<Character, Integer> getConteo(String texto){\r\n        HashMap<Character, Integer> mapa = new HashMap<>();\r\n\r\n        for (int v = 0; v < texto.length(); v++){\r\n            char caracter = texto.charAt(v);\r\n\r\n            if (mapa.containsKey(caracter)){\r\n                mapa.put(caracter, mapa.get(caracter) + 1);\r\n            }else{\r\n                mapa.put(caracter, 1);\r\n            }\r\n        }\r\n        return mapa;\r\n    }\r\n    public static void main(String[] args){\r\n        String texto = "Jean Paul";\r\n        HashMap<Character, Integer> Resultado = getConteo(texto);\r\n        System.out.println(Resultado);\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica propuesta y maneja bien el conteo de caracteres. Compila y funciona como se espera.	2026-04-30 23:10:55.492171+00	2026-04-30 23:10:55.492171+00	f	\N	\N
a9a51e8d-3b27-4af9-a1e9-f8625d3d34e2	8a71b60a-27b2-4bb2-a38e-993726c89c0e	9a4435b4-6202-4f18-89d3-175f863e083f	\N	\N	import java.util.*;\r\n\r\npublic class puntoTres{\r\n\r\n    public static HashSet<Integer> getRepetidos(HashSet<Integer> valor1, HashSet<Integer> valor2){\r\n        HashSet<Integer> valorRepetido = new HashSet<>(valor1);\r\n        valorRepetido.retainAll(valor2);\r\n        return valorRepetido;\r\n    }\r\n\r\n    public static void main(String[] args){\r\n        HashSet<Integer> valor1 = new HashSet<>();\r\n        valor1.add(18);\r\n        valor1.add(10);\r\n        valor1.add(7);\r\n        valor1.add(19);\r\n        valor1.add(8);\r\n        valor1.add(2);\r\n\r\n        HashSet<Integer> valor2 = new HashSet<>();\r\n        valor2.add(18);\r\n        valor2.add(7);\r\n        valor2.add(19);\r\n        valor2.add(3);\r\n        valor2.add(8);\r\n        valor2.add(11);\r\n\r\n        HashSet<Integer> Resultado = getRepetidos(valor1, valor2);\r\n        System.out.println("valor1 " +valor1);\r\n        System.out.println("valor2 " +valor2);\r\n        System.out.println("Repetidos " +Resultado);\r\n    }\r\n}	\N	1	La solución es completamente correcta y eficiente. Utiliza el método `retainAll` de forma muy inteligente, lo que simplifica el código y lo hace más legible y eficiente que una iteración manual. Cumple con todos los requisitos del enunciado y la rúbrica, incluso superando la expectativa de una iteración manual al usar una función optimizada de la API de Java.	2026-04-30 23:10:57.611036+00	2026-04-30 23:10:57.611036+00	f	\N	\N
0ad55cf5-9918-4745-b199-475d076f06ef	8a71b60a-27b2-4bb2-a38e-993726c89c0e	a00d551e-3dc4-4966-b9f0-b05cbe043e99	\N	\N	import java.util.*; \r\n\r\npublic class puntoCuatro {\r\n\r\n    public static HashSet<String> getNombresUnicos(ArrayList<HashMap<String, String>> lista){\r\n        HashSet<String> nombres = new HashSet<>();\r\n\r\n        for (HashMap<String, String>mapa : lista){\r\n            if(mapa.containsKey("nombre")){\r\n                nombres.add(mapa.get("nombre"));\r\n            }\r\n        }\r\n        return nombres;\r\n    }\r\n\r\n    public static void main (String[] args) {\r\n        ArrayList<HashMap<String, String>> lista = new ArrayList<>();\r\n\r\n        HashMap<String, String> mapa1 = new HashMap<>();\r\n        mapa1.put("nombre","Jean Paul");\r\n        mapa1.put("Ciudad","Cali");\r\n\r\n        HashMap<String, String> mapa2 = new HashMap<>();\r\n        mapa2.put("nombre","Viviana");\r\n        mapa2.put("Ciudad","Popayan");\r\n        \r\n        HashMap<String, String> mapa3 = new HashMap<>();\r\n        mapa3.put("Ciudad","Santa Marta");\r\n        \r\n        HashMap<String, String> mapa4 = new HashMap<>();\r\n        mapa4.put("nombre","Jean Paul");\r\n        mapa4.put("Ciudad","Medellin");\r\n\r\n        lista.add(mapa1);\r\n        lista.add(mapa2);\r\n        lista.add(mapa3);\r\n        lista.add(mapa4);\r\n\r\n        HashSet<String> Resultado = getNombresUnicos(lista);\r\n        System.out.println(Resultado);\r\n    }\r\n}	\N	1	El código es correcto, sigue al pie de la letra la rúbrica, compila y funciona correctamente. El manejo de casos borde es adecuado, ignorando los mapas que no contienen la clave "nombre" y garantizando unicidad en los resultados mediante el uso de un `HashSet`. La claridad del código es excelente.	2026-04-30 23:11:00.060228+00	2026-04-30 23:11:00.060228+00	f	\N	\N
19dab04e-6bd4-45f2-8edc-18a9a5705d8d	56fdfe94-ff0b-4756-8ec6-1c5540d3b87d	8c015875-9c49-4b49-90ab-fff19b1b73af	\N	\N	import java.util.HashMap;\r\nimport java.util.ArrayList;\r\n\r\npublic ArrayList<String> convertirValoresALista(HashMap<Integer, String> mapa) {\r\n    if (mapa == null) {\r\n        return new ArrayList<>();\r\n    }\r\n    \r\n    return new ArrayList<>(mapa.values());\r\n}	\N	1	El código es conciso y correcto. La solución utiliza el constructor que recibe una colección, lo cual es muy eficiente. Además, se maneja el caso de un mapa nulo, devolviendo una lista vacía.	2026-05-01 00:56:39.147759+00	2026-05-01 00:56:39.147759+00	f	\N	\N
06b10908-2189-48c0-a522-6a7b621b48cb	8a71b60a-27b2-4bb2-a38e-993726c89c0e	4f2c49bf-48cb-4619-bcd7-b9cfa1e16d4b	\N	\N	import java.util.*;\r\npublic class puntoCinco {\r\n\r\n    public static int getSuma(HashMap<String, ArrayList<Integer>> mapa, String clave){\r\n        if(!mapa.containsKey(clave)){\r\n            return 0;\r\n        }\r\n\r\n        ArrayList<Integer> lista = mapa.get(clave);\r\n\r\n        if(lista.isEmpty()){\r\n            return 0;\r\n        }\r\n\r\n        int suma = 0;\r\n        for(int numero : lista){\r\n            suma += numero;\r\n        }\r\n        return suma;\r\n    }\r\n\r\n    public static void main(String[] args){\r\n        HashMap<String, ArrayList<Integer>> mapa = new HashMap<>();\r\n        \r\n        ArrayList<Integer> numeros1 = new ArrayList<>();\r\n        numeros1.add(30);\r\n        numeros1.add(20);\r\n        numeros1.add(30);\r\n        mapa.put("notas", numeros1);\r\n\r\n        ArrayList<Integer> numeros2 = new ArrayList<>();\r\n        mapa.put("vacio", numeros2);\r\n\r\n        System.out.println(getSuma(mapa, "notas"));\r\n        System.out.println(getSuma(mapa, "vacio"));\r\n        System.out.println(getSuma(mapa, "dia"));\r\n    }\r\n}	\N	1	El código es correcto y cumple con todos los requisitos del enunciado. Maneja adecuadamente los casos de clave no existente y `ArrayList` vacío. La lógica es clara y eficiente.	2026-04-30 23:11:01.709164+00	2026-04-30 23:11:01.709164+00	f	\N	\N
bd783de7-0f1f-4d12-99d8-50ff3d07e521	8a71b60a-27b2-4bb2-a38e-993726c89c0e	8c015875-9c49-4b49-90ab-fff19b1b73af	\N	\N	import java.util.*;\r\n\r\npublic class puntoOcho{\r\n\r\n    public static ArrayList<String> getValores(HashMap<Integer, String> mapa){\r\n        return new ArrayList<>(mapa.values());\r\n    }\r\n\r\n    public static void main(String[] args){\r\n        HashMap<Integer, String> mapa = new HashMap<>();\r\n        mapa.put(1, "Jean Paul");\r\n        mapa.put(2, "Juan");\r\n        mapa.put(3, "Viviana");\r\n        mapa.put(4, "Jhoan");\r\n        mapa.put(5, "Estefany");\r\n\r\n        ArrayList<String> Resultado = getValores(mapa);\r\n        System.out.println(Resultado);\r\n    }\r\n}	\N	1	La solución es concisa y correcta. Utiliza la construcción directa de un `ArrayList` a partir de la colección de valores del `HashMap`, lo cual es eficiente y demuestra un buen conocimiento de las APIs de Java.	2026-04-30 23:11:07.128836+00	2026-04-30 23:11:07.128836+00	f	\N	\N
be9ad65f-2157-4b25-b078-3fdda329e52d	8a71b60a-27b2-4bb2-a38e-993726c89c0e	56c3eeba-b046-424f-9989-45cce139e191	\N	\N	import java.util.*;\r\n\r\npublic class puntoSeis{\r\n\r\n    public static void mostrarPersonas(HashMap<String, ArrayList<String>> ciudades, String ciudad){\r\n        \r\n        if(!ciudades.containsKey(ciudad)){\r\n            System.out.println("la ciudad "+ ciudad +" no existe");\r\n            return;\r\n        }\r\n\r\n        ArrayList<String> Personas = ciudades.get(ciudad);\r\n\r\n        if(Personas.isEmpty()){\r\n            System.out.println("No hay personas registradas en "+ciudad);\r\n            return;\r\n        }\r\n\r\n        System.out.println("Personas en "+ ciudad+":");\r\n        for(String persona : Personas){\r\n            System.out.println(persona);\r\n        }\r\n    }\r\n\r\n    public static void main(String[] args){\r\n        HashMap<String, ArrayList<String>> ciudades = new HashMap<>();\r\n\r\n        ArrayList<String> Cali = new ArrayList<>();\r\n        Cali.add("Jean Paul");\r\n        Cali.add("Juan");\r\n        Cali.add("Isabella");\r\n        ciudades.put("Cali", Cali);\r\n\r\n        ArrayList<String> Popayan = new ArrayList<>();\r\n        Popayan.add("Viviana");\r\n        Popayan.add("Hamilton");\r\n        Popayan.add("Estefany");\r\n        ciudades.put("Popayan", Popayan);\r\n\r\n        mostrarPersonas(ciudades, "Cali");\r\n        System.out.println();\r\n        mostrarPersonas(ciudades, "Popayan");\r\n        System.out.println();\r\n        mostrarPersonas(ciudades, "Santa Marta");\r\n        System.out.println();\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica propuesta en el enunciado, aborda casos borde como ciudades no existentes o ciudades sin personas registradas, y la claridad es buena. Compila y funciona como se espera.	2026-04-30 23:11:03.645946+00	2026-04-30 23:11:03.645946+00	f	\N	\N
293a060a-ad72-4baf-9873-0d0a0333850c	8a71b60a-27b2-4bb2-a38e-993726c89c0e	5e4e5088-18de-40bd-8206-6f6d37ae4e94	\N	\N	import java.util.*;\r\n\r\npublic class puntoNueve {\r\n\r\n    public static HashSet<Integer> getMayores(ArrayList<Integer> numeros, int limite){\r\n        HashSet<Integer> Resultado = new HashSet<>();\r\n\r\n        for(int numero : numeros){\r\n            if(numero > limite){\r\n                Resultado.add(numero);\r\n            }\r\n        }\r\n        return Resultado;\r\n    }\r\n\r\n    public static void main(String[] args){\r\n        ArrayList<Integer> numeros =new ArrayList<>();\r\n        numeros.add(18);\r\n        numeros.add(19);\r\n        numeros.add(7);\r\n        numeros.add(8);\r\n        numeros.add(21);\r\n\r\n        int limite = 8;\r\n        HashSet<Integer> Resultado = getMayores(numeros, limite);\r\n        System.out.println("Limite: "+limite);\r\n        System.out.println("Mayores: "+Resultado);\r\n    }\r\n}	\N	1	El código es correcto. Inicializa un `HashSet`, itera sobre el `ArrayList` y añade los números que cumplen la condición. También se incluye un `main` para probar la funcionalidad.	2026-04-30 23:11:08.711416+00	2026-04-30 23:11:08.711416+00	f	\N	\N
30aa28d4-9d27-43dd-b863-43632e102441	8a71b60a-27b2-4bb2-a38e-993726c89c0e	f2764063-b03d-4d0b-aada-3e7ffdf1ab51	\N	\N	import java.util.*;\r\n\r\npublic class puntoSiete{\r\n\r\n    public static ArrayList<String> getAutorizados(ArrayList<String> personas, HashSet<String> autorizados){\r\n        ArrayList<String> Resultado = new ArrayList<>();\r\n\r\n        for (String persona : personas  ){\r\n            if(autorizados.contains(persona)){\r\n                Resultado.add(persona);\r\n            }            \r\n        }\r\n        return Resultado;\r\n    }\r\n\r\n    public static void main(String[] args){\r\n         ArrayList<String> personas = new ArrayList<>();\r\n         personas.add("Jean Paul");\r\n         personas.add("Viviana");\r\n         personas.add("Juan");\r\n         personas.add("Isabella");\r\n         personas.add("Estefany");\r\n\r\n         HashSet<String> autorizados = new HashSet<>();\r\n         autorizados.add("Jean Paul");\r\n         autorizados.add("Viviana");\r\n         autorizados.add("Cristian");\r\n\r\n         ArrayList<String> Resultado = getAutorizados(personas, autorizados);\r\n         System.out.println("Personas Autorizadas: "+Resultado);\r\n    }\r\n}	\N	1	El código es correcto y cumple con todos los requisitos. La lógica es impecable, maneja correctamente los tipos de datos y produce el resultado esperado. Además, incluye un método `main` para probar la funcionalidad, lo cual es un plus. No hay errores graves ni casos borde sin manejar.	2026-04-30 23:11:05.695472+00	2026-04-30 23:11:05.695472+00	f	\N	\N
8db60e5f-0712-4601-a271-3a8b405781c8	8a71b60a-27b2-4bb2-a38e-993726c89c0e	38d231f4-4a55-48e5-a5ee-5ca9eab80d57	\N	\N	import java.util.*;\r\npublic class puntoDiez{\r\n\r\n    public static HashSet<String> getPersonasUnicas(HashMap<String, HashSet<String>> grupos){\r\n        HashSet<String> personas = new HashSet<>();\r\n\r\n        for(HashSet<String> miembros : grupos.values()){\r\n            personas.addAll(miembros);\r\n        }\r\n        return personas;\r\n    }\r\n\r\n    public static void main(String[] args){\r\n        HashMap<String, HashSet<String>> grupos = new HashMap<>();\r\n\r\n        HashSet<String> grupo1 = new HashSet<>();\r\n        grupo1.add("Jean Paul");\r\n        grupo1.add("Juan");\r\n        grupo1.add("Viviana");\r\n        grupos.put("Grupo 1", grupo1);\r\n\r\n        HashSet<String> grupo2 = new HashSet<>();\r\n        grupo2.add("Estefy");\r\n        grupo2.add("Juan");\r\n        grupo2.add("Isabella");\r\n        grupos.put("Grupo 2", grupo2);\r\n\r\n        HashSet<String> Resultado = getPersonasUnicas(grupos);\r\n        System.out.println("personas Unicas" + Resultado);\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica propuesta en la rúbrica, maneja adecuadamente los tipos de datos y los casos borde (como nombres repetidos entre grupos) y es claro. Se incluye un test case apropiado para verificar su funcionamiento.	2026-04-30 23:11:10.408156+00	2026-04-30 23:11:10.408156+00	f	\N	\N
bb68abba-b689-425c-85a6-a78e13cf663f	56fdfe94-ff0b-4756-8ec6-1c5540d3b87d	a955431a-b9c4-4878-a64b-6874985640ac	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class Ejemplo {\r\n\r\n    public static HashSet<String> obtenerUnicos(ArrayList<String> lista) {\r\n     HashSet<String> unicos = new HashSet<>(lista);\r\n    return unicos;\r\n    }\r\n    \r\n}	\N	1	El código es conciso y correcto. Aprovecha la capacidad del constructor de `HashSet` para inicializarlo directamente con los elementos de la `ArrayList`, lo que es una muy buena práctica.	2026-05-01 00:56:11.612581+00	2026-05-01 00:56:11.612581+00	f	\N	\N
22d8fb56-2faa-4c86-8a2b-db64d3d419ec	56fdfe94-ff0b-4756-8ec6-1c5540d3b87d	4cd7583e-cd70-49d3-8cec-6a2f1052ec7c	\N	\N	import java.util.HashMap;\r\n\r\npublic class Ejemplo {\r\n\r\n    public static HashMap<Character, Integer> contarCaracteres(String texto) {\r\n        HashMap<Character, Integer> resultado = new HashMap<>();\r\n\r\n        for (char letra : texto.toCharArray()) {\r\n         if (resultado.containsKey(letra)) {\r\n         resultado.put(letra, resultado.get(letra) + 1);\r\n            } \r\n            else {\r\n     resultado.put(letra, 1);\r\n            }\r\n        }\r\n\r\n    return resultado;\r\n    }\r\n}	\N	1	El código es correcto, sigue al pie de la letra la rúbrica y cumple con el enunciado. La lógica es clara y maneja adecuadamente los caracteres.	2026-05-01 00:56:13.296596+00	2026-05-01 00:56:13.296596+00	f	\N	\N
e8ba8766-a0d3-413a-a62d-61bc86383604	56fdfe94-ff0b-4756-8ec6-1c5540d3b87d	9a4435b4-6202-4f18-89d3-175f863e083f	\N	\N	import java.util.HashSet;\r\n\r\npublic class Ejemplo {\r\n\r\n    public static HashSet<Integer> interseccion(HashSet<Integer> a, HashSet<Integer> b) {\r\n    HashSet<Integer> resultado = new HashSet<>(a);\r\n     resultado.retainAll(b);\r\n     return resultado;\r\n    }\r\n}	\N	1	La solución es completamente correcta y eficiente. Utiliza el método `retainAll` de forma muy efectiva para encontrar la intersección de los conjuntos, lo cual es una forma idiomática y performante en Java. Además, cumple con todos los requisitos de la rúbrica al crear un nuevo `HashSet` y contener la intersección.	2026-05-01 00:56:15.835654+00	2026-05-01 00:56:15.835654+00	f	\N	\N
4f79ea4e-a3b6-45d9-a4c4-f100bf6d3bf9	56fdfe94-ff0b-4756-8ec6-1c5540d3b87d	a00d551e-3dc4-4966-b9f0-b05cbe043e99	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashMap;\r\nimport java.util.HashSet;\r\n\r\npublic class Ejemplo {\r\n\r\n    public static HashSet<String> obtenerNombres(ArrayList<HashMap<String, String>> lista) {\r\n        HashSet<String> resultado = new HashSet<>();\r\n for (HashMap<String, String> mapa : lista) {\r\n         if (mapa.containsKey("nombre")) {\r\n                resultado.add(mapa.get("nombre"));\r\n            }\r\n        } return resultado;\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica esperada y maneja adecuadamente el caso de que un mapa no contenga la clave "nombre". Compila y es claro.	2026-05-01 00:56:28.231314+00	2026-05-01 00:56:28.231314+00	f	\N	\N
1408c28c-e193-48f2-8b96-cae178fe8436	56fdfe94-ff0b-4756-8ec6-1c5540d3b87d	4f2c49bf-48cb-4619-bcd7-b9cfa1e16d4b	\N	\N	import java.util.HashMap;\r\nimport java.util.ArrayList;\r\n\r\npublic int sumarListaPorClave(HashMap<String, ArrayList<Integer>> mapa, String clave) {\r\n    \r\n    if (mapa != null && mapa.containsKey(clave)) {\r\n        ArrayList<Integer> lista = mapa.get(clave);\r\n        \r\n        if (lista != null && !lista.isEmpty()) {\r\n            int suma = 0;\r\n            for (Integer numero : lista) {\r\n                suma += numero;\r\n            } return suma;\r\n        }\r\n    }\r\n    \r\n    return 0;\r\n}	\N	1	El código es correcto, maneja todos los casos borde especificados (clave no existente, ArrayList nulo o vacío) y la lógica es impecable. Un excelente trabajo.	2026-05-01 00:56:30.511858+00	2026-05-01 00:56:30.511858+00	f	\N	\N
fe238035-8e28-4ee1-b5d8-3dc3cdc5f06a	56fdfe94-ff0b-4756-8ec6-1c5540d3b87d	56c3eeba-b046-424f-9989-45cce139e191	\N	\N	import java.util.HashMap;\r\nimport java.util.ArrayList;\r\n\r\npublic class RegistroCiudades {\r\n    public static void main(String[] args) {\r\n        HashMap<String, ArrayList<String>> censo = new HashMap<>();\r\n        censo.put("Cali", new ArrayList<>());\r\n        censo.get("Cali").add("Valentina");\r\n        censo.get("Cali").add("Andrés");\r\n        censo.put("Bogotá", new ArrayList<>());\r\n        censo.get("Bogotá").add("Alejandro");\r\n        censo.get("Bogotá").add("Fabian");\r\n\r\n        String ciudadBusqueda = "Cali";\r\n        \r\n        if (censo.containsKey(ciudadBusqueda)) {\r\n            System.out.println("Personas en " + ciudadBusqueda + ":");\r\n            ArrayList<String> personas = censo.get(ciudadBusqueda);\r\n            \r\n            for (String nombre : personas) {\r\n                System.out.println("- " + nombre);\r\n            }\r\n        } else {\r\n            System.out.println("La ciudad no se encuentra en el registro.");\r\n        }\r\n    }\r\n}	\N	1	El código es correcto, sigue todas las instrucciones al pie de la letra y demuestra un buen entendimiento del uso de `HashMap` y `ArrayList` en Java. Además, maneja correctamente el caso donde la ciudad no se encuentra en el registro.	2026-05-01 00:56:33.399246+00	2026-05-01 00:56:33.399246+00	f	\N	\N
50e7233e-4168-4fb0-87ad-6ed380429fa5	56fdfe94-ff0b-4756-8ec6-1c5540d3b87d	f2764063-b03d-4d0b-aada-3e7ffdf1ab51	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic class FiltroAcceso {\r\n\r\n    public ArrayList<String> obtenerPersonasAutorizadas(ArrayList<String> personas, HashSet<String> autorizados) {\r\n       \r\n        ArrayList<String> resultado = new ArrayList<>();\r\n        if (personas == null || autorizados == null) {\r\n            return resultado;\r\n        }\r\n        for (String nombre : personas) {\r\n         \r\n            if (autorizados.contains(nombre)) {\r\n                resultado.add(nombre);\r\n            }\r\n        }\r\n        return resultado;\r\n    }\r\n}	\N	1	El código es correcto, sigue la lógica esperada y maneja el caso de entrada nula para las listas. La claridad es buena y el código es funcional.	2026-05-01 00:56:35.196919+00	2026-05-01 00:56:35.196919+00	f	\N	\N
b0ec02a3-09ce-4ac2-ac8c-6b9553ca2e90	56fdfe94-ff0b-4756-8ec6-1c5540d3b87d	38d231f4-4a55-48e5-a5ee-5ca9eab80d57	\N	\N	import java.util.HashMap;\r\nimport java.util.HashSet;\r\n\r\npublic HashSet<String> consolidarPersonas(HashMap<String, HashSet<String>> grupos) {\r\n    HashSet<String> listaMaestra = new HashSet<>();\r\n    \r\n    if (grupos != null) {\r\n        for (HashSet<String> grupo : grupos.values()) {\r\n            listaMaestra.addAll(grupo);\r\n        }\r\n    }\r\n    \r\n    return listaMaestra;\r\n}	\N	1	El código es correcto, sigue la lógica esperada y maneja adecuadamente el caso de entrada nula para el mapa. La solución es clara y eficiente.	2026-05-01 00:56:53.526777+00	2026-05-01 00:56:53.526777+00	f	\N	\N
00e36d6a-591b-4003-8b6c-904c8f00a45c	56fdfe94-ff0b-4756-8ec6-1c5540d3b87d	5e4e5088-18de-40bd-8206-6f6d37ae4e94	\N	\N	import java.util.ArrayList;\r\nimport java.util.HashSet;\r\n\r\npublic HashSet<Integer> filtrarMayores(ArrayList<Integer> lista, int limite) {\r\n    HashSet<Integer> resultado = new HashSet<>();\r\n    \r\n    if (lista != null) {\r\n        for (int num : lista) {\r\n            if (num > limite) {\r\n                resultado.add(num);\r\n            }\r\n        }\r\n    }\r\n    \r\n    return resultado;\r\n}	\N	1	El código es correcto y cumple con todos los requisitos de la rúbrica. Maneja adecuadamente el caso de una lista nula. La lógica es clara y el uso de `HashSet` para evitar duplicados es apropiado.	2026-05-01 00:56:51.562865+00	2026-05-01 00:56:51.562865+00	f	\N	\N
9cdef657-590a-468c-a521-fb54a7cae6dc	b7c820da-c5d2-430f-8fb0-c174ef3ad7c7	a955431a-b9c4-4878-a64b-6874985640ac	\N	\N	public static HashSet<String> obtenerUnicos(ArrayList<String> lista) {\r\n    return new HashSet<>(lista);\r\n}	\N	1	El código es conciso, correcto y eficiente. Aprovecha el constructor de `HashSet` que recibe una `Collection` para inicializarlo con los elementos únicos del `ArrayList`.	2026-05-01 04:57:28.967534+00	2026-05-01 04:57:28.967534+00	f	\N	\N
ef1ad4fc-b892-48f4-9e43-17f9739e04e5	b7c820da-c5d2-430f-8fb0-c174ef3ad7c7	4cd7583e-cd70-49d3-8cec-6a2f1052ec7c	\N	\N	import java.util.HashMap;\r\n\r\npublic static HashMap<Character, Integer> contarCaracteres(String str) {\r\n    HashMap<Character, Integer> mapa = new HashMap<>();\r\n    \r\n    for (char c : str.toCharArray()) {\r\n        mapa.put(c, mapa.getOrDefault(c, 0) + 1);\r\n    }\r\n    \r\n    return mapa;\r\n}	\N	1	La solución es completamente correcta y eficiente. Utiliza `getOrDefault` de manera excelente, lo que simplifica y optimiza el código. Además, sigue la rúbrica al pie de la letra.	2026-05-01 04:57:31.719805+00	2026-05-01 04:57:31.719805+00	f	\N	\N
32a99240-831f-494a-a4d9-3ba1a4e41f07	b7c820da-c5d2-430f-8fb0-c174ef3ad7c7	9a4435b4-6202-4f18-89d3-175f863e083f	\N	\N	public static HashSet<Integer> interseccion(HashSet<Integer> set1, HashSet<Integer> set2) {\r\n    HashSet<Integer> resultado = new HashSet<>(set1);\r\n    resultado.retainAll(set2);\r\n    return resultado;\r\n}	\N	1	La solución del estudiante es correcta, eficiente y concisa. Utiliza el método `retainAll` de `HashSet`, que es una forma idiomática y performante de calcular la intersección. Cumple con todos los requisitos de la rúbrica al crear un nuevo `HashSet` y contener la intersección de ambos sets de entrada. Aunque no itera explícitamente como sugiere la rúbrica (sino que usa un método interno optimizado), el resultado es el mismo y la eficiencia es superior.	2026-05-01 04:57:34.836301+00	2026-05-01 04:57:34.836301+00	f	\N	\N
f9c8f459-e5cf-4672-a5a4-ee1d9a0113cb	b7c820da-c5d2-430f-8fb0-c174ef3ad7c7	a00d551e-3dc4-4966-b9f0-b05cbe043e99	\N	\N	public static HashSet<String> obtenerNombres(ArrayList<HashMap<String, String>> lista) {\r\n    HashSet<String> nombres = new HashSet<>();\r\n    \r\n    for (HashMap<String, String> mapa : lista) {\r\n        if (mapa.containsKey("nombre")) {\r\n            nombres.add(mapa.get("nombre"));\r\n        }\r\n    }\r\n    \r\n    return nombres;\r\n}	\N	1	El código es correcto y cumple con todos los requisitos del enunciado. Inicializa un `HashSet`, itera sobre el `ArrayList`, verifica la existencia de la clave "nombre" y añade el valor si existe. Es eficiente y claro.	2026-05-01 04:57:36.879109+00	2026-05-01 04:57:36.879109+00	f	\N	\N
a0ff7f9c-5191-4642-91e1-09a6d02ac074	b7c820da-c5d2-430f-8fb0-c174ef3ad7c7	4f2c49bf-48cb-4619-bcd7-b9cfa1e16d4b	\N	\N	public static int sumarPorClave(HashMap<String, ArrayList<Integer>> mapa, String clave) {\r\n    if (!mapa.containsKey(clave) || mapa.get(clave).isEmpty()) {\r\n        return 0;\r\n    }\r\n    \r\n    int suma = 0;\r\n    for (int num : mapa.get(clave)) {\r\n        suma += num;\r\n    }\r\n    return suma;\r\n}	\N	0.7	El código es funcionalmente correcto para la mayoría de los casos. Sin embargo, no maneja adecuadamente el caso en que `mapa.get(clave)` devuelve `null`. En ese escenario, `mapa.get(clave).isEmpty()` lanzaría un `NullPointerException` (error de puntero nulo). Se debería agregar una verificación explícita para `null` antes de llamar a `isEmpty()`.	2026-05-01 04:57:39.704504+00	2026-05-01 04:57:39.704504+00	f	\N	\N
7c1dd08f-2af8-460a-a371-75a409b1f399	b7c820da-c5d2-430f-8fb0-c174ef3ad7c7	56c3eeba-b046-424f-9989-45cce139e191	\N	\N	import java.util.HashMap;\r\nimport java.util.ArrayList;\r\n\r\npublic class Main {\r\n    public static void main(String[] args) {\r\n        HashMap<String, ArrayList<String>> ciudades = new HashMap<>();\r\n\r\n        // Poblar el HashMap\r\n        ArrayList<String> personasCali = new ArrayList<>();\r\n        personasCali.add("Juan");\r\n        personasCali.add("María");\r\n        personasCali.add("Pedro");\r\n        ciudades.put("Cali", personasCali);\r\n\r\n        ArrayList<String> personasBogota = new ArrayList<>();\r\n        personasBogota.add("Ana");\r\n        personasBogota.add("Luis");\r\n        ciudades.put("Bogotá", personasBogota);\r\n\r\n        // Imprimir personas de una ciudad específica\r\n        String ciudadBuscada = "Cali";\r\n        if (ciudades.containsKey(ciudadBuscada)) {\r\n            System.out.println("Personas en " + ciudadBuscada + ":");\r\n            for (String persona : ciudades.get(ciudadBuscada)) {\r\n                System.out.println("- " + persona);\r\n            }\r\n        } else {\r\n            System.out.println("Ciudad no encontrada.");\r\n        }\r\n    }\r\n}	\N	1	El código es correcto, sigue al pie de la letra el enunciado y la rúbrica. Declara e inicializa el HashMap correctamente, añade dos ciudades con sus listas de personas y muestra las personas de una ciudad específica, manejando el caso de ciudad no encontrada. Muy bien.	2026-05-01 04:57:41.812559+00	2026-05-01 04:57:41.812559+00	f	\N	\N
6446b5fb-f720-4305-ab58-4832f66a6756	b7c820da-c5d2-430f-8fb0-c174ef3ad7c7	f2764063-b03d-4d0b-aada-3e7ffdf1ab51	\N	\N	public static ArrayList<String> filtrarAutorizados(ArrayList<String> personas, HashSet<String> autorizados) {\r\n    ArrayList<String> resultado = new ArrayList<>();\r\n    \r\n    for (String persona : personas) {\r\n        if (autorizados.contains(persona)) {\r\n            resultado.add(persona);\r\n        }\r\n    }\r\n    \r\n    return resultado;\r\n}	\N	1	El código es correcto, sigue la lógica propuesta en la rúbrica y maneja adecuadamente los tipos de datos. Es claro y conciso.	2026-05-01 04:57:43.39228+00	2026-05-01 04:57:43.39228+00	f	\N	\N
9f555230-2fd8-44bb-b773-c12f676e9d7d	b7c820da-c5d2-430f-8fb0-c174ef3ad7c7	8c015875-9c49-4b49-90ab-fff19b1b73af	\N	\N	public static ArrayList<String> obtenerValores(HashMap<Integer, String> mapa) {\r\n    return new ArrayList<>(mapa.values());\r\n}	\N	1	El código es conciso y correcto, utilizando una característica conveniente de la API de Java para inicializar directamente el `ArrayList` con los valores del mapa. Cumple perfectamente con los requisitos de la rúbrica.	2026-05-01 04:57:45.623642+00	2026-05-01 04:57:45.623642+00	f	\N	\N
c3a9804a-524b-4bf0-bc3a-0132da63b7cf	b7c820da-c5d2-430f-8fb0-c174ef3ad7c7	5e4e5088-18de-40bd-8206-6f6d37ae4e94	\N	\N	public static HashSet<Integer> mayoresQue(ArrayList<Integer> lista, int limite) {\r\n    HashSet<Integer> resultado = new HashSet<>();\r\n    \r\n    for (int num : lista) {\r\n        if (num > limite) {\r\n            resultado.add(num);\r\n        }\r\n    }\r\n    \r\n    return resultado;\r\n}	\N	1	El código es correcto, sigue al pie de la letra la rúbrica y funciona perfectamente. Es eficiente y claro.	2026-05-01 04:57:47.384016+00	2026-05-01 04:57:47.384016+00	f	\N	\N
d1253554-5a6c-4eba-8aae-1dba53e31769	b7c820da-c5d2-430f-8fb0-c174ef3ad7c7	38d231f4-4a55-48e5-a5ee-5ca9eab80d57	\N	\N	public static HashSet<String> todasLasPersonas(HashMap<String, HashSet<String>> grupos) {\r\n    HashSet<String> resultado = new HashSet<>();\r\n    \r\n    for (HashSet<String> miembros : grupos.values()) {\r\n        resultado.addAll(miembros);\r\n    }\r\n    \r\n    return resultado;\r\n}	\N	1	El código es correcto, sigue la lógica propuesta en la rúbrica y es claro. Maneja bien los casos borde de `HashMap` vacío o `HashSet` de miembros vacíos, ya que `addAll` no causaría errores en esos escenarios y el `HashSet` resultante se mantendría vacío o con los elementos correctos. Compila y funciona como se espera.	2026-05-01 04:57:49.697548+00	2026-05-01 04:57:49.697548+00	f	\N	\N
6675b137-5f13-409e-8e2f-3470d8ecbfe1	c66cd9f5-10f6-4bd5-b323-1cd8465b45b2	3dac62cb-7d00-43b9-9fae-acebc0d7b37c	\N	\N	\N	classDiagram\n    class Cliente {\n        +int id\n        +String nombre\n        +String email\n        +String telefono\n        +String direccion\n        +List~Pedido~ pedidos\n        +agregarPedido(pedido: Pedido)\n        +eliminarPedido(pedidoId: int)\n        +obtenerPedidos() List~Pedido~\n    }\n    class Pedido {\n        +int id\n        +Date fecha\n        +float total\n        +String estado\n        +List~Producto~ productos\n        +calcularTotal() float\n        +actualizarEstado(estado: String)\n    }\n    Cliente "1" --> "*" Pedido : tiene\n    Pedido "*" --> "1" Cliente : pertenece a	0.4	El diagrama de clases presenta varios problemas. En primer lugar, la sintaxis no es válida para Mermaid, ya que las listas de atributos y métodos deben ir sin el signo `+` y los tipos de datos no se especifican con `List~Tipo~` sino directamente con `Tipo[]` o se omite para relaciones. En segundo lugar, aunque intenta representar la relación entre `Cliente` y `Pedido`, la multiplicidad está incorrectamente indicada en la relación `Pedido` -> `Cliente`. Un `Pedido` siempre pertenece a un `Cliente`, por lo que la relación debería ser 1 a 1, no de muchos a 1. Además, se añaden atributos y métodos que no son parte de los requisitos, como `email`, `telefono`, `estado`, `productos` y varios métodos en ambas clases.	2026-05-03 20:48:23.138027+00	2026-05-03 20:48:23.138027+00	f	\N	\N
59cb967d-b1ee-4074-a19e-f71c3213be9b	c66cd9f5-10f6-4bd5-b323-1cd8465b45b2	7b49e872-1d23-4a77-b9df-162f0beefd7f	\N	\N	\N	classDiagram\n    class Libro {\n        +int id\n        +String titulo\n        +String isbn\n        +int añoPublicacion\n        +int numeroPaginas\n        +List~Autor~ autores\n        +Editorial editorial\n        +agregarAutor(autor: Autor)\n        +eliminarAutor(autor: Autor)\n        +obtenerDetalles() String\n    }\n    class Autor {\n        +int id\n        +String nombre\n        +String apellido\n        +Date fechaNacimiento\n        +String nacionalidad\n        +List~Libro~ libros\n        +escribirLibro(libro: Libro)\n        +obtenerLibros() List~Libro~\n    }\n    class Editorial {\n        +int id\n        +String nombre\n        +String direccion\n        +String telefono\n        +String email\n        +List~Libro~ librosPublicados\n        +publicarLibro(libro: Libro)\n        +obtenerCatalogo() List~Libro~\n    }\n    Libro "*" --> "*" Autor : tiene autores\n    Libro "*" --> "1" Editorial : publicado por\n    Autor "*" --> "*" Libro : escribe\n    Editorial "1" --> "*" Libro : publica	0.4	Tu diagrama de clases en Mermaid presenta algunos problemas significativos. Si bien la sintaxis general es válida, no cumple completamente con las especificaciones de la rúbrica y hay redundancias en las relaciones.  \n\n**Observaciones:**\n\n*   **Relaciones Uno a Muchos y Muchos a Muchos (Manejo de colecciones):** Para relaciones muchos a muchos entre `Libro` y `Autor`, y uno a muchos entre `Editorial` y `Libro`, es común ver que la clase "muchos" contenga una referencia al "uno" (o a una lista de "unos" si es muchos a muchos). Sin embargo, en tu diagrama, cada clase define listas de objetos de las clases con las que se relaciona, por ejemplo, `Libro` tiene una lista de `Autor` y `Autor` tiene una lista de `Libro`. Esto es redundante, ya que la relación muchos a muchos se establece de forma explícita en las líneas que definen la relación. Además, si `Libro` tiene una `Editorial`, y `Editorial` tiene una lista de `Libro`, esta también es una duplicación de la relación. En un diagrama de clases, la definición de la relación (`Libro "*" --> "*" Autor`) es suficiente para indicar la cardinalidad, y los atributos de navegación (`autores` en `Libro` y `libros` en `Autor`) suelen ser inferidos o se añaden si se necesita especificar una dirección de navegación particular. La forma en que lo has hecho es programáticamente correcta, pero menos estándar en un diagrama de clases UML/Mermaid simplificado, y puede llevar a confusiones. Si el objetivo es solo el diagrama de clases, no es necesario que las clases contengan las listas de objetos relacionados. La explicitación de la cardinalidad en la flecha es lo crucial. No obstante, no lo califico como incorrecto, sino como una práctica menos común en diagramas de clases, dependiendo del nivel de detalle que se quiera representar. En este contexto, te has desviado un poco de lo canónico.\n*   **Relaciones Redundantes:** Has definido la relación muchos a muchos entre `Libro` y `Autor` dos veces: `Libro "*" --> "*" Autor : tiene autores` y `Autor "*" --> "*" Libro : escribe`. Una de ellas es suficiente. Se entiende que si un libro tiene autores, viceversa. Lo mismo aplica a las relaciones entre `Editorial` y `Libro`. `Libro "*" --> "1" Editorial : publicado por` y `Editorial "1" --> "*" Libro : publica` expresan la misma relación por duplicado.\n*   **Atributos No Solicitados:** Incluyes atributos que no fueron especificados en la rúbrica, como `numeroPaginas` en `Libro`, `fechaNacimiento` en `Autor`, y `telefono`, `email` en `Editorial`. Esto no es necesariamente incorrecto, pero no aporta al cumplimiento estricto de la rúbrica.\n*   **Métodos no solicitados:** Has añadido métodos como `agregarAutor`, `eliminarAutor`, `obtenerDetalles`, `escribirLibro`, `obtenerLibros`, `publicarLibro`, `obtenerCatalogo`. El enunciado pedía exclusivamente el diseño del diagrama de clases con atributos y relaciones, no su comportamiento. La inclusión de estos métodos distrae del objetivo principal y no suma puntos según la rúbrica.\n*   **Tipos de datos:** Los tipos de datos como "List~Autor~" o "List~Libro~" son correctos para Mermaid, pero si el objetivo era apegarse a un diagrama de clases más estándar, se podrían haber omitido las colecciones en la clase misma y depender únicamente de las relaciones explícitas.\n\nEn la rúbrica se pedía el diseño de un diagrama de clases *sencillo* con atributos y relaciones específicas. Tu solución es más detallada de lo necesario y duplica información importante.	2026-05-03 20:48:29.536671+00	2026-05-03 20:48:29.536671+00	f	\N	\N
1976ad70-1149-432c-b8f6-4bd9a0080deb	c66cd9f5-10f6-4bd5-b323-1cd8465b45b2	14d2915f-471d-4ed7-966b-6c7a564948e9	\N	\N	\N	classDiagram\n    class Vehiculo {\n        +String marca\n        +String modelo\n        +int año\n        +String color\n        +String numeroSerie\n        +float velocidadActual\n        +acelerar(velocidad: float)\n        +frenar(velocidad: float)\n        +obtenerInfo() String\n    }\n    class Coche {\n        +int numeroPuertas\n        +String tipoCombustible\n        +int capacidadPasajeros\n        +boolean aireAcondicionado\n        +abrirMaletero()\n        +cerrarMaletero()\n    }\n    class Moto {\n        +int cilindrada\n        +String tipoMoto\n        +boolean tieneSidecar\n        +int numeroRuedas\n        +hacerCaballito()\n        +ponerSoporte()\n    }\n    class Camion {\n        +float capacidadCarga\n        +int numeroEjes\n        +String tipoCarroceria\n        +boolean tieneRemolque\n        +cargar(peso: float)\n        +descargar()\n    }\n    Vehiculo <|-- Coche : hereda\n    Vehiculo <|-- Moto : hereda\n    Vehiculo <|-- Camion : hereda	0.7	El diagrama es sintácticamente válido y representa correctamente la herencia solicitada. Sin embargo, no se adhiere completamente a la rúbrica al incluir demasiados atributos y métodos en las clases, algunos de los cuales no fueron solicitados. La rúbrica pedía un solo atributo común en la clase base y un atributo específico para cada clase derivada, el estudiante agregó más de los pedidos.	2026-05-03 20:48:31.907703+00	2026-05-03 20:48:31.907703+00	f	\N	\N
a70655bc-58cc-4a38-98f4-bfb19e6b15ea	c66cd9f5-10f6-4bd5-b323-1cd8465b45b2	4c3e411f-4e15-4a56-bad6-50733ca519e2	\N	\N	\N	classDiagram\n    class Curso {\n        +int id\n        +String titulo\n        +String descripcion\n        +Date fechaInicio\n        +Date fechaFin\n        +Profesor profesor\n        +List~Estudiante~ estudiantes\n        +agregarEstudiante(estudiante: Estudiante)\n        +eliminarEstudiante(estudiante: Estudiante)\n        +obtenerEstudiantes() List~Estudiante~\n    }\n    class Profesor {\n        +int id\n        +String nombre\n        +String email\n        +String especialidad\n        +List~Curso~ cursos\n        +agregarCurso(curso: Curso)\n        +eliminarCurso(curso: Curso)\n        +obtenerCursos() List~Curso~\n    }\n    class Estudiante {\n        +int id\n        +String nombre\n        +String email\n        +Date fechaNacimiento\n        +List~Curso~ cursosInscritos\n        +inscribirseCurso(curso: Curso)\n        +desinscribirseCurso(curso: Curso)\n        +obtenerCursos() List~Curso~\n    }\n    Curso "*" --> "1" Profesor : impartido por\n    Profesor "1" --> "*" Curso : imparte\n    Curso "*" --> "*" Estudiante : tiene estudiantes\n    Estudiante "*" --> "*" Curso : inscrito en	0.9	La sintaxis Mermaid es válida y el diagrama representa la mayoría de los requisitos. Sin embargo, hay un problema con las relaciones: 'Curso "*" --> "1" Profesor : impartido por' y 'Profesor "1" --> "*" Curso : imparte' son redundantes y deberían ser una sola relación. También, los nombres de los atributos no coinciden exactamente con la rúbrica (ej. `id_curso` vs `id`, `nombre` vs `titulo`).	2026-05-03 20:48:33.949251+00	2026-05-03 20:48:33.949251+00	f	\N	\N
65a08ec4-0b9b-4c52-827f-d44720b2bbae	c66cd9f5-10f6-4bd5-b323-1cd8465b45b2	d10e9727-1846-443e-a7f8-346487050b0f	\N	\N	\N	classDiagram\n    class Ordenador {\n        +String id\n        +String marca\n        +String modelo\n        +int ramGB\n        +String tipoRAM\n        +int almacenamientoGB\n        +String tipoAlmacenamiento\n        +CPU cpu\n        +encender()\n        +apagar()\n        +reiniciar()\n        +obtenerEspecificaciones() String\n    }\n    class CPU {\n        +String marca\n        +String modelo\n        +float velocidadGHz\n        +int nucleos\n        +int hilos\n        +String arquitectura\n        +boolean tieneGPUIntegrada\n        +procesar(datOS)\n        +obtenerTemperatura() float\n    }\n    Ordenador "1" *-- "1" CPU : tiene (composición)	0.8	El diagrama es sintácticamente válido y representa correctamente la composición entre las clases. Sin embargo, no se incluyeron los atributos de clave primaria y la multiplicidad en el lado de CPU debería ser 1, no "1" en la etiqueta de la relación.	2026-05-03 20:48:35.983657+00	2026-05-03 20:48:35.983657+00	f	\N	\N
f24c3f6f-e7e2-46fb-9533-848c9db8d85c	c66cd9f5-10f6-4bd5-b323-1cd8465b45b2	5d6e60ce-8be0-4778-94a2-18b54fad7665	\N	\N	\N	classDiagram\n    class Equipo {\n        +int id\n        +String nombre\n        +String ciudad\n        +String liga\n        +List~Jugador~ jugadores\n        +agregarJugador(jugador: Jugador)\n        +eliminarJugador(jugador: Jugador)\n        +obtenerJugadores() List~Jugador~\n    }\n    class Jugador {\n        +int id\n        +String nombre\n        +String apellido\n        +Date fechaNacimiento\n        +String posicion\n        +Date fechaIngreso\n        +cambiarEquipo(equipo: Equipo)\n        +obtenerEstadisticas()\n    }\n    Equipo "1" o-- "*" Jugador : tiene (agregación)	0.3	El diagrama presenta varios errores en relación a la rúbrica:\n\n1.  **Tipo de relación incorrecto:** Se solicitó "agregación", pero el estudiante usó una agregación compositiva (rombo lleno). La agregación simple (rombo vacío) es la que se ajusta a la agregación.\n2.  **Atributos no solicitados y atributos faltantes:** Se incluyeron atributos no solicitados (`ciudad`, `liga`, `apellido`, `fechaNacimiento`, `fechaIngreso`) y se omitieron `deporte` en Equipo.\n3.  **La multiplicidad es incorrecta:** La multiplicidad muestra que `Equipo` tiene "1" y `Jugador` tiene "*", lo cual es incorrecto según la descripción "Un equipo tiene varios jugadores, y un jugador puede pertenecer a varios equipos a lo largo de su carrera pero solo a uno en un momento dado".\n4.  **Atributos adicionales (no solicitados):** El estudiante añadió métodos como `agregarJugador`, `eliminarJugador`, `obtenerJugadores`, `cambiarEquipo` y `obtenerEstadisticas` que no estaban en la lista de atributos solicitados.\n5.  **Relación incorrecta en el enunciado:** La relación `Equipo "1" o-- "*" Jugador : tiene (agregación)` no está bien formada y genera un error de sintaxis en Mermaid.	2026-05-03 20:48:39.56776+00	2026-05-03 20:48:39.56776+00	f	\N	\N
67545f85-1815-4c18-9ff5-1b6e624a6332	c66cd9f5-10f6-4bd5-b323-1cd8465b45b2	24c04bb7-f2a4-443b-b33d-09bee49fbbdd	\N	\N	\N	classDiagram\n    class Empleado {\n        +int id\n        +String nombre\n        +String apellido\n        +String email\n        +Date fechaContratacion\n        +float salario\n        +String telefono\n        +trabajar()\n        +solicitarVacaciones(dias: int)\n        +obtenerInformacion() String\n    }\n    class Departamento {\n        +int id\n        +String nombre\n        +String descripcion\n        +String ubicacion\n        +Empleado jefeDepartamento\n        +List~Empleado~ empleados\n        +agregarEmpleado(empleado: Empleado)\n        +eliminarEmpleado(empleado: Empleado)\n        +obtenerEmpleados() List~Empleado~\n    }\n    class Puesto {\n        +int id\n        +String titulo\n        +String descripcion\n        +float salarioBase\n        +String nivel\n        +List~Empleado~ empleados\n        +asignarEmpleado(empleado: Empleado)\n        +eliminarEmpleado(empleado: Empleado)\n        +obtenerEmpleados() List~Empleado~\n    }\n    Empleado "*" --> "1" Departamento : trabaja en\n    Empleado "*" --> "1" Puesto : ocupa\n    Departamento "1" --> "*" Empleado : tiene\n    Puesto "1" --> "*" Empleado : pueden ocupar	0.8	El diagrama de clases es casi correcto, pero tiene un par de fallos importantes. \n\n1. En las relaciones, el diagrama indica que "Empleado" tiene relación de uno a muchos con "Departamento" (trabaja en) y con "Puesto" (ocupa). Esto es incorrecto, debería ser al revés, como bien especificas en las relaciones inversas: "Un departamento tiene varios empleados" y "Un puesto puede ser ocupado por varios empleados". La relación se dibuja desde el "uno" hacia el "muchos".\n2. Los atributos de las clases no coinciden exactamente con los solicitados en la rúbrica. Por ejemplo, en "Empleado" se añaden atributos como "email", "fechaContratacion", "telefono", y métodos como "trabajar()", "solicitarVacaciones()", "obtenerInformacion()". En "Departamento" se añaden "descripcion", "jefeDepartamento" y "empleados", además de métodos. En "Puesto" se añaden "descripcion", "salarioBase", "empleados" y métodos. Aunque estos son atributos y métodos lógicos para un sistema de gestión de empleados, la rúbrica especificaba unos atributos muy concretos y la presencia de estos extra, aunque no penaliza gravemente, no sigue la especificación al pie de la letra.	2026-05-03 20:48:42.845938+00	2026-05-03 20:48:42.845938+00	f	\N	\N
5b7f5db2-cb39-4bfe-91aa-c6369ae4a1bb	2a7005e8-9b0f-4182-aa10-679108e13c50	3dac62cb-7d00-43b9-9fae-acebc0d7b37c	\N	\N	\N	classDiagram\n    class Cliente {\n        -String nombre\n        -String correo\n        -String telefono\n        +realizarPedido()\n    }\n\n    class Pedido {\n        -int idPedido\n        -String fecha\n        -double total\n        +calcularTotal()\n    }\n\n    Cliente "1" --> "*" Pedido : realiza	0.4	La sintaxis de Mermaid es correcta. Sin embargo, no se incluyen los atributos solicitados en cada clase (`id_cliente`, `id_pedido`, `apellido`, `direccion` en Cliente; `id_cliente` (como clave foránea) en Pedido). La multiplicidad es correcta, pero la relación debería ser de asociación, no de herencia. Además, se incluyen métodos que no fueron solicitados.	2026-05-08 00:14:19.409167+00	2026-05-08 00:14:19.409167+00	f	\N	\N
4543b89e-52f7-4dac-8b67-9a473e399718	2a7005e8-9b0f-4182-aa10-679108e13c50	7b49e872-1d23-4a77-b9df-162f0beefd7f	\N	\N	\N	classDiagram\n    class Libro {\n        -String titulo\n        -String isbn\n        -int anioPublicacion\n        +mostrarInformacion()\n    }\n\n    class Autor {\n        -String nombre\n        -String nacionalidad\n        +escribirLibro()\n    }\n\n    class Editorial {\n        -String nombre\n        -String direccion\n        +publicarLibro()\n    }\n\n    %% Relaciones\n    Libro "*" -- "*" Autor : escrito por\n    Editorial "1" -- "*" Libro : publica	0.7	El diagrama es funcional y representa las relaciones correctamente. Sin embargo, faltan los atributos de clave primaria y algunos otros atributos especificados en la rúbrica para cada clase. También se omiten los tipos de datos exactos en la definición de atributos, lo cual es importante para la claridad del diagrama de clases.	2026-05-08 00:14:22.484887+00	2026-05-08 00:14:22.484887+00	f	\N	\N
092bc5d4-8df8-4f6c-a56b-70025fbe3d56	2a7005e8-9b0f-4182-aa10-679108e13c50	14d2915f-471d-4ed7-966b-6c7a564948e9	\N	\N	\N	classDiagram\n    class Vehiculo {\n        -String marca\n        -String modelo\n        -int velocidadMaxima\n        +encender()\n        +apagar()\n    }\n\n    class Coche {\n        -int numeroPuertas\n        +abrirMaletero()\n    }\n\n    class Moto {\n        -boolean tieneCasco\n        +hacerCaballito()\n    }\n\n    class Camion {\n        -double capacidadCarga\n        +cargarMercancia()\n    }\n\n    %% Herencia\n    Vehiculo <|-- Coche\n    Vehiculo <|-- Moto\n    Vehiculo <|-- Camion	0.7	El diagrama de clases es sintácticamente correcto y parseable por Mermaid. La representación de la herencia es correcta, con todas las clases derivadas heredando de la clase base `Vehiculo`. Sin embargo, la respuesta no sigue la rúbrica al pie de la letra en cuanto a los atributos solicitados. La clase `Vehiculo` no tiene un atributo `velocidad_maxima` o `matricula` tal como se solicitó, sino `marca`, `modelo` y `velocidadMaxima` (que es aceptable a medias). La `Moto` tiene `tieneCasco` en lugar de `cilindrada`. Las demás clases siguen los atributos específicos solicitados.	2026-05-08 00:14:26.102646+00	2026-05-08 00:14:26.102646+00	f	\N	\N
5e1a498a-b8ef-4fd7-850b-a765ddb00342	2a7005e8-9b0f-4182-aa10-679108e13c50	4c3e411f-4e15-4a56-bad6-50733ca519e2	\N	\N	\N	classDiagram\n    class Curso {\n        -String nombre\n        -String codigo\n        -int duracionHoras\n        +iniciarCurso()\n    }\n\n    class Profesor {\n        -String nombre\n        -String especialidad\n        -String correo\n        +impartirClase()\n    }\n\n    class Estudiante {\n        -String nombre\n        -String matricula\n        -String correo\n        +inscribirseCurso()\n    }\n\n    %% Relaciones\n    Profesor "1" -- "*" Curso : imparte\n    Curso "*" -- "*" Estudiante : tiene inscritos	0.4	La respuesta del estudiante presenta algunos errores en la especificación de atributos y no cumple completamente con las relaciones solicitadas en la rúbrica. Aunque la sintaxis de Mermaid es válida y las clases solicitadas están presentes, los nombres y tipos de atributos no se corresponden con lo indicado en el enunciado. En cuanto a las relaciones, la cardinalidad de la relación entre `Profesor` y `Curso` es correcta, pero la relación entre `Curso` y `Estudiante` no es una relación de muchos a muchos explícita según la rúbrica, y la cardinalidad no está debidamente especificada en ambos lados como se esperaría para una relación m-a-m.	2026-05-08 00:14:30.261751+00	2026-05-08 00:14:30.261751+00	f	\N	\N
c85f558b-c561-4dc7-b3b3-679db74e1966	2a7005e8-9b0f-4182-aa10-679108e13c50	d10e9727-1846-443e-a7f8-346487050b0f	\N	\N	\N	classDiagram\n    class Ordenador {\n        -String marca\n        -String modelo\n        -int memoriaRAM\n        +encender()\n        +apagar()\n    }\n\n    class CPU {\n        -String fabricante\n        -double frecuenciaGHz\n        -int nucleos\n        +procesarDatos()\n    }\n\n    %% Composición\n    Ordenador "1" *-- "1" CPU : contiene	0.3	La sintaxis de Mermaid es válida, pero el diagrama no cumple completamente con la rúbrica. Los atributos clave primarias (id_ordenador, id_cpu) no están definidos, la memoria RAM y los núcleos no se solicitaban en la rúbrica. La relación es de composición pero la multiplicidad es incorrecta en el lado de Ordenador. Debería ser un Ordenador, tiene una CPU y la CPU no puede existir sin el ordenador, por lo cual la composición debe ser del lado de Ordenador. Además, la cardinalidad de la composición es incorrecta, debería ser "1" en el lado de la CPU y en el lado de Ordenador también. El texto "contiene" en la relación es adecuado.	2026-05-08 00:14:34.140281+00	2026-05-08 00:14:34.140281+00	f	\N	\N
76d2cb4e-e12a-4848-8a83-50621f4a907d	2a7005e8-9b0f-4182-aa10-679108e13c50	5d6e60ce-8be0-4778-94a2-18b54fad7665	\N	\N	\N	classDiagram\n    class Equipo {\n        -String nombre\n        -String ciudad\n        -String entrenador\n        +agregarJugador()\n    }\n\n    class Jugador {\n        -String nombre\n        -int edad\n        -String posicion\n        +jugarPartido()\n    }\n\n    %% Agregación\n    Equipo "1" o-- "*" Jugador : tiene	0.6	El diagrama presenta una sintaxis Mermaid válida y la relación de agregación es correcta. Sin embargo, no incluye los atributos `id_equipo`, `id_jugador` y `deporte` en la clase `Equipo` como se especificó en la rúbrica. Además, la clase `Jugador` no tiene `id_jugador`.	2026-05-08 00:14:36.919922+00	2026-05-08 00:14:36.919922+00	f	\N	\N
3caaebc9-2372-4fa5-a4c7-5562f786fec3	2a7005e8-9b0f-4182-aa10-679108e13c50	24c04bb7-f2a4-443b-b33d-09bee49fbbdd	\N	\N	\N	classDiagram\n    class Empleado {\n        -String nombre\n        -int idEmpleado\n        -double salario\n        +trabajar()\n    }\n\n    class Departamento {\n        -String nombre\n        -String ubicacion\n        +agregarEmpleado()\n    }\n\n    class Puesto {\n        -String titulo\n        -String nivel\n        +asignarResponsabilidades()\n    }\n\n    %% Relaciones\n    Departamento "1" -- "*" Empleado : contiene\n    Puesto "1" -- "*" Empleado : asignado a	0.4	Tu diagrama contiene errores de sintaxis y no representa correctamente todas las relaciones y atributos esperados en la rúbrica.\n\n**Errores específicos:**\n\n1.  **Atributos de Empleado:** Faltan los atributos `apellido` y `id_empleado`. Además, has puesto `idEmpleado` pero se esperaba `id_empleado` como clave primaria.\n2.  **Atributos de Departamento:** Faltan los atributos `id_departamento`.\n3.  **Atributos de Puesto:** Faltan los atributos `id_puesto`.\n4.  **Relación de Departamento a Empleado:** Aunque la multiplicidad es generalmente correcta (1 departamento a muchos empleados), la etiqueta `contiene` no es tan descriptiva como `tiene` o `emplea` en este contexto.\n5.  **Relación de Puesto a Empleado:** La multiplicidad `Puesto "1" -- "*" Empleado` en Mermaid indica que un `Puesto` tiene muchos `Empleado`, `asignado a`. Sin embargo, la rúbrica especifica que un `Empleado` solo tiene un `Puesto` en un momento dado, lo que se expresaría mejor si `Empleado` tuviera una referencia a `Puesto` (o una relación con la flecha en la otra dirección o con la multiplicidad 1 en el lado del Puesto y 0..1 en el lado del empleado). La relación que has puesto es más vaga y no refleja la restricción de que un empleado solo tiene un puesto.\n6. Además, has incluido métodos (`trabajar()`, `agregarEmpleado()`, `asignarResponsabilidades()`) que no fueron solicitados en la rúbrica.\n\n**Sugerencias para mejorar:**\n\n*   Asegúrate de incluir todos los atributos solicitados, respetando los nombres exactos y marcando las claves primarias (por ejemplo, con `{PK}`).\n*   Revisa cuidadosamente las multiplicidades y la dirección de las relaciones para reflejar con precisión el enunciado. Para representar "un Empleado solo tiene un Puesto", la relación debe indicar que un Empleado está asociado con un único Puesto.\n*   Evita incluir elementos (como métodos) que no se soliciten explícitamente en la rúbrica.\n*   Considera agregar el tipo de atributo si es necesario según la sintaxis de Mermaid y la claridad de tu diagrama.	2026-05-08 00:14:42.807009+00	2026-05-08 00:14:42.807009+00	f	\N	\N
322b3afd-c886-4b10-b519-805784e6e859	280df4cc-0424-43c7-a5d2-a877bc2a8d68	3dac62cb-7d00-43b9-9fae-acebc0d7b37c	\N	\N	\N	classDiagram\n    class Cliente {\n        +String nombre\n        +String correo\n        +String telefono\n        +String direccion\n        +agregar pedido\n        +verPedidos\n    }\n    class Pedido {\n        +String estado\n        +int idPedido\n        +Date fecha\n        +double total\n        +calcularTotal\n        +cancelarPedido\n    }\n    \n    Cliente "1" --> "0..*" Pedido : realiza\n   	0.6	El diagrama presenta una sintaxis Mermaid válida y la relación de multiplicidad es correcta. Sin embargo, los atributos de las clases no coinciden con los solicitados en la rúbrica. Además, se han incluido métodos (funciones) en las clases, cuando solo se pedían atributos. Faltan los atributos de clave primaria y foránea.	2026-05-08 01:44:54.008351+00	2026-05-08 01:44:54.008351+00	f	\N	\N
8845861b-74fd-4a25-9d8b-558df13f15a3	280df4cc-0424-43c7-a5d2-a877bc2a8d68	7b49e872-1d23-4a77-b9df-162f0beefd7f	\N	\N	\N	classDiagram\n    class Libro {\n        +String titulo\n        +int idLibro\n        +int anoPublicacion\n        +int numPaginas\n        +getPrecio()\n        +getDisponibilidad()\n    }\n    class Autor {\n        +String nombre\n        +String nacionalidad\n        +int idAutor\n        +getLibros()\n        +getBiogrfia()    \n    }\n    class Editorial {\n        +int idEditorial\n        +String nombre\n        +String pais\n        +contactar()\n        +getLibrosPublicados()    \n    }\n      autor "1..*" --> "0..*" libro : escribe\n      editorial "1" --> "1..*" libro : pubica\n          	0.8	El diagrama de clases es funcional, pero no cumple exactamente con los atributos solicitados en la rúbrica para cada clase. Además, la cardinalidad de la relación Editorial-Libro en su conexión de publicación no coincide con el 'uno a muchos' de la rúbrica.	2026-05-08 01:44:56.982641+00	2026-05-08 01:44:56.982641+00	f	\N	\N
1fac2fa5-793c-4b3c-928e-810c0be4804f	280df4cc-0424-43c7-a5d2-a877bc2a8d68	14d2915f-471d-4ed7-966b-6c7a564948e9	\N	\N	\N	classDiagram\n    class Vehiculo {\n        +String marca\n        +int idVehiculo\n        +int ano\n   \n    }\n    	0.1	La respuesta del estudiante es un diagrama de clases de Mermaid válido, sin embargo, no cumple con la mayoría de los requisitos de la rúbrica. Solamente incluye la clase base `Vehiculo` de manera correcta con un atributo común. No incluye las clases derivadas `Coche`, `Moto` y `Camion` con sus atributos específicos, ni las relaciones de herencia.	2026-05-08 01:45:00.268075+00	2026-05-08 01:45:00.268075+00	f	\N	\N
399f1e41-1f4d-406a-9ca5-e6d2979176c9	280df4cc-0424-43c7-a5d2-a877bc2a8d68	4c3e411f-4e15-4a56-bad6-50733ca519e2	\N	\N	\N		0	Sin respuesta	2026-05-08 01:45:00.468632+00	2026-05-08 01:45:00.468632+00	f	\N	\N
3a4add57-b7a8-492a-9880-412facc351d0	280df4cc-0424-43c7-a5d2-a877bc2a8d68	d10e9727-1846-443e-a7f8-346487050b0f	\N	\N	\N		0	Sin respuesta	2026-05-08 01:45:00.698198+00	2026-05-08 01:45:00.698198+00	f	\N	\N
dfca2b5a-c51b-4d9f-a280-8d7bc9a7f62c	280df4cc-0424-43c7-a5d2-a877bc2a8d68	5d6e60ce-8be0-4778-94a2-18b54fad7665	\N	\N	\N		0	Sin respuesta	2026-05-08 01:45:00.928813+00	2026-05-08 01:45:00.928813+00	f	\N	\N
a9afe321-6d0a-49ad-94b3-ec92c0b5ffd9	280df4cc-0424-43c7-a5d2-a877bc2a8d68	24c04bb7-f2a4-443b-b33d-09bee49fbbdd	\N	\N	\N		0	Sin respuesta	2026-05-08 01:45:01.132781+00	2026-05-08 01:45:01.132781+00	f	\N	\N
23af38b9-b947-4862-9db1-838fec729cbb	e67f9733-0956-4895-82d1-f006595bc365	3dac62cb-7d00-43b9-9fae-acebc0d7b37c	\N	\N	\N	aa	0	La respuesta del estudiante es "aa", lo cual no es un diagrama de clases válido en sintaxis Mermaid ni representa el escenario solicitado. Es simplemente texto sin sentido en este contexto.	2026-05-08 01:59:52.096472+00	2026-05-08 01:59:52.096472+00	f	\N	\N
b101b273-5a35-4c77-933a-307700a6e4b7	e67f9733-0956-4895-82d1-f006595bc365	7b49e872-1d23-4a77-b9df-162f0beefd7f	\N	\N	\N	aa	0	La respuesta del estudiante es inválida. No es un diagrama de clases Mermaid parseable y la sintaxis es incorrecta.	2026-05-08 01:59:55.305489+00	2026-05-08 01:59:55.305489+00	f	\N	\N
b4d8e76f-b4cb-4a64-9841-7f2d7987f916	e67f9733-0956-4895-82d1-f006595bc365	14d2915f-471d-4ed7-966b-6c7a564948e9	\N	\N	\N	aa	0	La respuesta del estudiante está vacía o contiene contenido no relacionado con la pregunta. No es posible generar una calificación o una estimación de IA a partir de ella.	2026-05-08 01:59:57.401799+00	2026-05-08 01:59:57.401799+00	f	\N	\N
47bf2429-2170-4812-8ac8-113c8fd5c205	e67f9733-0956-4895-82d1-f006595bc365	4c3e411f-4e15-4a56-bad6-50733ca519e2	\N	\N	\N	aa	0	La respuesta del estudiante está vacía y no es un diagrama de clases válido en Mermaid. No cumple con ninguno de los requisitos de la rúbrica.	2026-05-08 02:00:01.271619+00	2026-05-08 02:00:01.271619+00	f	\N	\N
3e1da7fa-64c8-4028-8e54-fbe899601de6	e67f9733-0956-4895-82d1-f006595bc365	d10e9727-1846-443e-a7f8-346487050b0f	\N	\N	\N	aa	0	La respuesta del estudiante está vacía o es un texto sin sentido (solo "aa"). No se puede evaluar ningún diagrama de clases. Por favor, proporciona un diagrama de clases en sintaxis Mermaid para su evaluación.	2026-05-08 02:00:08.179603+00	2026-05-08 02:00:08.179603+00	f	\N	\N
11f987cf-ae67-439f-9c99-1b8a2172fa20	e67f9733-0956-4895-82d1-f006595bc365	5d6e60ce-8be0-4778-94a2-18b54fad7665	\N	\N	\N		0	Sin respuesta	2026-05-08 02:00:08.558589+00	2026-05-08 02:00:08.558589+00	f	\N	\N
b9320523-8cdf-49a4-ae9f-1f5f2e6cd7b0	e67f9733-0956-4895-82d1-f006595bc365	24c04bb7-f2a4-443b-b33d-09bee49fbbdd	\N	\N	\N		0	Sin respuesta	2026-05-08 02:00:08.920765+00	2026-05-08 02:00:08.920765+00	f	\N	\N
\.


--
-- Data for Name: workshop_submissions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."workshop_submissions" ("id", "workshop_id", "user_id", "content", "file_url", "external_link", "ai_grade", "ai_feedback", "final_grade", "teacher_feedback", "status", "submitted_at", "created_at", "updated_at", "ai_detected", "ai_detected_score", "ai_detected_reasons", "group_id") FROM stdin;
e67f9733-0956-4895-82d1-f006595bc365	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	e8b3c430-2162-413b-8560-9e3a43e3577e	\N	\N	\N	0	Calificación automática inmediata sobre 100 pts.	0	\N	calificado	2026-05-08 01:59:47.83+00	2026-05-08 01:59:49.197744+00	2026-05-08 02:00:09.278804+00	f	\N	\N	\N
65b10f06-84a6-4712-8222-2772bd74dc1c	57a96c1f-0340-4a0e-99b0-8da71d934669	dac41f00-64e7-40b8-a207-31f1ee2718c0	\N	\N	\N	93	Calificación automática inmediata sobre 100 pts.	93	\N	calificado	2026-04-26 18:45:49.524+00	2026-04-26 18:45:48.39047+00	2026-04-26 18:46:08.455079+00	f	\N	\N	\N
58faf5b2-4828-44ce-bb9b-6052c929bcb1	57a96c1f-0340-4a0e-99b0-8da71d934669	19e004a1-c1f2-4ca5-91d2-4c095058cb84	\N	\N	\N	99	Calificación automática inmediata sobre 100 pts.	99	\N	calificado	2026-04-27 07:12:05.587+00	2026-04-27 07:12:05.721002+00	2026-04-27 07:12:27.364512+00	f	\N	\N	\N
fcb93985-d50a-4b34-8372-8c5e3197de3e	57a96c1f-0340-4a0e-99b0-8da71d934669	d048a636-8a14-4fcd-aa3e-891cca899b32	\N	\N	\N	10	Calificación automática inmediata sobre 100 pts.	10	\N	calificado	2026-04-28 03:10:55.892+00	2026-04-28 03:10:55.975408+00	2026-04-28 03:11:00.540247+00	f	\N	\N	\N
e03bcd1f-b33b-4b47-a415-03c1a8228134	57a96c1f-0340-4a0e-99b0-8da71d934669	032a6335-5776-4677-8881-99db2cef9fe2	\N	\N	\N	97	Calificación automática inmediata sobre 100 pts.	97	\N	calificado	2026-04-29 03:24:22.042+00	2026-04-30 02:15:04.655079+00	2026-04-30 02:15:27.940306+00	f	\N	\N	\N
5727ca21-785d-46fd-9779-2950fbf251f9	57a96c1f-0340-4a0e-99b0-8da71d934669	2b2cb673-f574-4f99-b152-c4f9c438ab0c	\N	\N	\N	100	Calificación automática inmediata sobre 100 pts.	100	\N	calificado	2026-04-30 02:43:57.84+00	2026-04-30 02:43:58.618502+00	2026-04-30 02:44:19.62218+00	f	\N	\N	\N
7b14d839-a306-4f18-b894-3a2e8f40f4bb	57a96c1f-0340-4a0e-99b0-8da71d934669	2d709409-7b44-403d-a315-b8bb826aa8ca	\N	\N	\N	100	Calificación automática inmediata sobre 100 pts.	100	\N	calificado	2026-04-30 03:25:11.275+00	2026-04-30 03:25:11.897306+00	2026-04-30 03:25:34.532972+00	f	\N	\N	\N
e2edb38f-43fc-434d-b5cf-76a1e8a73880	57a96c1f-0340-4a0e-99b0-8da71d934669	531392ff-60c0-471d-af30-5e58bc80e860	\N	\N	\N	73	Calificación automática inmediata sobre 100 pts.	73	\N	calificado	2026-04-30 04:53:45.101+00	2026-04-30 04:53:45.026262+00	2026-04-30 04:54:08.345915+00	f	\N	\N	\N
08d1b215-abbb-49ec-96e8-3210cfb4826f	57a96c1f-0340-4a0e-99b0-8da71d934669	2c4cc34e-15b9-4120-b46d-f9db6b3d8a3c	\N	\N	\N	100	Calificación automática inmediata sobre 100 pts.	100	\N	calificado	2026-04-30 04:59:29.701+00	2026-04-30 04:59:29.863537+00	2026-04-30 04:59:52.163139+00	f	\N	\N	\N
2d20aa17-984c-4ffb-8622-66888f3a66b4	57a96c1f-0340-4a0e-99b0-8da71d934669	cf304ed6-fc61-4b24-a512-17ddc4e2a67c	\N	\N	\N	100	Calificación automática inmediata sobre 100 pts.	100	\N	calificado	2026-04-30 06:08:10.814+00	2026-04-30 06:08:11.100131+00	2026-04-30 06:08:45.064093+00	f	\N	\N	\N
df24dc30-acaa-4c36-8e1c-fd7af7c4426a	57a96c1f-0340-4a0e-99b0-8da71d934669	25c7499f-7944-40f8-9a72-c1ea5fda7b4f	\N	\N	\N	67	Calificación automática inmediata sobre 100 pts.	67	\N	calificado	2026-04-30 14:23:45.657+00	2026-04-30 14:23:55.228806+00	2026-04-30 14:25:43.774176+00	f	\N	\N	\N
75404f12-b06e-473d-b49f-0e2f57881775	57a96c1f-0340-4a0e-99b0-8da71d934669	bce0ddee-4001-45e9-b323-719f80dc4f6d	\N	\N	\N	100	Calificación automática inmediata sobre 100 pts.	100	\N	calificado	2026-04-30 22:26:37.445+00	2026-04-30 22:27:00.330264+00	2026-04-30 22:27:18.991646+00	f	\N	\N	\N
04e14093-1777-40ff-bee1-07c015be7fb8	57a96c1f-0340-4a0e-99b0-8da71d934669	ba4c4904-ee75-4e48-bbd1-bfb5792003d8	\N	\N	\N	88	Calificación automática inmediata sobre 100 pts.	88	\N	calificado	2026-04-30 22:34:21.991+00	2026-04-30 22:34:22.28689+00	2026-04-30 22:34:46.598098+00	f	\N	\N	\N
8a71b60a-27b2-4bb2-a38e-993726c89c0e	57a96c1f-0340-4a0e-99b0-8da71d934669	0a02892e-8476-44da-90e8-384c064e6040	\N	\N	\N	100	Calificación automática inmediata sobre 100 pts.	100	\N	calificado	2026-04-30 23:10:50.731+00	2026-04-30 23:10:51.014403+00	2026-04-30 23:11:10.633374+00	f	\N	\N	\N
56fdfe94-ff0b-4756-8ec6-1c5540d3b87d	57a96c1f-0340-4a0e-99b0-8da71d934669	4e923995-0e57-4430-a1d6-cca9b9261775	\N	\N	\N	100	Calificación automática inmediata sobre 100 pts.	100	\N	calificado	2026-05-01 00:56:07.308+00	2026-05-01 00:56:08.117883+00	2026-05-01 00:56:53.828617+00	f	\N	\N	\N
b7c820da-c5d2-430f-8fb0-c174ef3ad7c7	57a96c1f-0340-4a0e-99b0-8da71d934669	0cf09e84-be38-4adf-8e74-44937461fc46	\N	\N	\N	97	Calificación automática inmediata sobre 100 pts.	97	\N	calificado	2026-05-01 04:57:26.255+00	2026-05-01 04:57:26.139929+00	2026-05-01 04:57:49.929767+00	f	\N	\N	\N
c66cd9f5-10f6-4bd5-b323-1cd8465b45b2	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	dac41f00-64e7-40b8-a207-31f1ee2718c0	\N	\N	\N	61.43	Calificación automática inmediata sobre 100 pts.	61.43	\N	calificado	2026-05-03 20:48:19.644+00	2026-05-03 20:48:19.836625+00	2026-05-03 20:48:43.080623+00	f	\N	\N	\N
2a7005e8-9b0f-4182-aa10-679108e13c50	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	2b2cb673-f574-4f99-b152-c4f9c438ab0c	\N	\N	\N	50	Calificación automática inmediata sobre 100 pts.	50	\N	calificado	2026-05-08 00:14:15.455+00	2026-05-08 00:14:16.065917+00	2026-05-08 00:14:43.165829+00	f	\N	\N	\N
280df4cc-0424-43c7-a5d2-a877bc2a8d68	0cf9dca0-7c11-47ac-b6b4-2a744f033d39	0cf09e84-be38-4adf-8e74-44937461fc46	\N	\N	\N	21.43	Calificación automática inmediata sobre 100 pts.	21.43	\N	calificado	2026-05-08 01:44:51.015+00	2026-05-08 01:44:51.185517+00	2026-05-08 01:45:01.375688+00	f	\N	\N	\N
\.


--
-- Data for Name: workshops; Type: TABLE DATA; Schema: public; Owner: -
--

COPY "public"."workshops" ("id", "course_id", "created_by", "title", "description", "instructions", "external_link", "ai_generated", "due_date", "rubric", "max_score", "status", "created_at", "updated_at", "start_date", "cut_id", "is_external", "weight", "group_mode", "group_size_min", "group_size_max") FROM stdin;
0cf9dca0-7c11-47ac-b6b4-2a744f033d39	1eb0f987-8d79-4f84-bbc9-d5e1a8863d8e	e8b3c430-2162-413b-8560-9e3a43e3577e	Taller #1 - Diagrama de Clases con Mermaid			\N	f	2026-05-11 04:59:00+00	\N	100	published	2026-05-03 16:46:32.931889+00	2026-05-07 22:18:24.38523+00	2026-05-03 16:00:00+00	4f61f900-9fce-4480-8fa7-0637c5ad4011	f	10	teacher_assigned	2	5
57a96c1f-0340-4a0e-99b0-8da71d934669	0e375073-e9f2-4fda-a295-53407e3d5879	e8b3c430-2162-413b-8560-9e3a43e3577e	Taller #2  - HashSet & HashMap			\N	f	2026-05-15 04:59:00+00	\N	100	published	2026-04-26 16:01:13.823714+00	2026-05-08 01:52:40.127782+00	\N	0325ea4e-9c44-457b-b5e1-a675bf65c147	f	10	teacher_assigned	2	5
\.


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

\unrestrict fkk1HZhtZggq4GLnS4ffpH31mcZ8JH2OfMnAKKynGCgYXNKxdcSerUYUn8Ucl8o

