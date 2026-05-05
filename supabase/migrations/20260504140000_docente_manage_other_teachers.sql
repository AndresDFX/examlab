-- Antes: un Docente solo podía manipular SU PROPIA fila en
-- course_teachers ("auto-asignarse" o auto-removerse). Eso es lo
-- contrario de lo que necesitamos: queremos que un Docente pueda
-- gestionar a OTROS docentes en los cursos (igual que un Admin),
-- pero NO pueda asignarse a sí mismo a un curso para evitar que
-- un Docente se metiera en cursos que no le corresponden.
--
-- La nueva regla: Docente puede ALL en course_teachers donde
-- user_id != auth.uid(). Su propia fila es intocable para ellos —
-- solo un Admin puede agregarlos o sacarlos. Admin sigue con
-- acceso total.

drop policy if exists "Docentes manage own course_teachers" on public.course_teachers;

create policy "Docentes manage other course_teachers"
  on public.course_teachers for all to authenticated
  using (public.has_role(auth.uid(), 'Docente') and user_id <> auth.uid())
  with check (public.has_role(auth.uid(), 'Docente') and user_id <> auth.uid());
