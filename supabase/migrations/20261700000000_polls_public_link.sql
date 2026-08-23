-- ══════════════════════════════════════════════════════════════════════
-- Encuestas PÚBLICAS: responder por enlace, sin iniciar sesión.
--
-- Pedido: "poner las encuestas públicas, donde se pide inicialmente el correo,
-- y cuando se pida el correo ahí sí aparecen las preguntas puestas por el
-- docente".
--
-- ── La restricción que fija el diseño ─────────────────────────────────
-- `poll_question_responses.user_id` es `UUID NOT NULL REFERENCES auth.users`
-- con `UNIQUE (question_id, user_id)`. O sea: una respuesta SIEMPRE pertenece a
-- una cuenta real. Un respondiente sin cuenta no se puede guardar ahí sin
-- romper el modelo de datos y todas las lecturas del docente.
--
-- Por eso "público" acá significa **sin login**, no "cualquiera": el correo
-- tiene que estar MATRICULADO en un curso de la encuesta y se resuelve al
-- `user_id` del estudiante real. Es exactamente el modelo que ya usa el Reto en
-- vivo (`kahoot_join_public`, mig 20261290000000), y es lo que el docente
-- quiere: sus estudiantes responden sin pelear con la contraseña, y la
-- respuesta queda atribuida a la persona correcta.
--
-- ── El GRANT no es la frontera; el CUERPO lo es ───────────────────────
-- Dato verificado contra el volcado de ACLs del propio repo
-- (`.rls-audit/secdef-funcs.json`): **256 de 305 funciones SECURITY DEFINER ya
-- tienen `anon=X`**, porque Supabase aplica ALTER DEFAULT PRIVILEGES y el
-- `REVOKE ALL ... FROM PUBLIC` que usa la convención del repo NO borra la
-- entrada explícita de `anon` del ACL. Lo único que hoy frena a un anónimo es
-- el `IF auth.uid() IS NULL THEN RAISE` del cuerpo de cada función.
--
-- Consecuencia para estas 3 RPCs: **toda la autorización va en el cuerpo, en
-- orden, y nada se delega al GRANT ni al cliente.** Un RPC de PostgREST se
-- invoca con curl; filtrar en el front es decoración.
--
-- ── Decisiones, cada una con su motivo ────────────────────────────────
-- 1. TOKEN DEDICADO (`public_token`), no el `poll.id`. El id ya circula en el
--    enlace autenticado que comparte el docente (`/app/student/polls?poll=<id>`),
--    así que reusarlo haría imposible cortar un enlace filtrado sin romper el
--    otro. Con token aparte, regenerarlo mata el enlace viejo al instante.
-- 2. NADA se vuelve público solo: `public_enabled` arranca en FALSE y el token
--    se genera recién cuando el docente lo pide.
-- 3. DOS PASOS, como pidió el pedido: `poll_public_info` devuelve SOLO título y
--    descripción (para que el visitante sepa qué va a responder); las PREGUNTAS
--    salen únicamente de `poll_public_open`, después del correo. Así el
--    enunciado no queda expuesto a quien solo tiene el enlace.
-- 4. **SOLO ALTA, nunca modificación.** El camino público inserta respuestas
--    donde no había, y si la pregunta ya tiene respuesta la deja intacta. Con
--    identidad por correo —adivinable— un UPSERT dejaría que un tercero PISE
--    las respuestas de un compañero, y un read-back dejaría que las LEA. Sin
--    modificación y sin devolver lo ya guardado, ninguna de las dos cosas es
--    posible.
-- 5. Riesgo residual que NO se resuelve acá y hay que saber: alguien con el
--    enlace y un correo adivinado puede ADELANTARSE y responder por otro que
--    todavía no respondió. Cerrarlo pide verificación real (código de un solo
--    uso al correo), que queda fuera de v1. Por eso un instrumento SENSIBLE
--    (bienestar, salud, situación económica) NO debería publicarse por enlace:
--    para eso está el enlace autenticado, que ya existe.
-- ══════════════════════════════════════════════════════════════════════

