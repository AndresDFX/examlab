-- RPC para enviar notificaciones por eventos de feedback_threads.
--
-- Necesita SECURITY DEFINER porque el flujo cruza roles:
--  - Cuando el estudiante comenta, hay que insertar una fila en
--    `notifications` para cada docente del curso. El estudiante
--    no tiene insert directo a notifications de otros user_id.
--  - Cuando el docente comenta o cierra/reabre, se notifica al
--    estudiante. El docente sí podría hacerlo directamente (su
--    policy lo permite) pero centralizamos la lógica de routing
--    aquí para que el front no tenga que conocer el schema.
--
-- Eventos soportados: 'comment' | 'closed' | 'reopened'.
-- actor_role: 'student' | 'teacher' (lo que hay en feedback_comments
-- después de la migración 20260504130000).
--
-- Filtra al actor mismo (auth.uid() <> destinatario) para no
-- mandarse notificaciones a uno mismo cuando el usuario tiene
-- ambos roles.

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
  _title text;
  _body text;
  _count integer := 0;
begin
  select * into t from public.feedback_threads where id = _thread_id;
  if not found then
    return 0;
  end if;

  if t.parent_kind = 'exam' then
    select user_id into _student_id from public.submissions where id = t.submission_id;
    select exam_id into _ref_id from public.questions where id = t.question_id;
    select course_id into _course_id from public.exams where id = _ref_id;
    _student_link := '/app/student/review/' || _ref_id::text;
    _teacher_link := '/app/teacher/monitor/' || _ref_id::text;
  elsif t.parent_kind = 'workshop' then
    select user_id into _student_id from public.workshop_submissions where id = t.submission_id;
    select workshop_id into _ref_id from public.workshop_questions where id = t.question_id;
    select course_id into _course_id from public.workshops where id = _ref_id;
    _student_link := '/app/student/workshop/' || _ref_id::text;
    _teacher_link := '/app/teacher/workshops';
  elsif t.parent_kind = 'project' then
    select user_id into _student_id from public.project_submissions where id = t.submission_id;
    select project_id into _ref_id from public.project_files where id = t.question_id;
    select coalesce(
      p.course_id,
      (select pc.course_id from public.project_courses pc where pc.project_id = _ref_id limit 1)
    )
    into _course_id
    from public.projects p where p.id = _ref_id;
    _student_link := '/app/student/project/' || _ref_id::text;
    _teacher_link := '/app/teacher/projects';
  else
    return 0;
  end if;

  if _event = 'comment' then
    if _actor_role = 'student' then
      -- Estudiante comentó → notificar a los docentes del curso.
      _title := 'Nuevo comentario del estudiante';
      _body := 'Un estudiante respondió a la retroalimentación de una pregunta.';
      insert into public.notifications (user_id, title, body, kind, link)
      select ct.user_id, _title, _body, 'feedback', _teacher_link
      from public.course_teachers ct
      where ct.course_id = _course_id
        and ct.user_id <> auth.uid();
      get diagnostics _count = row_count;
    else
      -- Docente comentó → notificar al estudiante (dueño del submission).
      _title := 'Nuevo comentario del docente';
      _body := 'El docente respondió a tu retroalimentación.';
      if _student_id is not null and _student_id <> auth.uid() then
        insert into public.notifications (user_id, title, body, kind, link)
        values (_student_id, _title, _body, 'feedback', _student_link);
        _count := 1;
      end if;
    end if;
  elsif _event = 'closed' then
    _title := 'Conversación cerrada';
    _body := 'El docente cerró la conversación de retroalimentación.';
    if _student_id is not null and _student_id <> auth.uid() then
      insert into public.notifications (user_id, title, body, kind, link)
      values (_student_id, _title, _body, 'feedback', _student_link);
      _count := 1;
    end if;
  elsif _event = 'reopened' then
    _title := 'Conversación reabierta';
    _body := 'El docente reabrió la conversación de retroalimentación.';
    if _student_id is not null and _student_id <> auth.uid() then
      insert into public.notifications (user_id, title, body, kind, link)
      values (_student_id, _title, _body, 'feedback', _student_link);
      _count := 1;
    end if;
  end if;

  return _count;
end;
$$;

grant execute on function public.notify_feedback_event(uuid, text, text) to authenticated;
