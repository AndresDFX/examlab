-- ──────────────────────────────────────────────────────────────────────
-- Encuestas: dos parámetros nuevos del docente
--
--  1) `allow_change_response` (default TRUE — comportamiento legacy)
--     Cuando es FALSE, el alumno NO puede modificar su voto una vez
--     emitido. Aplica a los tres tipos:
--       - single/slot: ya no puede borrar para revotar.
--       - multiple:    ya no puede borrar opciones marcadas. Sí puede
--                      seguir agregando más opciones porque "agregar"
--                      no es "cambiar"; si quisieras "bloquear todo
--                      después del primer voto", combina este flag con
--                      auto_close_when_all_responded o explicale al
--                      alumno que confirme antes (UX del cliente).
--     Enforcement: la RPC `clear_poll_response` rechaza el DELETE.
--
--  2) `auto_close_when_all_responded` (default FALSE)
--     Cuando es TRUE, después de cada INSERT en poll_responses el
--     trigger cuenta cuántos alumnos distintos del curso ya votaron;
--     si llega al número de matriculados, marca la encuesta como
--     `closed_manually = TRUE`. Útil para encuestas tipo Doodle: una
--     vez que TODOS eligieron fecha, la encuesta cierra sola sin
--     dejarla "abierta para siempre" porque al docente se le olvida.
--     Riesgo conocido: si un matriculado nunca responde, la encuesta
--     no cierra sola — el docente sigue teniendo el cierre manual.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) Columnas nuevas ─────────────────────────────────────────────
ALTER TABLE public.polls
  ADD COLUMN IF NOT EXISTS allow_change_response BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS auto_close_when_all_responded BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.polls.allow_change_response IS
  'Si FALSE, el alumno no puede modificar su voto una vez emitido. Enforcement vía clear_poll_response RPC + UI del cliente que oculta el affordance de "cambiar voto".';

COMMENT ON COLUMN public.polls.auto_close_when_all_responded IS
  'Si TRUE, un trigger AFTER INSERT en poll_responses cierra la encuesta automáticamente cuando todos los alumnos matriculados en el curso han respondido al menos una vez.';

-- ── 2) clear_poll_response: respetar allow_change_response ─────────
-- Reemplazamos la RPC para añadir el guard. Conserva el resto del
-- comportamiento (auth, poll abierta, DELETE de las filas del user).
CREATE OR REPLACE FUNCTION public.clear_poll_response(_poll_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_poll public.polls;
  v_uid UUID := auth.uid();
  v_had_vote BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_poll FROM public.polls WHERE id = _poll_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Encuesta inexistente' USING ERRCODE = '22023';
  END IF;
  IF NOT public.poll_is_open(v_poll) THEN
    RAISE EXCEPTION 'La encuesta está cerrada' USING ERRCODE = 'P0001';
  END IF;

  -- Guard nuevo: si el docente bloqueó cambios y el alumno ya tenía
  -- voto, rechazamos. Si todavía NO tenía voto, dejamos pasar (no es
  -- "cambiar", es "votar la primera vez" — el DELETE no afecta a
  -- nadie, pero esta función NO inserta, así que en la práctica esto
  -- solo importa cuando ya hay respuestas previas).
  IF NOT v_poll.allow_change_response THEN
    SELECT EXISTS (
      SELECT 1 FROM public.poll_responses
       WHERE poll_id = _poll_id AND user_id = v_uid
    ) INTO v_had_vote;
    IF v_had_vote THEN
      RAISE EXCEPTION 'Esta encuesta no permite cambiar el voto una vez emitido'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  DELETE FROM public.poll_responses WHERE poll_id = _poll_id AND user_id = v_uid;
END;
$$;
GRANT EXECUTE ON FUNCTION public.clear_poll_response(UUID) TO authenticated;

-- ── 3) Trigger: auto-cerrar cuando todos hayan respondido ──────────
-- Corre AFTER INSERT en poll_responses. Si el poll padre tiene
-- auto_close_when_all_responded=TRUE y el conteo de votantes distintos
-- alcanza el total de matriculados del curso, marca el poll como
-- cerrado manualmente. Idempotente: si ya estaba cerrado, no hace
-- nada (el UPDATE filtra por NOT closed_manually).
CREATE OR REPLACE FUNCTION public._tg_poll_autoclose_when_all_responded()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_poll public.polls;
  v_voters INT;
  v_enrolled INT;
BEGIN
  SELECT * INTO v_poll FROM public.polls WHERE id = NEW.poll_id;
  IF NOT FOUND OR NOT v_poll.auto_close_when_all_responded OR v_poll.closed_manually THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(DISTINCT user_id) INTO v_voters
    FROM public.poll_responses
   WHERE poll_id = NEW.poll_id;

  SELECT COUNT(*) INTO v_enrolled
    FROM public.course_enrollments
   WHERE course_id = v_poll.course_id;

  -- Guard contra cursos vacíos: si no hay matriculados, no auto-cerramos
  -- (sería cerrar al primer voto del docente o del primer alumno fantasma).
  IF v_enrolled > 0 AND v_voters >= v_enrolled THEN
    UPDATE public.polls
       SET closed_manually = TRUE,
           updated_at = now()
     WHERE id = NEW.poll_id
       AND NOT closed_manually;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_poll_autoclose_when_all_responded ON public.poll_responses;
CREATE TRIGGER trg_poll_autoclose_when_all_responded
  AFTER INSERT ON public.poll_responses
  FOR EACH ROW EXECUTE FUNCTION public._tg_poll_autoclose_when_all_responded();

NOTIFY pgrst, 'reload schema';
