-- ──────────────────────────────────────────────────────────────────────
-- Con "permitir cambiar respuesta" APAGADO, una pregunta múltiple aceptaba
-- UNA sola opción.
--
-- ── El bug ────────────────────────────────────────────────────────────
-- `submit_poll_question_response` bloquea la escritura cuando el poll tiene
-- `allow_change_response = false` y YA existe una fila para (pregunta, usuario).
-- Ese predicado es correcto para la opción ÚNICA —la fila ES la respuesta
-- terminada— pero no para la múltiple: el cliente reenvía el ARRAY COMPLETO en
-- cada clic (`submitMulti` en app.student.polls.tsx), así que el segundo tilde
-- llega cuando la fila ya existe y se rebota con "No se permite cambiar la
-- respuesta". El estudiante marcaba una opción y la pregunta quedaba trabada,
-- justo en una pregunta cuyo enunciado dice "puedes marcar varias".
--
-- El comentario del render ya declaraba la semántica correcta —"marcar una
-- segunda opción es COMPLETAR la respuesta, no cambiarla"— pero el servidor no
-- la implementaba. Esta migración la implementa.
--
-- ── La regla ──────────────────────────────────────────────────────────
-- Con el candado puesto y la pregunta múltiple, la escritura pasa SOLO si el
-- array nuevo es un SUPERCONJUNTO del guardado:
--
--     {0}    → {0,1}   ✔ completar   (agrega, no toca lo dicho)
--     {0,1}  → {0}     ✘ cambiar     (retira algo ya afirmado)
--     {0}    → {1}     ✘ cambiar     (reemplaza)
--     {0,1}  → {}      ✘ cambiar     (borrar todo también es cambiar)
--
-- Es determinista y no necesita estado nuevo: "nunca podés desdecirte" es
-- exactamente lo que significa el candado, y agregar una opción no desdice
-- ninguna. La opción única no cambia: cualquier fila existente sigue
-- bloqueando.
--
-- Se recrea la función completa porque las migraciones aplicadas son
-- inmutables. El cuerpo es idéntico al de 20261680000000 salvo el bloque del
-- candado; la firma NO cambia, así que basta `CREATE OR REPLACE` (no hay
-- cambio de tipo de retorno ni overload nuevo).
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.poll_questions') IS NULL THEN
    RAISE NOTICE 'poll_questions ausente — se omite el arreglo del candado múltiple';
    RETURN;
  END IF;
END $$;

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
  v_prev     INT[];
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
    v_choices := COALESCE(jsonb_array_length(v_q.options -> 'choices'), 0);

    IF v_q.multi THEN
      -- ── Respuesta MÚLTIPLE ──────────────────────────────────────────
      -- Dedup + orden estable ANTES del candado: el cliente puede mandar
      -- repetidos o desordenados según el orden en que el usuario tildó, y el
      -- candado compara conjuntos.
      SELECT array_agg(DISTINCT x ORDER BY x) INTO v_idx
        FROM unnest(COALESCE(_selected_indexes, ARRAY[]::INT[])) AS t(x);
      v_idx := COALESCE(v_idx, ARRAY[]::INT[]);

      SELECT COALESCE(selected_indexes, ARRAY[]::INT[]) INTO v_prev
        FROM public.poll_question_responses
       WHERE question_id = _question_id AND user_id = v_uid;
      v_prev := COALESCE(v_prev, ARRAY[]::INT[]);

      -- Candado: completar SÍ, cambiar NO. `@>` es "contiene": el array nuevo
      -- tiene que contener todo lo que ya estaba dicho.
      IF NOT v_poll.allow_change_response AND NOT (v_idx @> v_prev) THEN
        RAISE EXCEPTION 'No se permite cambiar la respuesta: podés agregar opciones, no quitarlas'
          USING ERRCODE = 'P0001';
      END IF;

      -- Array vacío = quitar la respuesta (idempotente, igual que el texto
      -- vacío en las abiertas). Con el candado puesto ya quedó rechazado
      -- arriba salvo que no hubiera nada guardado, donde borrar es un no-op.
      IF array_length(v_idx, 1) IS NULL THEN
        DELETE FROM public.poll_question_responses
         WHERE question_id = _question_id AND user_id = v_uid;
        RETURN;
      END IF;

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
      -- ── Respuesta ÚNICA (sin cambios: la fila ES la respuesta) ──────
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
    -- Las abiertas NO llevan el candado, igual que antes. Guardan con debounce
    -- en cada tecla, así que un predicado por existencia de fila las rompería
    -- del mismo modo que rompía a las múltiples: la segunda pulsación llega
    -- cuando la fila ya existe. Si alguna vez se quiere cerrar la abierta, hace
    -- falta un "confirmar" explícito, no este candado.
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

NOTIFY pgrst, 'reload schema';
