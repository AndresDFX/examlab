-- ══════════════════════════════════════════════════════════════════════
-- Encuesta pública: sin sesiones duplicadas, y el caso "ya la llenó" se
-- resuelve en el SERVIDOR.
--
-- ── Los dos problemas ─────────────────────────────────────────────────
-- 1. `poll_public_open` insertaba una fila NUEVA en `poll_public_sessions`
--    cada vez que alguien escribía su correo. Recargar la página cinco veces
--    dejaba cinco filas. No corrompe nada —la respuesta sigue siendo única por
--    `UNIQUE (question_id, user_id)`— pero es una tabla que crece sin techo
--    desde una RPC abierta a internet y sin rate limit: el material de un
--    problema futuro.
--
-- 2. Que la persona YA hubiera respondido se decidía en el CLIENTE, mirando si
--    todas las preguntas venían con `ya_respondida`. Un RPC de PostgREST se
--    invoca con curl, así que ese chequeo no valía nada fuera del navegador: se
--    creaba la sesión igual y se intentaba escribir igual (el insert-only lo
--    frenaba, pero recién en la última línea de defensa).
--
-- ── Lo que cambia ─────────────────────────────────────────────────────
-- · `UNIQUE (poll_id, user_id)` en `poll_public_sessions` + upsert: una sesión
--   por persona por encuesta, para siempre. Reabrir el enlace reusa la misma
--   fila y solo mueve `last_seen_at`.
-- · `poll_public_open` cuenta primero: si la persona ya respondió TODAS las
--   preguntas, devuelve `ya_completada: true` y **no crea sesión ni entrega
--   preguntas**. Sin sesión no hay con qué escribir, así que el caso queda
--   cerrado en el servidor y no por cortesía del front.
-- · Devuelve también `total` y `respondidas`, para poder decirle a alguien que
--   dejó la encuesta a medias cuánto le falta en vez de mostrarle el
--   formulario como si no hubiera empezado.
--
-- La respuesta en sí ya era a prueba de duplicados por el UNIQUE de
-- `poll_question_responses` y por el insert-only de `poll_public_answer`; esto
-- no lo relaja, lo refuerza más arriba.
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.poll_public_sessions') IS NULL THEN
    RAISE NOTICE 'poll_public_sessions ausente — se omite';
    RETURN;
  END IF;

  -- Antes del UNIQUE hay que dejar UNA fila por (encuesta, persona). Se
  -- conserva la más antigua: es la que el navegador de esa persona podría
  -- tener en uso.
  DELETE FROM public.poll_public_sessions s
   WHERE EXISTS (
     SELECT 1 FROM public.poll_public_sessions t
      WHERE t.poll_id = s.poll_id
        AND t.user_id = s.user_id
        AND (t.created_at, t.id) < (s.created_at, s.id)
   );

  CREATE UNIQUE INDEX IF NOT EXISTS uq_poll_public_sessions_persona
    ON public.poll_public_sessions(poll_id, user_id);
END $$;

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
  v_total   INT;
  v_hechas  INT;
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

  SELECT count(*) INTO v_total FROM public.poll_questions WHERE poll_id = v_poll.id;
  SELECT count(*) INTO v_hechas
    FROM public.poll_question_responses r
    JOIN public.poll_questions q ON q.id = r.question_id
   WHERE q.poll_id = v_poll.id AND r.user_id = v_uid;

  -- Ya la llenó completa: no hay nada que abrir. Sin sesión no hay con qué
  -- escribir, así que el corte es del servidor y no del navegador.
  IF v_total > 0 AND v_hechas >= v_total THEN
    RETURN jsonb_build_object(
      'ya_completada', true,
      'title',         v_poll.title,
      'total',         v_total,
      'respondidas',   v_hechas,
      'questions',     '[]'::jsonb
    );
  END IF;

  -- Una sesión por persona por encuesta. Reabrir el enlace reusa la fila.
  INSERT INTO public.poll_public_sessions (poll_id, user_id)
  VALUES (v_poll.id, v_uid)
  ON CONFLICT (poll_id, user_id) DO UPDATE SET last_seen_at = now()
  RETURNING id INTO v_session;

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
    'ya_completada', false,
    'session_id',    v_session,
    'title',         v_poll.title,
    'total',         v_total,
    'respondidas',   v_hechas,
    'questions',     v_qs
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.poll_public_open(TEXT, TEXT) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
