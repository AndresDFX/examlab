-- ──────────────────────────────────────────────────────────────────────
-- Banco de preguntas → Kahoot (add_questions_from_bank_to_kahoot)
--
-- Exámenes, talleres y proyectos YA importan del banco (RPCs
-- add_questions_from_bank_to_{exam,workshop,project}, mig 20260518100000).
-- Faltaba Kahoot. A diferencia de las otras (insertan en 1 tabla con
-- `options` JSONB), Kahoot usa DOS tablas: kahoot_questions +
-- kahoot_question_options (una fila por opción, con is_correct).
--
-- Solo se importan preguntas de opción múltiple del banco
-- (type IN ('cerrada','cerrada_multi')) — Kahoot es multiple-choice. Las
-- abiertas/código/etc. se filtran. `cerrada_multi` → multi_select=true.
-- Las opciones del banco viven en options.choices (array) + correct_index
-- (cerrada) / correct_indices (cerrada_multi). Kahoot admite 2-4 opciones:
-- tomamos las primeras 4 y saltamos preguntas con < 2 opciones.
--
-- Puntos: la escala del banco (suggested_points, default 1) NO aplica a
-- Kahoot (0-2000). Default 1000 (el estándar Kahoot); _points_override
-- permite un valor por pregunta, clampeado a [0,2000].
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.add_questions_from_bank_to_kahoot(
  _bank_ids UUID[],
  _poll_id UUID,
  _points_override JSONB DEFAULT '{}'::jsonb
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _max_pos INT;
  _inserted INT := 0;
  _bank RECORD;
  _points INT;
  _multi BOOLEAN;
  _qid UUID;
  _choices JSONB;
  _label TEXT;
  _idx INT;
  _is_correct BOOLEAN;
BEGIN
  -- Autorización: Admin o docente del curso ancla del poll Kahoot.
  IF NOT (
    public.has_role(auth.uid(), 'Admin') OR EXISTS (
      SELECT 1 FROM public.polls p
      JOIN public.course_teachers ct ON ct.course_id = p.course_id
      WHERE p.id = _poll_id AND p.poll_type = 'kahoot' AND ct.user_id = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para modificar este Kahoot';
  END IF;

  SELECT COALESCE(MAX(position), -1) INTO _max_pos
    FROM public.kahoot_questions WHERE poll_id = _poll_id;

  FOR _bank IN
    SELECT b.* FROM public.question_bank b
    WHERE b.id = ANY(_bank_ids)
      AND b.type IN ('cerrada', 'cerrada_multi')  -- Kahoot = opción múltiple
      AND b.options IS NOT NULL
      AND (
        public.has_role(auth.uid(), 'Admin') OR EXISTS (
          SELECT 1 FROM public.course_teachers ct
          WHERE ct.course_id = b.course_id AND ct.user_id = auth.uid()
        )
      )
  LOOP
    _choices := _bank.options->'choices';
    -- Necesita al menos 2 opciones; Kahoot admite máximo 4.
    IF _choices IS NULL OR jsonb_typeof(_choices) <> 'array' OR jsonb_array_length(_choices) < 2 THEN
      CONTINUE;
    END IF;

    _multi := (_bank.type = 'cerrada_multi');
    _points := LEAST(2000, GREATEST(0, COALESCE(
      (_points_override->>(_bank.id::text))::int,
      1000
    )));
    _max_pos := _max_pos + 1;

    INSERT INTO public.kahoot_questions (poll_id, text, time_limit_seconds, points, multi_select, position)
    VALUES (_poll_id, left(_bank.content, 500), 20, _points, _multi, _max_pos)
    RETURNING id INTO _qid;

    -- Opciones: primeras 4 choices. is_correct desde correct_index(es).
    _idx := 0;
    FOR _label IN
      SELECT value FROM jsonb_array_elements_text(_choices) LIMIT 4
    LOOP
      IF _multi THEN
        _is_correct := COALESCE((_bank.options->'correct_indices') @> to_jsonb(_idx), false);
      ELSE
        _is_correct := ((_bank.options->>'correct_index')::int = _idx);
      END IF;
      INSERT INTO public.kahoot_question_options (question_id, label, is_correct, position)
      VALUES (_qid, left(_label, 200), COALESCE(_is_correct, false), _idx);
      _idx := _idx + 1;
    END LOOP;

    -- Defensa: garantizar ≥1 correcta (si el índice del banco quedó fuera de
    -- rango o se truncó). Marca la primera opción.
    IF NOT EXISTS (
      SELECT 1 FROM public.kahoot_question_options WHERE question_id = _qid AND is_correct
    ) THEN
      UPDATE public.kahoot_question_options SET is_correct = true
        WHERE question_id = _qid AND position = 0;
    END IF;

    UPDATE public.question_bank
      SET times_used = times_used + 1, last_used_at = now()
      WHERE id = _bank.id;
    _inserted := _inserted + 1;
  END LOOP;

  RETURN _inserted;
END
$$;

REVOKE ALL ON FUNCTION public.add_questions_from_bank_to_kahoot(UUID[], UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_questions_from_bank_to_kahoot(UUID[], UUID, JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
