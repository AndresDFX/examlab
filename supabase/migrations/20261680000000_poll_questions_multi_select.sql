-- ──────────────────────────────────────────────────────────────────────
-- Selección MÚLTIPLE en las preguntas cerradas de una encuesta mixta.
--
-- Hasta ahora una pregunta `cerrada` de `poll_questions` admitía UNA opción:
-- la respuesta se guardaba en `selected_index INT`. Una pregunta como
-- "¿Qué te ayudaría más este semestre? (puedes marcar varias)" no se podía
-- representar: había que partirla en N preguntas Sí/No, que le cambia el
-- instrumento al docente y multiplica los toques del estudiante.
--
-- ── Cómo se modela ────────────────────────────────────────────────────
--   · `poll_questions.multi` — solo tiene sentido en `cerrada`. Default FALSE,
--     así que TODA pregunta existente sigue siendo de opción única sin tocar
--     una sola fila.
--   · `poll_question_responses.selected_indexes INT[]` — la respuesta múltiple.
--     Se agrega en vez de reinterpretar `selected_index` porque las lecturas
--     que ya existen (resultados del docente, export) leen esa columna: si la
--     convirtiéramos en array, romperían todas a la vez. Las dos columnas son
--     mutuamente excluyentes y hay un CHECK que lo garantiza.
--
-- ── Por qué se DROPEA y recrea el RPC ─────────────────────────────────
-- `submit_poll_question_response` necesita un parámetro nuevo. Un
-- `CREATE OR REPLACE` con firma distinta NO reemplaza: crea un OVERLOAD, y dos
-- overloads dejan a PostgREST sin saber cuál llamar (`PGRST203`). Por eso se
-- dropea explícitamente la firma de 3 argumentos antes de crear la de 4. El
-- parámetro nuevo va con DEFAULT NULL, así que las llamadas actuales del
-- cliente (que pasan los parámetros por nombre) siguen funcionando igual.
--
-- Todo el cuerpo del RPC —autenticación, papelera, publicada, ventana abierta,
-- matrícula por `_poll_has_member`, `allow_change_response`— se conserva
-- idéntico. Lo único que se agrega es la rama de la respuesta múltiple.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.poll_questions') IS NULL THEN
    RAISE NOTICE 'poll_questions ausente — se omite el soporte de selección múltiple';
    RETURN;
  END IF;

  ALTER TABLE public.poll_questions
    ADD COLUMN IF NOT EXISTS multi BOOLEAN NOT NULL DEFAULT FALSE;

  COMMENT ON COLUMN public.poll_questions.multi IS
    'Solo para type=cerrada: TRUE permite marcar varias opciones (la respuesta va en poll_question_responses.selected_indexes).';

  IF to_regclass('public.poll_question_responses') IS NOT NULL THEN
    ALTER TABLE public.poll_question_responses
      ADD COLUMN IF NOT EXISTS selected_indexes INT[];

    COMMENT ON COLUMN public.poll_question_responses.selected_indexes IS
      'Respuesta de una pregunta cerrada con multi=TRUE. Excluyente con selected_index.';

    -- Honestidad del dato: nunca las dos a la vez. Todas las filas existentes
    -- tienen selected_indexes NULL, así que el CHECK se cumple sin backfill.
    ALTER TABLE public.poll_question_responses
      DROP CONSTRAINT IF EXISTS chk_poll_response_single_or_multi;
    ALTER TABLE public.poll_question_responses
      ADD CONSTRAINT chk_poll_response_single_or_multi
      CHECK (NOT (selected_index IS NOT NULL AND selected_indexes IS NOT NULL));
  END IF;
END $$;

-- ── RPC: se dropea la firma vieja y se recrea con la respuesta múltiple ──
DROP FUNCTION IF EXISTS public.submit_poll_question_response(UUID, TEXT, INT);

