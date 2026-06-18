-- ════════════════════════════════════════════════════════════════════
-- RPCs + triggers para encuestas MIXTAS (poll_questions / poll_question_responses).
--
-- El write directo a poll_question_responses está denegado por RLS — toda
-- respuesta entra por estas RPCs SECURITY DEFINER, que enforzan: papelera,
-- abierta, matrícula (multi-curso vía _poll_has_member), allow_change_response
-- (solo cerradas) y rango de selected_index. Espejo de vote_poll_option /
-- clear_poll_response / teacher_clear_poll_response_for_user (mig 20260720000000
-- y 20260603030000), adaptado al modelo de preguntas.
-- ════════════════════════════════════════════════════════════════════

-- ── RPC: submit_poll_question_response ──────────────────────────────
-- Único path por el que un alumno responde una pregunta de encuesta mixta.
-- abierta → _answer_text; cerrada → _selected_index. Upsert por (pregunta, user).
CREATE OR REPLACE FUNCTION public.submit_poll_question_response(
  _question_id UUID,
  _answer_text TEXT DEFAULT NULL,
  _selected_index INT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_q        public.poll_questions;
  v_poll     public.polls;
  v_choices  INT;
  v_existing BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_q FROM public.poll_questions WHERE id = _question_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pregunta inexistente' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_poll FROM public.polls WHERE id = v_q.poll_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Encuesta inexistente' USING ERRCODE = '22023';
  END IF;

  -- Papelera: una encuesta en la papelera NO acepta respuestas.
  IF v_poll.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'La encuesta no está disponible' USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_poll.is_published THEN
    RAISE EXCEPTION 'La encuesta no está publicada' USING ERRCODE = 'P0001';
  END IF;

  IF NOT public.poll_is_open(v_poll) THEN
    RAISE EXCEPTION 'La encuesta está cerrada' USING ERRCODE = 'P0001';
  END IF;

  -- Autorización multi-curso: matriculado en CUALQUIER curso linkeado a la
  -- encuesta (a diferencia de vote_poll_option que usa solo el curso ancla).
  IF NOT public._poll_has_member(v_q.poll_id, v_uid) THEN
    RAISE EXCEPTION 'No estás matriculado en este curso' USING ERRCODE = '42501';
  END IF;

  IF v_q.type = 'cerrada' THEN
    -- allow_change_response: si está en false y ya respondió, no puede
    -- cambiar. Se valida ANTES del upsert (solo para cerradas — en abiertas
    -- typear + blur no debe auto-bloquear el primer guardado).
    IF NOT v_poll.allow_change_response THEN
      SELECT EXISTS (
        SELECT 1 FROM public.poll_question_responses
         WHERE question_id = _question_id AND user_id = v_uid
      ) INTO v_existing;
      IF v_existing THEN
        RAISE EXCEPTION 'No se permite cambiar la respuesta' USING ERRCODE = 'P0001';
      END IF;
    END IF;

    IF _selected_index IS NULL THEN
      RAISE EXCEPTION 'Debes seleccionar una opción' USING ERRCODE = '22023';
    END IF;
    v_choices := COALESCE(jsonb_array_length(v_q.options -> 'choices'), 0);
    IF _selected_index < 0 OR _selected_index >= v_choices THEN
      RAISE EXCEPTION 'Opción fuera de rango' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.poll_question_responses
      (poll_id, question_id, user_id, selected_index, answer_text, updated_at)
    VALUES
      (v_q.poll_id, _question_id, v_uid, _selected_index, NULL, now())
    ON CONFLICT (question_id, user_id) DO UPDATE
      SET selected_index = EXCLUDED.selected_index,
          answer_text    = NULL,
          updated_at     = now();

  ELSIF v_q.type = 'abierta' THEN
    IF _answer_text IS NULL OR length(btrim(_answer_text)) = 0 THEN
      -- Texto vacío en abierta = limpiar la respuesta (idempotente). El
      -- front igual confirma "entregar en blanco" para required.
      DELETE FROM public.poll_question_responses
       WHERE question_id = _question_id AND user_id = v_uid;
      RETURN;
    END IF;
    IF v_q.max_chars IS NOT NULL AND length(_answer_text) > v_q.max_chars THEN
      RAISE EXCEPTION 'La respuesta excede el máximo de % caracteres', v_q.max_chars
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.poll_question_responses
      (poll_id, question_id, user_id, answer_text, selected_index, updated_at)
    VALUES
      (v_q.poll_id, _question_id, v_uid, _answer_text, NULL, now())
    ON CONFLICT (question_id, user_id) DO UPDATE
      SET answer_text    = EXCLUDED.answer_text,
          selected_index = NULL,
          updated_at     = now();
  ELSE
    RAISE EXCEPTION 'Tipo de pregunta no soportado: %', v_q.type USING ERRCODE = '22023';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.submit_poll_question_response(UUID, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_poll_question_response(UUID, TEXT, INT) TO authenticated;

-- ── RPC: clear_poll_question_responses ──────────────────────────────
-- El alumno quita TODAS sus respuestas de una encuesta mixta (si abierta).
CREATE OR REPLACE FUNCTION public.clear_poll_question_responses(_poll_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_poll public.polls;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_poll FROM public.polls WHERE id = _poll_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Encuesta inexistente' USING ERRCODE = '22023';
  END IF;
  IF v_poll.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'La encuesta no está disponible' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.poll_is_open(v_poll) THEN
    RAISE EXCEPTION 'La encuesta está cerrada' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM public.poll_question_responses
   WHERE poll_id = _poll_id AND user_id = v_uid;
END;
$$;
REVOKE ALL ON FUNCTION public.clear_poll_question_responses(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_poll_question_responses(UUID) TO authenticated;

-- ── RPC: teacher_clear_poll_question_response_for_user ──────────────
-- El docente linkeado (o Admin/SuperAdmin) borra la respuesta de UN alumno
-- a UNA pregunta. Paralelo a teacher_clear_poll_response_for_user.
CREATE OR REPLACE FUNCTION public.teacher_clear_poll_question_response_for_user(
  _question_id UUID,
  _user_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_q      public.poll_questions;
  v_deleted INT := 0;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_q FROM public.poll_questions WHERE id = _question_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pregunta inexistente' USING ERRCODE = '22023';
  END IF;

  IF NOT (
    public._poll_linked_teacher(v_q.poll_id, v_caller)
    OR public._poll_admin_in_tenant(v_q.poll_id, v_caller)
  ) THEN
    RAISE EXCEPTION 'No tienes permiso para borrar respuestas en esta encuesta'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.poll_question_responses
   WHERE question_id = _question_id AND user_id = _user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;
REVOKE ALL ON FUNCTION public.teacher_clear_poll_question_response_for_user(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.teacher_clear_poll_question_response_for_user(UUID, UUID) TO authenticated;

-- ── Trigger: una encuesta mixta NO se publica con 0 preguntas ───────
-- Server-side (no solo warning UI). Fire solo cuando se toca is_published.
CREATE OR REPLACE FUNCTION public._tg_poll_mixed_requires_questions()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_published AND NEW.poll_type = 'mixed' THEN
    IF NOT EXISTS (SELECT 1 FROM public.poll_questions WHERE poll_id = NEW.id) THEN
      RAISE EXCEPTION 'Agrega al menos una pregunta antes de publicar la encuesta'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- INSERT OR UPDATE OF is_published: cubre tanto publicar al crear (INSERT con
-- is_published=true, 0 preguntas → bloquea) como publicar al editar.
DROP TRIGGER IF EXISTS tg_poll_mixed_requires_questions ON public.polls;
CREATE TRIGGER tg_poll_mixed_requires_questions
  BEFORE INSERT OR UPDATE OF is_published ON public.polls
  FOR EACH ROW EXECUTE FUNCTION public._tg_poll_mixed_requires_questions();

-- ── Trigger: choices/tipo inmutables si la pregunta ya tiene respuestas ─
-- Cambiar las choices corrompe el significado de los selected_index ya
-- guardados; cambiar el tipo invalida las columnas de respuesta. Defensa
-- server-side (el front además deja choices read-only con respuestas).
CREATE OR REPLACE FUNCTION public._tg_poll_question_immutable_with_responses()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.type IS DISTINCT FROM OLD.type)
     OR ((NEW.options -> 'choices') IS DISTINCT FROM (OLD.options -> 'choices')) THEN
    IF EXISTS (SELECT 1 FROM public.poll_question_responses WHERE question_id = NEW.id) THEN
      RAISE EXCEPTION 'No puedes cambiar el tipo ni las opciones de una pregunta que ya tiene respuestas'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_poll_question_immutable ON public.poll_questions;
CREATE TRIGGER tg_poll_question_immutable
  BEFORE UPDATE ON public.poll_questions
  FOR EACH ROW EXECUTE FUNCTION public._tg_poll_question_immutable_with_responses();

NOTIFY pgrst, 'reload schema';
