-- Mejora notify_feedback_event para que las notificaciones lleven:
--  - Nombre del estudiante actor en el body (cuando comenta el alumno).
--  - Título del examen / taller / proyecto.
--  - Deep-link al modal del estudiante específico (?student=USER_ID)
--    para que el docente caiga directo en los intentos / entregas
--    del alumno que respondió, no en el grid genérico.

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
  _actor_name text;
  _student_name text;
  _title text;
  _body text;
  _count integer := 0;
begin
  select * into t from public.feedback_threads where id = _thread_id;
  if not found then
    return 0;
  end if;

  -- Resolver nombre del actor (el que comenta) — puede ser null si
  -- el perfil no existe; lo manejamos con coalesce más abajo.
  select full_name into _actor_name
  from public.profiles where id = auth.uid();

  if t.parent_kind = 'exam' then
    select user_id into _student_id from public.submissions where id = t.submission_id;
    select exam_id into _ref_id from public.questions where id = t.question_id;
    select course_id, e.title into _course_id, _parent_title
    from public.exams e where e.id = _ref_id;
    _student_link := '/app/student/review/' || _ref_id::text;
    _teacher_link := '/app/teacher/monitor/' || _ref_id::text
      || '?student=' || _student_id::text;
  elsif t.parent_kind = 'workshop' then
    select user_id into _student_id from public.workshop_submissions where id = t.submission_id;
    select workshop_id into _ref_id from public.workshop_questions where id = t.question_id;
    select course_id, w.title into _course_id, _parent_title
    from public.workshops w where w.id = _ref_id;
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
    _student_link := '/app/student/project/' || _ref_id::text;
    _teacher_link := '/app/teacher/projects?id=' || _ref_id::text
      || '&student=' || _student_id::text;
  else
    return 0;
  end if;

  select full_name into _student_name
  from public.profiles where id = _student_id;

  if _event = 'comment' then
    if _actor_role = 'student' then
      _title := 'Nuevo comentario en ' || coalesce(_parent_title, 'una entrega');
      _body := coalesce(_actor_name, 'Un estudiante')
        || ' respondió a la retroalimentación.';
      insert into public.notifications (user_id, title, body, kind, link)
      select ct.user_id, _title, _body, 'feedback', _teacher_link
      from public.course_teachers ct
      where ct.course_id = _course_id;
      get diagnostics _count = row_count;
    else
      _title := 'Nuevo comentario del docente';
      _body := coalesce(_actor_name, 'El docente')
        || ' respondió a tu retroalimentación en '
        || coalesce(_parent_title, 'una entrega') || '.';
      if _student_id is not null then
        insert into public.notifications (user_id, title, body, kind, link)
        values (_student_id, _title, _body, 'feedback', _student_link);
        _count := 1;
      end if;
    end if;
  elsif _event = 'closed' then
    _title := 'Conversación cerrada';
    _body := 'El docente cerró la conversación de retroalimentación en '
      || coalesce(_parent_title, 'una entrega') || '.';
    if _student_id is not null then
      insert into public.notifications (user_id, title, body, kind, link)
      values (_student_id, _title, _body, 'feedback', _student_link);
      _count := 1;
    end if;
  elsif _event = 'reopened' then
    _title := 'Conversación reabierta';
    _body := 'El docente reabrió la conversación de retroalimentación en '
      || coalesce(_parent_title, 'una entrega') || '.';
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