-- ── Columnas ──────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.polls') IS NULL THEN
    RAISE NOTICE 'polls ausente — se omite el enlace público';
    RETURN;
  END IF;

  ALTER TABLE public.polls
    ADD COLUMN IF NOT EXISTS public_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS public_token   TEXT;

  -- El token es el secreto del enlace: único, y con índice para resolverlo en
  -- O(log n) desde una RPC que puede recibir tráfico de internet.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_polls_public_token
    ON public.polls(public_token) WHERE public_token IS NOT NULL;

  -- Solo las MIXTAS se pueden abrir al público, y es una restricción
  -- ESTRUCTURAL, no una convención del cliente. Dos razones concretas:
  --   · Son las únicas con preguntas propias (`poll_questions`), que es lo que
  --     el pedido quiere mostrar.
  --   · Su camino de respuesta NO toca `poll_responses`, así que los triggers
  --     `_tg_poll_response_enforce_single` y
  --     `_tg_poll_autoclose_when_all_responded` quedan fuera del alcance de un
  --     anónimo. Sin este CHECK, una encuesta `slot` publicada por enlace
  --     dejaría que un bot queme los cupos, y una `single` que fuerce el
  --     autocierre respondiendo por todos.
  -- Todas las filas existentes tienen FALSE, así que el CHECK entra sin backfill.
  ALTER TABLE public.polls DROP CONSTRAINT IF EXISTS chk_polls_public_only_mixed;
  ALTER TABLE public.polls
    ADD CONSTRAINT chk_polls_public_only_mixed
    CHECK (public_enabled = FALSE OR poll_type = 'mixed');

  COMMENT ON COLUMN public.polls.public_enabled IS
    'TRUE = se puede responder por enlace público sin iniciar sesión (el correo debe estar matriculado). Default FALSE: ninguna encuesta se vuelve pública sola.';
  COMMENT ON COLUMN public.polls.public_token IS
    'Secreto del enlace público (32 hex). Regenerarlo invalida el enlace compartido. NULL = nunca se generó.';
END $$;