CREATE OR REPLACE FUNCTION public.submit_poll_question_response(
  _question_id UUID,
  _answer_text TEXT DEFAULT NULL,
  _selected_index INT DEFAULT NULL,
  _selected_indexes INT[] DEFAULT NULL
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
  v_idx      INT[];
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

  IF v_poll.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'La encuesta no está disponible' USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_poll.is_published THEN
    RAISE EXCEPTION 'La encuesta no está publicada' USING ERRCODE = 'P0001';
  END IF;

  IF NOT public.poll_is_open(v_poll) THEN
    RAISE EXCEPTION 'La encuesta está cerrada' USING ERRCODE = 'P0001';
  END IF;

  IF NOT public._poll_has_member(v_q.poll_id, v_uid) THEN
    RAISE EXCEPTION 'No estás matriculado en este curso' USING ERRCODE = '42501';
  END IF;

  IF v_q.type = 'cerrada' THEN
    IF NOT v_poll.allow_change_response THEN
      SELECT EXISTS (
        SELECT 1 FROM public.poll_question_responses
         WHERE question_id = _question_id AND user_id = v_uid
      ) INTO v_existing;
      IF v_existing THEN
        RAISE EXCEPTION 'No se permite cambiar la respuesta' USING ERRCODE = 'P0001';
      END IF;
    END IF;

    v_choices := COALESCE(jsonb_array_length(v_q.options -> 'choices'), 0);

    IF v_q.multi THEN
      -- ── Respuesta MÚLTIPLE ──────────────────────────────────────────
      -- Array vacío o NULL = quitar la respuesta (idempotente, igual que el
      -- texto vacío en las abiertas). Así el estudiante puede destildar todo
      -- sin quedar con una respuesta fantasma.
      IF _selected_indexes IS NULL OR array_length(_selected_indexes, 1) IS NULL THEN
        DELETE FROM public.poll_question_responses
         WHERE question_id = _question_id AND user_id = v_uid;
        RETURN;
      END IF;

      -- Dedup + orden estable: el cliente puede mandar repetidos o
      -- desordenados según el orden en que el usuario tildó.
      SELECT array_agg(DISTINCT x ORDER BY x) INTO v_idx
        FROM unnest(_selected_indexes) AS t(x);

      IF EXISTS (SELECT 1 FROM unnest(v_idx) AS t(x) WHERE x < 0 OR x >= v_choices) THEN
        RAISE EXCEPTION 'Opción fuera de rango' USING ERRCODE = '22023';
      END IF;

      INSERT INTO public.poll_question_responses
        (poll_id, question_id, user_id, selected_indexes, selected_index, answer_text, updated_at)
      VALUES
        (v_q.poll_id, _question_id, v_uid, v_idx, NULL, NULL, now())
      ON CONFLICT (question_id, user_id) DO UPDATE
        SET selected_indexes = EXCLUDED.selected_indexes,
            selected_index   = NULL,
            answer_text      = NULL,
            updated_at       = now();

    ELSE
      -- ── Respuesta ÚNICA (comportamiento original, sin cambios) ──────
      IF _selected_index IS NULL THEN
        RAISE EXCEPTION 'Debes seleccionar una opción' USING ERRCODE = '22023';
      END IF;
      IF _selected_index < 0 OR _selected_index >= v_choices THEN
        RAISE EXCEPTION 'Opción fuera de rango' USING ERRCODE = '22023';
      END IF;

      INSERT INTO public.poll_question_responses
        (poll_id, question_id, user_id, selected_index, selected_indexes, answer_text, updated_at)
      VALUES
        (v_q.poll_id, _question_id, v_uid, _selected_index, NULL, NULL, now())
      ON CONFLICT (question_id, user_id) DO UPDATE
        SET selected_index   = EXCLUDED.selected_index,
            selected_indexes = NULL,
            answer_text      = NULL,
            updated_at       = now();
    END IF;

  ELSIF v_q.type = 'abierta' THEN
    IF _answer_text IS NULL OR length(btrim(_answer_text)) = 0 THEN
      DELETE FROM public.poll_question_responses
       WHERE question_id = _question_id AND user_id = v_uid;
      RETURN;
    END IF;
    IF v_q.max_chars IS NOT NULL AND length(_answer_text) > v_q.max_chars THEN
      RAISE EXCEPTION 'La respuesta excede el máximo de % caracteres', v_q.max_chars
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.poll_question_responses
      (poll_id, question_id, user_id, answer_text, selected_index, selected_indexes, updated_at)
    VALUES
      (v_q.poll_id, _question_id, v_uid, _answer_text, NULL, NULL, now())
    ON CONFLICT (question_id, user_id) DO UPDATE
      SET answer_text      = EXCLUDED.answer_text,
          selected_index   = NULL,
          selected_indexes = NULL,
          updated_at       = now();
  ELSE
    RAISE EXCEPTION 'Tipo de pregunta no soportado: %', v_q.type USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_poll_question_response(UUID, TEXT, INT, INT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_poll_question_response(UUID, TEXT, INT, INT[]) TO authenticated;

-- ── El guard de inmutabilidad ahora cubre `multi` ─────────────────────
-- Cambiar `multi` con respuestas ya guardadas deja los datos sin sentido: las
-- respuestas viven en una columna distinta según el modo, así que pasar de
-- única a múltiple (o al revés) volvería invisibles las que ya estaban.
CREATE OR REPLACE FUNCTION public._tg_poll_question_immutable_with_responses()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.type IS DISTINCT FROM OLD.type)
     OR (NEW.multi IS DISTINCT FROM OLD.multi)
     OR ((NEW.options -> 'choices') IS DISTINCT FROM (OLD.options -> 'choices')) THEN
    IF EXISTS (SELECT 1 FROM public.poll_question_responses WHERE question_id = NEW.id) THEN
      RAISE EXCEPTION 'No puedes cambiar el tipo, el modo de selección ni las opciones de una pregunta que ya tiene respuestas'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
