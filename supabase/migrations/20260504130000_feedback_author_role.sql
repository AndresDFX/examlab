-- Distingue si un comentario en un hilo de retroalimentación se escribió
-- desde la vista de estudiante o desde la de docente. Necesario porque
-- un mismo usuario puede tener ambos roles (p. ej. un docente que está
-- haciendo pruebas como estudiante, o un estudiante de posgrado que es
-- monitor): sin esta columna sus mensajes se ven idénticos en el hilo.
--
-- El frontend lo establece según el contexto de la pantalla desde la que
-- se escribe (FeedbackThread con prop isTeacher → 'teacher'; sin él →
-- 'student'). Default 'student' para no romper filas existentes (las
-- únicas son de pruebas tempranas, todas del estudiante).

alter table public.feedback_comments
  add column if not exists author_role text not null default 'student'
  check (author_role in ('student', 'teacher'));