-- ── Sesión del respondiente anónimo ───────────────────────────────────
-- El anónimo no tiene JWT, así que después de validar el correo opera con el id
-- de una fila de esta tabla (mismo patrón que `kahoot_players.id`). Guardar la
-- sesión —en vez de devolverle el `user_id` del estudiante— evita entregarle al
-- navegador un identificador real que después pueda reusar en otra parte.
CREATE TABLE IF NOT EXISTS public.poll_public_sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id    UUID NOT NULL REFERENCES public.polls(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pps_poll ON public.poll_public_sessions(poll_id);

ALTER TABLE public.poll_public_sessions ENABLE ROW LEVEL SECURITY;

-- Sin ninguna policy: la tabla NO se lee ni se escribe por REST, ni por anon ni
-- por authenticated. Solo la tocan las RPCs SECURITY DEFINER de abajo. Es el
-- mismo criterio que `content_file_progress`: si hubiera policy de lectura, el
-- id de sesión de otro sería enumerable.
REVOKE ALL ON TABLE public.poll_public_sessions FROM anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- RPC 1 — Info mínima del enlace, ANTES del correo.
-- Devuelve título y descripción. NO devuelve preguntas, ni curso, ni
-- institución, ni cuántos respondieron.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.poll_public_info(_token TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_poll public.polls;
BEGIN
  IF _token IS NULL OR length(btrim(_token)) = 0 THEN
    RAISE EXCEPTION 'Enlace inválido' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_poll FROM public.polls WHERE public_token = btrim(_token);

  -- Un solo mensaje para "no existe", "no es pública", "está en la papelera",
  -- "es borrador" y "está cerrada por fecha": distinguirlos le diría a un
  -- desconocido qué encuestas existen. La única excepción es "cerrada", que el
  -- visitante necesita entender para no insistir.
  IF v_poll.id IS NULL
     OR NOT v_poll.public_enabled
     OR v_poll.deleted_at IS NOT NULL
     OR NOT v_poll.is_published THEN
    RAISE EXCEPTION 'Este enlace no está disponible' USING ERRCODE = 'P0001';
  END IF;

  IF NOT public.poll_is_open(v_poll) THEN
    RAISE EXCEPTION 'La encuesta está cerrada' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'title',       v_poll.title,
    'description', v_poll.description
  );
END;
$$;

-- ══════════════════════════════════════════════════════════════════════
-- RPC 2 — El correo abre las preguntas.
-- Valida matrícula y devuelve las preguntas + un id de sesión. NO devuelve las
-- respuestas ya guardadas (ver decisión 4): solo si CADA pregunta ya está
-- respondida, para que el formulario no invite a escribir donde no se va a
-- guardar nada.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.poll_public_open(_token TEXT, _email TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_poll    public.polls;
  v_email   TEXT := lower(btrim(coalesce(_email, '')));
  v_uid     UUID;
  v_session UUID;
  v_qs      jsonb;
BEGIN
  IF v_email = '' OR position('@' in v_email) = 0 THEN
    RAISE EXCEPTION 'Escribe un correo válido' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_poll FROM public.polls WHERE public_token = btrim(coalesce(_token, ''));
  IF v_poll.id IS NULL
     OR NOT v_poll.public_enabled
     OR v_poll.deleted_at IS NOT NULL
     OR NOT v_poll.is_published THEN
    RAISE EXCEPTION 'Este enlace no está disponible' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.poll_is_open(v_poll) THEN
    RAISE EXCEPTION 'La encuesta está cerrada' USING ERRCODE = 'P0001';
  END IF;

  -- El correo tiene que ser de alguien MATRICULADO en un curso de la encuesta.
  -- `_poll_has_member` pasa por `poll_courses`, y `tg_poll_courses_enforce_tenant`
  -- impide vincular cursos de instituciones distintas, así que esto además
  -- implica "mismo tenant" sin comprobarlo aparte.
  SELECT p.id INTO v_uid
    FROM public.profiles p
   WHERE lower(p.institutional_email) = v_email
     AND public._poll_has_member(v_poll.id, p.id)
   LIMIT 1;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Ese correo no está en la lista de este curso. Revisa si escribiste el correo institucional.'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.poll_public_sessions (poll_id, user_id)
  VALUES (v_poll.id, v_uid)
  RETURNING id INTO v_session;

  -- Las preguntas, en orden, SIN respuestas. `ya_respondida` alcanza para que
  -- el formulario muestre el estado sin revelar el contenido.
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'position'), '[]'::jsonb) INTO v_qs
    FROM (
      SELECT jsonb_build_object(
               'id',        q.id,
               'position',  q.position,
               'type',      q.type,
               'text',      q.text,
               'options',   q.options,
               'required',  q.required,
               'max_chars', q.max_chars,
               'multi',     q.multi,
               'ya_respondida', EXISTS (
                 SELECT 1 FROM public.poll_question_responses r
                  WHERE r.question_id = q.id AND r.user_id = v_uid
               )
             ) AS x
        FROM public.poll_questions q
       WHERE q.poll_id = v_poll.id
       ORDER BY q.position, q.created_at
    ) s;

  RETURN jsonb_build_object(
    'session_id', v_session,
    'title',      v_poll.title,
    'questions',  v_qs
  );
END;
$$;

