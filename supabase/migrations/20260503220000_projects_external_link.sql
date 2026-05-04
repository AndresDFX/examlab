-- Mismo patrón opcional que tienen los talleres: un URL externo donde el
-- docente expone el enunciado/recurso del proyecto. Se muestra como link
-- en la vista del estudiante; se llena desde el form de crear/editar
-- proyecto. Es opcional (NULL permitido).

alter table public.projects
  add column if not exists external_link text;
