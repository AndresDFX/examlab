-- En migraciones intermedias se eliminó la FK projects.course_id →
-- courses.id (cuando los proyectos pasaron a many-to-many vía
-- project_courses). El frontend sigue usando el embed PostgREST
-- `course:courses(...)` para mostrar el nombre del curso primario en
-- listas y dashboards — sin la FK, PostgREST devuelve PGRST200
-- "Could not find a relationship between projects and courses" y
-- las pantallas se rompen.
--
-- La columna projects.course_id sigue existiendo y se sigue
-- poblando en el form de crear/editar proyecto (con el primer
-- curso vinculado). Restaurar la FK no afecta project_courses
-- (que sigue siendo la fuente para acceso many-to-many) y des-
-- trabra todos los embeds existentes en una sola pasada.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_course_id_fkey'
      and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_course_id_fkey
      foreign key (course_id) references public.courses(id)
      on delete set null;
  end if;
end $$;
