-- Title/body más específico en las notificaciones de feedback:
-- ahora incluyen tipo (Examen / Taller / Proyecto), nombre del padre,
-- número de pregunta y, para exámenes, número de intento.
--
-- Antes:
--   Title: "Nuevo comentario en Parcial 1"
--   Body:  "Andrés respondió a la retroalimentación."
--
-- Ahora:
--   Title: "Examen: Parcial 1"
--   Body:  "Andrés hizo un comentario en la pregunta 3 (intento 2)."
--
-- Para taller y proyecto el body no incluye intento porque hay una
-- sola entrega por estudiante.

create or replace function public.notify_feedback_event(
  _thread_id uuid,
  _event text,
  _actor_role text
) returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  t public.feedback_threads;
  _student_id uuid;
  _course_id uuid;
  _ref_id uuid;
  _student_link text;
  _teacher_link text;
  _parent_title text;
  _kind_label text;
  _actor_name text;
  _question_pos integer;
  _attempt_number integer;
  _question_label text;  -- "pregunta 3" o "pregunta 3 (intento 2)"
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
    -- Número de intento del estudiante en este examen al que
    -- corresponde la submission del hilo. Las submissions están
    -- ordenadas cronológicamente.
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

  -- position viene 0-indexed en algunos imports y 1-indexed en otros;
  -- normalizamos a 1-indexed para mostrar al humano.
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

  _title := _kind_label || ': ' || coalesce(_parent_title, 'sin título');

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

grant execute on function public.notify_feedback_event(uuid, text, text) to authenticated;
