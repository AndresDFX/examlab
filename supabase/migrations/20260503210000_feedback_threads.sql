-- Conversaciones por (pregunta, entrega) para que estudiante y docente
-- intercambien comentarios sobre la retroalimentación. Polimórfica:
-- parent_kind ∈ {exam, workshop, project} y question_id apunta a la
-- tabla correspondiente (questions / workshop_questions / project_files).

create table if not exists public.feedback_threads (
  id uuid primary key default gen_random_uuid(),
  parent_kind text not null check (parent_kind in ('exam', 'workshop', 'project')),
  question_id uuid not null,
  submission_id uuid not null,
  closed boolean not null default false,
  closed_at timestamptz,
  closed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (parent_kind, question_id, submission_id)
);

create index if not exists feedback_threads_lookup
  on public.feedback_threads (parent_kind, submission_id);

create table if not exists public.feedback_comments (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.feedback_threads(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  body text not null check (length(body) > 0 and length(body) <= 4000),
  created_at timestamptz not null default now()
);

create index if not exists feedback_comments_thread
  on public.feedback_comments (thread_id, created_at);

-- ──────────────────────────────────────────────────────────────────────
-- Helpers de RLS. SECURITY DEFINER porque acceden a tablas padre que
-- el rol authenticated puede no tener permitido leer directamente.
-- ──────────────────────────────────────────────────────────────────────

create or replace function public.is_submission_owner(
  p_kind text, p_submission_id uuid, p_user_id uuid
) returns boolean
language sql security definer stable
set search_path = public
as $$
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

create or replace function public.is_question_course_teacher(
  p_kind text, p_question_id uuid, p_user_id uuid
) returns boolean
language sql security definer stable
set search_path = public
as $$
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

-- ──────────────────────────────────────────────────────────────────────
-- RLS
-- ──────────────────────────────────────────────────────────────────────

alter table public.feedback_threads enable row level security;
alter table public.feedback_comments enable row level security;

drop policy if exists "feedback_threads select" on public.feedback_threads;
create policy "feedback_threads select"
on public.feedback_threads for select to authenticated
using (
  public.is_submission_owner(parent_kind, submission_id, auth.uid())
  or public.is_question_course_teacher(parent_kind, question_id, auth.uid())
);

drop policy if exists "feedback_threads insert" on public.feedback_threads;
create policy "feedback_threads insert"
on public.feedback_threads for insert to authenticated
with check (
  public.is_submission_owner(parent_kind, submission_id, auth.uid())
  or public.is_question_course_teacher(parent_kind, question_id, auth.uid())
);

-- Solo docentes pueden cerrar/reabrir
drop policy if exists "feedback_threads update teacher" on public.feedback_threads;
create policy "feedback_threads update teacher"
on public.feedback_threads for update to authenticated
using (public.is_question_course_teacher(parent_kind, question_id, auth.uid()))
with check (public.is_question_course_teacher(parent_kind, question_id, auth.uid()));

drop policy if exists "feedback_comments select" on public.feedback_comments;
create policy "feedback_comments select"
on public.feedback_comments for select to authenticated
using (
  exists (
    select 1 from public.feedback_threads t
    where t.id = thread_id
      and (
        public.is_submission_owner(t.parent_kind, t.submission_id, auth.uid())
        or public.is_question_course_teacher(t.parent_kind, t.question_id, auth.uid())
      )
  )
);

-- Insertar requiere que el hilo NO esté cerrado y que el usuario sea el
-- dueño de la entrega o un docente del curso.
drop policy if exists "feedback_comments insert" on public.feedback_comments;
create policy "feedback_comments insert"
on public.feedback_comments for insert to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.feedback_threads t
    where t.id = thread_id
      and t.closed = false
      and (
        public.is_submission_owner(t.parent_kind, t.submission_id, auth.uid())
        or public.is_question_course_teacher(t.parent_kind, t.question_id, auth.uid())
      )
  )
);

-- Solo el autor puede borrar su propio comentario (audit-friendly).
drop policy if exists "feedback_comments delete own" on public.feedback_comments;
create policy "feedback_comments delete own"
on public.feedback_comments for delete to authenticated
using (user_id = auth.uid());
