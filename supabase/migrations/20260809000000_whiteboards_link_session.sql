-- ──────────────────────────────────────────────────────────────────────
-- Whiteboards: permitir asociar a una sesión específica de un curso.
--
-- Hasta acá una whiteboard standalone podía atarse a un `course_id`
-- (mig 20260603060000). Pero los docentes pedían poder asociarla
-- directamente a UNA SESIÓN del curso (la pizarra "de la clase del
-- viernes"), no solo al curso entero. Esta migración:
--
--   1. Agrega `attendance_session_id` nullable, con CASCADE al borrar
--      la sesión (la pizarra queda huérfana del session pero
--      conserva el course_id).
--   2. CHECK: si `attendance_session_id IS NOT NULL`, `course_id`
--      también debe estarlo. Aplicamos como trigger BEFORE INSERT/UPDATE
--      para poder validar que el session pertenece a ese course
--      (la integridad sintáctica solamente NO alcanza — sin chequear
--      contra la tabla podría haber inconsistencia entre course_id
--      y la session's course_id).
--   3. Index por session_id para queries "dame la pizarra de esta
--      sesión" desde el editor de attendance.
--
-- NOTA: NO reemplaza la columna `attendance_sessions.whiteboard_scene`
-- (mig 20260603060000) — esa es la pizarra "del momento" embebida 1:1
-- en la sesión, usada por el dialog SessionWhiteboardDialog cuando el
-- docente la abre desde el dropdown de la sesión. La nueva asociación
-- es para STANDALONE whiteboards que opcionalmente apuntan a una
-- sesión específica (un docente puede tener varias whiteboards
-- standalone asociadas a la misma sesión).
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.whiteboards
  ADD COLUMN IF NOT EXISTS attendance_session_id UUID NULL
  REFERENCES public.attendance_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_whiteboards_session
  ON public.whiteboards(attendance_session_id)
  WHERE attendance_session_id IS NOT NULL;

-- Trigger para validar coherencia session ↔ course al INSERT/UPDATE.
-- Si attendance_session_id está set:
--   - course_id debe estar set
--   - course_id debe coincidir con el course_id de la session referenciada
-- Mensaje en español (P0001 burbujea el RAISE original al cliente).
CREATE OR REPLACE FUNCTION public._tg_whiteboard_validate_session_course()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_session_course UUID;
BEGIN
  IF NEW.attendance_session_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.course_id IS NULL THEN
    RAISE EXCEPTION 'Para asociar una pizarra a una sesión, primero hay que asociarla a un curso.';
  END IF;
  SELECT course_id INTO v_session_course
  FROM public.attendance_sessions
  WHERE id = NEW.attendance_session_id;
  IF v_session_course IS NULL THEN
    RAISE EXCEPTION 'La sesión asociada no existe o fue eliminada.';
  END IF;
  IF v_session_course <> NEW.course_id THEN
    RAISE EXCEPTION 'La sesión seleccionada pertenece a otro curso. Elegí una sesión del curso indicado.';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_whiteboard_validate_session_course ON public.whiteboards;
CREATE TRIGGER trg_whiteboard_validate_session_course
  BEFORE INSERT OR UPDATE ON public.whiteboards
  FOR EACH ROW EXECUTE FUNCTION public._tg_whiteboard_validate_session_course();

NOTIFY pgrst, 'reload schema';
