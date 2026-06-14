-- ──────────────────────────────────────────────────────────────────────
-- Cerrar SIEMPRE la nota final del taller tras calificar con IA.
--
-- El trigger 20260930 recalculaba `workshop_submissions.final_grade` cuando
-- la ÚLTIMA respuesta pasaba de ai_grade NULL→valor. Dos huecos:
--   1) Sólo disparaba en NULL→valor → al REGENERAR (re-calificar, valor→valor)
--      no refrescaba la nota final.
--   2) `_pending` contaba TODA respuesta con ai_grade NULL, incluidas las de
--      preguntas CERRADAS (que la IA nunca califica). Si una respuesta cerrada
--      quedaba con ai_grade NULL, `_pending` nunca llegaba a 0 → la nota final
--      jamás se calculaba → la entrega aparecía "sin calificar" para siempre
--      (síntoma reportado en el tenant Camacho, y los conteos "Por calificar"
--      del dashboard/diagnóstico quedaban inflados).
--
-- Fix:
--   - `_pending` sólo cuenta respuestas de preguntas que la IA DEBE calificar
--     (type NOT IN cerrada/cerrada_multi). Las cerradas no bloquean el cierre.
--   - El trigger dispara en cualquier cambio de ai_grade (DISTINCT FROM), así
--     re-calificar también refresca la nota.
--   - La nota final se refresca salvo override manual del docente
--     (final_grade distinto del ai_grade previo → se respeta).
--   - Backfill: recalcula todas las entregas con respuestas ya calificadas
--     pero final_grade NULL (arregla Camacho + histórico, todos los tenants).
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
  SELECT ws.workshop_id INTO _ws_id
    FROM public.workshop_submissions ws WHERE ws.id = _sub_id;
  IF _ws_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- ¿Quedan respuestas que la IA DEBE calificar todavía sin nota? Las
  -- preguntas cerradas (scoring local) NO cuentan — si no, bloquearían
  -- el cierre indefinidamente.
  SELECT count(*) INTO _pending
    FROM public.workshop_submission_answers a
    JOIN public.workshop_questions q ON q.id = a.question_id
   WHERE a.submission_id = _sub_id
     AND q.type NOT IN ('cerrada', 'cerrada_multi')
     AND a.ai_grade IS NULL;
  IF _pending > 0 THEN
    RETURN NEW; -- aún faltan preguntas abiertas/código por calificar
  END IF;

  SELECT w.max_score INTO _max FROM public.workshops w WHERE w.id = _ws_id;
  SELECT COALESCE(SUM(points), 0) INTO _total
    FROM public.workshop_questions WHERE workshop_id = _ws_id;
  SELECT COALESCE(SUM(ai_grade), 0) INTO _earned
    FROM public.workshop_submission_answers WHERE submission_id = _sub_id;

  IF _total <= 0 THEN
    _final := 0;
  ELSE
    _final := round((_earned / _total) * COALESCE(_max, 100), 2);
  END IF;

  -- Refrescamos ai_grade y la nota final. final_grade se respeta SOLO si el
  -- docente lo sobreescribió manualmente (≠ del ai_grade previo); si era el
  -- auto previo (o NULL), se actualiza al nuevo valor — así regenerar también
  -- corrige la nota. No tocamos entregas marcadas 'sospechoso' (revisión de
  -- fraude manual) más allá de refrescar su grade.
  UPDATE public.workshop_submissions
     SET ai_grade    = _final,
         final_grade = CASE
                         WHEN final_grade IS NULL THEN _final
                         WHEN final_grade = ai_grade THEN _final
                         ELSE final_grade
                       END,
         status      = CASE WHEN status IN ('entregado', 'ai_revisado') THEN 'calificado' ELSE status END,
         ai_feedback = COALESCE(ai_feedback, 'Calificación automática (procesada en segundo plano).')
   WHERE id = _sub_id;

  RETURN NEW;
END
$$;

-- Disparar en CUALQUIER cambio de ai_grade (incluye regrade valor→valor).
DROP TRIGGER IF EXISTS trg_workshop_answer_graded_recompute
  ON public.workshop_submission_answers;
CREATE TRIGGER trg_workshop_answer_graded_recompute
  AFTER UPDATE OF ai_grade ON public.workshop_submission_answers
  FOR EACH ROW
  WHEN (NEW.ai_grade IS DISTINCT FROM OLD.ai_grade)
  EXECUTE FUNCTION public.tg_workshop_answer_graded_recompute();

-- ── Backfill: entregas con todas las respuestas (que requieren IA) ya
-- calificadas pero final_grade NULL → recomputar y cerrar. ──
DO $$
DECLARE
  r RECORD;
  _ws_id   UUID;
  _max     NUMERIC;
  _total   NUMERIC;
  _earned  NUMERIC;
  _pending INT;
  _final   NUMERIC;
  _count   INT := 0;
BEGIN
  IF to_regclass('public.workshop_submissions') IS NULL THEN
    RETURN;
  END IF;
  FOR r IN
    SELECT ws.id AS sub_id, ws.workshop_id
      FROM public.workshop_submissions ws
     WHERE ws.final_grade IS NULL
       AND ws.status IN ('entregado', 'ai_revisado')
       AND EXISTS (
         SELECT 1 FROM public.workshop_submission_answers a
          WHERE a.submission_id = ws.id AND a.ai_grade IS NOT NULL
       )
  LOOP
    -- ¿Quedan abiertas sin calificar?
    SELECT count(*) INTO _pending
      FROM public.workshop_submission_answers a
      JOIN public.workshop_questions q ON q.id = a.question_id
     WHERE a.submission_id = r.sub_id
       AND q.type NOT IN ('cerrada', 'cerrada_multi')
       AND a.ai_grade IS NULL;
    IF _pending > 0 THEN
      CONTINUE; -- entrega genuinamente incompleta, no la cerramos
    END IF;

    SELECT w.max_score INTO _max FROM public.workshops w WHERE w.id = r.workshop_id;
    SELECT COALESCE(SUM(points), 0) INTO _total
      FROM public.workshop_questions WHERE workshop_id = r.workshop_id;
    SELECT COALESCE(SUM(ai_grade), 0) INTO _earned
      FROM public.workshop_submission_answers WHERE submission_id = r.sub_id;

    IF _total <= 0 THEN
      _final := 0;
    ELSE
      _final := round((_earned / _total) * COALESCE(_max, 100), 2);
    END IF;

    UPDATE public.workshop_submissions
       SET ai_grade    = _final,
           final_grade = _final,
           status      = 'calificado',
           ai_feedback = COALESCE(ai_feedback, 'Calificación automática (backfill).')
     WHERE id = r.sub_id;
    _count := _count + 1;
  END LOOP;
  RAISE NOTICE 'Backfill workshop final_grade: % entregas', _count;
END $$;

NOTIFY pgrst, 'reload schema';