-- ══════════════════════════════════════════════════════════════════════
-- RPC 3 — Guardar una respuesta. SOLO ALTA.
-- Si la pregunta ya tiene respuesta de esa persona, no se toca (ver decisión 4).
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.poll_public_answer(
  _session_id UUID,
  _question_id UUID,
  _answer_text TEXT DEFAULT NULL,
  _selected_index INT DEFAULT NULL,
  _selected_indexes INT[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_s       public.poll_public_sessions;
  v_poll    public.polls;
  v_q       public.poll_questions;
  v_choices INT;
  v_idx     INT[];
BEGIN
  SELECT * INTO v_s FROM public.poll_public_sessions WHERE id = _session_id;
  IF v_s.id IS NULL THEN
    RAISE EXCEPTION 'Tu sesión expiró. Vuelve a abrir el enlace.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_poll FROM public.polls WHERE id = v_s.poll_id;
  IF v_poll.id IS NULL
     OR NOT v_poll.public_enabled
     OR v_poll.deleted_at IS NOT NULL
     OR NOT v_poll.is_published THEN
    RAISE EXCEPTION 'Este enlace no está disponible' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.poll_is_open(v_poll) THEN
    RAISE EXCEPTION 'La encuesta está cerrada' USING ERRCODE = 'P0001';
  END IF;

  -- La pregunta tiene que ser DE ESTA encuesta: sin esto, una sesión válida
  -- serviría para escribir en cualquier pregunta de cualquier encuesta.
  SELECT * INTO v_q FROM public.poll_questions
   WHERE id = _question_id AND poll_id = v_s.poll_id;
  IF v_q.id IS NULL THEN
    RAISE EXCEPTION 'Pregunta inexistente' USING ERRCODE = '22023';
  END IF;

  -- Solo alta. Ya respondida = no se toca, y se responde ok para que el
  -- formulario no muestre un error donde no hay nada que arreglar.
  IF EXISTS (
    SELECT 1 FROM public.poll_question_responses
     WHERE question_id = _question_id AND user_id = v_s.user_id
  ) THEN
    RETURN jsonb_build_object('guardada', false, 'motivo', 'ya_respondida');
  END IF;

  IF v_q.type = 'cerrada' THEN
    v_choices := COALESCE(jsonb_array_length(v_q.options -> 'choices'), 0);

    IF v_q.multi THEN
      SELECT array_agg(DISTINCT x ORDER BY x) INTO v_idx
        FROM unnest(COALESCE(_selected_indexes, ARRAY[]::INT[])) AS t(x);
      IF v_idx IS NULL OR array_length(v_idx, 1) IS NULL THEN
        RAISE EXCEPTION 'Marca al menos una opción' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (SELECT 1 FROM unnest(v_idx) AS t(x) WHERE x < 0 OR x >= v_choices) THEN
        RAISE EXCEPTION 'Opción fuera de rango' USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.poll_question_responses
        (poll_id, question_id, user_id, selected_indexes)
      VALUES (v_s.poll_id, _question_id, v_s.user_id, v_idx)
      ON CONFLICT (question_id, user_id) DO NOTHING;
    ELSE
      IF _selected_index IS NULL THEN
        RAISE EXCEPTION 'Selecciona una opción' USING ERRCODE = '22023';
      END IF;
      IF _selected_index < 0 OR _selected_index >= v_choices THEN
        RAISE EXCEPTION 'Opción fuera de rango' USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.poll_question_responses
        (poll_id, question_id, user_id, selected_index)
      VALUES (v_s.poll_id, _question_id, v_s.user_id, _selected_index)
      ON CONFLICT (question_id, user_id) DO NOTHING;
    END IF;

  ELSIF v_q.type = 'abierta' THEN
    IF _answer_text IS NULL OR length(btrim(_answer_text)) = 0 THEN
      RAISE EXCEPTION 'Escribe tu respuesta' USING ERRCODE = '22023';
    END IF;
    IF v_q.max_chars IS NOT NULL AND length(_answer_text) > v_q.max_chars THEN
      RAISE EXCEPTION 'La respuesta excede el máximo de % caracteres', v_q.max_chars
        USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.poll_question_responses
      (poll_id, question_id, user_id, answer_text)
    VALUES (v_s.poll_id, _question_id, v_s.user_id, btrim(_answer_text))
    ON CONFLICT (question_id, user_id) DO NOTHING;
  ELSE
    RAISE EXCEPTION 'Tipo de pregunta no soportado: %', v_q.type USING ERRCODE = '22023';
  END IF;

  UPDATE public.poll_public_sessions SET last_seen_at = now() WHERE id = _session_id;
  RETURN jsonb_build_object('guardada', true);
END;
$$;

-- ══════════════════════════════════════════════════════════════════════
-- RPC 4 — El docente activa el enlace y obtiene el token.
-- Autenticada, no pública. Genera el token la primera vez; `_regenerate`
-- invalida el enlace anterior.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.poll_set_public(
  _poll_id UUID,
  _enabled BOOLEAN,
  _regenerate BOOLEAN DEFAULT FALSE
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_poll  public.polls;
  v_token TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_poll FROM public.polls WHERE id = _poll_id AND deleted_at IS NULL;
  IF v_poll.id IS NULL THEN
    RAISE EXCEPTION 'Encuesta inexistente' USING ERRCODE = '22023';
  END IF;

  -- Solo el docente del curso ancla, un docente de un curso vinculado, o un
  -- Admin de la MISMA institución. La rama de Admin va con scope de tenant a
  -- propósito: `has_role` es global y sin el scope un Admin de otra institución
  -- podría publicar esta encuesta.
  IF NOT (
        public._poll_anchor_teacher(_poll_id, v_uid)
     OR public._poll_linked_teacher(_poll_id, v_uid)
     OR (
          (public.has_role(v_uid, 'Admin') OR public.has_role(v_uid, 'SuperAdmin'))
          AND public.course_in_my_tenant(v_poll.course_id)
        )
  ) THEN
    RAISE EXCEPTION 'No puedes cambiar el enlace público de esta encuesta' USING ERRCODE = '42501';
  END IF;

  -- Mismo límite que el CHECK, pero con un mensaje que el docente entiende:
  -- una violación de CHECK saldría como 23514 y friendlyError la traduce a algo
  -- genérico.
  IF _enabled AND v_poll.poll_type <> 'mixed' THEN
    RAISE EXCEPTION 'Solo las encuestas con preguntas propias se pueden compartir por enlace público'
      USING ERRCODE = 'P0001';
  END IF;

  v_token := v_poll.public_token;
  IF _enabled AND (v_token IS NULL OR _regenerate) THEN
    v_token := encode(gen_random_bytes(16), 'hex');
  END IF;

  UPDATE public.polls
     SET public_enabled = _enabled,
         public_token   = CASE WHEN _enabled THEN v_token ELSE public_token END,
         updated_at     = now()
   WHERE id = _poll_id;

  RETURN CASE WHEN _enabled THEN v_token ELSE NULL END;
END;
$$;

-- ── GRANTs ────────────────────────────────────────────────────────────
-- Explícitos para las 3 públicas. Recordar: el GRANT no es la frontera (anon ya
-- tiene EXECUTE por default privileges en casi todas las SECDEF de este
-- proyecto) — la frontera es el cuerpo, que es donde están todos los guards.
GRANT EXECUTE ON FUNCTION public.poll_public_info(TEXT)                       TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.poll_public_open(TEXT, TEXT)                 TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.poll_public_answer(UUID, UUID, TEXT, INT, INT[]) TO anon, authenticated;

-- La del docente NO va a anon: su guard es `auth.uid()`, y dejarla fuera del
-- GRANT es la segunda barrera.
REVOKE ALL ON FUNCTION public.poll_set_public(UUID, BOOLEAN, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.poll_set_public(UUID, BOOLEAN, BOOLEAN) TO authenticated;

NOTIFY pgrst, 'reload schema';
