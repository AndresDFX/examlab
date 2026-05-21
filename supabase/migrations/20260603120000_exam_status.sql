-- Agregar columna `status` a la tabla `exams` para que el docente pueda
-- controlar manualmente el ciclo de vida del examen (borrador → publicado
-- → cerrado), independiente de la ventana start_time/end_time. Espejo
-- del patrón ya usado en workshops y projects.
--
-- Valores:
--   draft     → solo visible para docente/admin; no aparece en la lista
--               del estudiante ni el calendario.
--   published → visible para los estudiantes asignados. La ventana de
--               toma sigue gobernada por start_time/end_time.
--   closed    → cerrado manualmente; ya no admite intentos nuevos
--               aunque la ventana todavía estuviera abierta.
--
-- Default = 'published' para preservar el comportamiento previo: todos
-- los exámenes ya existentes en la plataforma eran "publicados" de
-- facto (no había noción de borrador), así que el backfill DEFAULT
-- garantiza que los estudiantes los siguen viendo igual.

ALTER TABLE public.exams
  ADD COLUMN status TEXT NOT NULL DEFAULT 'published'
  CHECK (status IN ('draft', 'published', 'closed'));

COMMENT ON COLUMN public.exams.status IS
  'Estado manual del examen. draft=solo docente; published=visible para estudiantes (si esta dentro de la ventana); closed=cerrado, no admite intentos. Independiente de start_time/end_time.';

-- Índice parcial para listas de docente filtradas por estado (la mayoría
-- de las queries de docente listan published; draft y closed son lookups
-- ocasionales).
CREATE INDEX IF NOT EXISTS exams_status_idx ON public.exams(status);
