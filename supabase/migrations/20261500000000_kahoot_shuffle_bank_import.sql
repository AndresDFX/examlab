-- ══════════════════════════════════════════════════════════════════════
-- Reto en vivo (kahoot): barajar la POSICIÓN de las opciones al importar del
-- banco de preguntas.
--
-- CONTEXTO: la respuesta correcta quedaba SIEMPRE en el primer slot porque
-- ningún camino de creación barajaba y el juego renderiza ORDER BY position.
-- Los caminos de front (generación IA, duplicar) se arreglaron en el mismo
-- cambio; este RPC (import del banco) insertaba las opciones con position=_idx
-- (orden del banco), heredando el orden — acá se baraja.
--
-- CÓMO: se calcula is_correct por el ÍNDICE ORIGINAL del banco (correct_index /
-- correct_indices se refieren a ese orden) y luego se permuta solo `position`
-- con ROW_NUMBER() OVER (ORDER BY random()). is_correct NUNCA cambia — solo el
-- slot donde se muestra. La correctitud en vivo se evalúa por is_correct, no por
-- posición, así que barajar no afecta la calificación.
-- ══════════════════════════════════════════════════════════════════════

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

    -- Opciones: primeras 4 choices. is_correct se calcula por el índice ORIGINAL
    -- (ord-1) del banco; la POSICIÓN se baraja con ROW_NUMBER() OVER (ORDER BY
    -- random()) → 0..n-1, así la correcta no queda siempre en el slot 0.
    INSERT INTO public.kahoot_question_options (question_id, label, is_correct, position)
    SELECT _qid,
           c.label,
           c.is_correct,
           (ROW_NUMBER() OVER (ORDER BY random()) - 1)::int
    FROM (
      SELECT left(t.value, 200) AS label,
             CASE
               WHEN _multi THEN COALESCE((_bank.options->'correct_indices') @> to_jsonb((t.ord - 1)::int), false)
               ELSE ((_bank.options->>'correct_index')::int = (t.ord - 1))
             END AS is_correct
      FROM jsonb_array_elements_text(_choices) WITH ORDINALITY AS t(value, ord)
      WHERE t.ord <= 4
    ) c;

    -- Defensa: garantizar ≥1 correcta (si el índice del banco quedó fuera de
    -- rango o se truncó). Marca la opción que haya caído en el slot 0.
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
