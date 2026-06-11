-- ──────────────────────────────────────────────────────────────────────
-- Cerrar el ciclo de calificación ASÍNCRONA de talleres.
--
-- Problema: cuando un taller se califica en segundo plano (processing_mode
-- async, o el fallback sync→cola que agregamos cuando la IA da 503), el
-- worker llena `workshop_submission_answers.ai_grade` por pregunta vía el
-- edge `ai-grade-submission` (workshopFullGrading, persistedInternally), pero
-- NADIE recalculaba `workshop_submissions.final_grade` ni cambiaba el status a
-- 'calificado'. Resultado: la entrega quedaba en 'entregado' (pendiente) para
-- siempre aunque todas las respuestas ya estuvieran calificadas.
--
-- Fix: trigger AFTER UPDATE OF ai_grade que dispara SOLO cuando una respuesta
-- pendiente (ai_grade NULL) pasa a tener nota (NULL → no-NULL) — es decir, el
-- worker acaba de calificar una pregunta. En ese momento, si NINGUNA respuesta
-- de la entrega sigue pendiente, recalcula la nota final (mismo cálculo que el
-- path sync del cliente: earned/total * max_score) y marca 'calificado'.
--
-- El gate `OLD.ai_grade IS NULL AND NEW.ai_grade IS NOT NULL` evita interferir
-- con el path SÍNCRONO (ahí las respuestas se upsertean ya con nota, no hay
-- transición NULL→valor) y evita recursión (el trigger actualiza
-- workshop_submissions, no las answers).
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_workshop_answer_graded_recompute()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _sub_id   UUID := NEW.submission_id;
  _ws_id    UUID;
  _max      NUMERIC;
  _total    NUMERIC;
  _earned   NUMERIC;
  _pending  INT;
  _final    NUMERIC;
BEGIN
  -- ¿Quedan respuestas pendientes (sin nota IA) en esta entrega?
  SELECT count(*) INTO _pending
    FROM public.workshop_submission_answers
   WHERE submission_id = _sub_id AND ai_grade IS NULL;
  IF _pending > 0 THEN
    RETURN NEW; -- todavía faltan preguntas por calificar
  END IF;

  -- Taller + escala máxima de la entrega.
  SELECT ws.workshop_id INTO _ws_id
    FROM public.workshop_submissions ws
   WHERE ws.id = _sub_id;
  IF _ws_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT w.max_score INTO _max FROM public.workshops w WHERE w.id = _ws_id;

  -- total = suma de puntos de las preguntas del taller;
  -- earned = suma de las notas por respuesta (ya capadas al puntaje de c/u).
  SELECT COALESCE(SUM(points), 0) INTO _total
    FROM public.workshop_questions WHERE workshop_id = _ws_id;
  SELECT COALESCE(SUM(ai_grade), 0) INTO _earned
    FROM public.workshop_submission_answers WHERE submission_id = _sub_id;

  IF _total <= 0 THEN
    _final := 0;
  ELSE
    _final := round((_earned / _total) * COALESCE(_max, 100), 2);
  END IF;

  -- Solo cerramos entregas que SEGUÍAN pendientes (no pisamos un override del
  -- docente ni una entrega ya calificada/sospechosa marcada a mano).
  UPDATE public.workshop_submissions
     SET ai_grade     = _final,
         final_grade  = COALESCE(final_grade, _final),
         status       = 'calificado',
         ai_feedback  = 'Calificación automática (procesada en segundo plano).'
   WHERE id = _sub_id
     AND status IN ('entregado', 'ai_revisado');

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_workshop_answer_graded_recompute
  ON public.workshop_submission_answers;
CREATE TRIGGER trg_workshop_answer_graded_recompute
  AFTER UPDATE OF ai_grade ON public.workshop_submission_answers
  FOR EACH ROW
  WHEN (OLD.ai_grade IS NULL AND NEW.ai_grade IS NOT NULL)
  EXECUTE FUNCTION public.tg_workshop_answer_graded_recompute();

NOTIFY pgrst, 'reload schema';
