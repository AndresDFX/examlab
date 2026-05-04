-- Cantidad de advertencias permitidas por examen antes de marcar el
-- intento como sospechoso. Antes era constante hardcoded a 3 en el
-- frontend (utils/proctoring MAX_WARNINGS). Ahora cada docente puede
-- ajustarlo al crear/editar el examen; default 3 mantiene el
-- comportamiento histórico para los exámenes existentes.

alter table public.exams
  add column if not exists max_warnings integer not null default 3
  check (max_warnings between 1 and 50);
