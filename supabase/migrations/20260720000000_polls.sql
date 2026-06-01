-- ──────────────────────────────────────────────────────────────────────
-- Encuestas (polls) — docente lanza preguntas/votaciones a sus alumnos
--
-- Dos casos de uso que cubre el mismo modelo:
--
--  A) EN VIVO durante una sesión: el docente plantea una pregunta
--     mientras dicta clase ("¿Quedó claro el concepto X?", "¿Prefieren
--     repaso o seguir adelante?"). Se asocia opcionalmente a un
--     `attendance_session_id` para que aparezca destacada en la pantalla
--     de la clase del momento. Cierre rápido, resultado al instante.
--
--  B) ASÍNCRONA tipo Doodle: el docente publica una encuesta con varias
--     opciones (ej. fechas para sustentación de proyecto) y los alumnos
--     eligen una en su propio tiempo. Cada opción puede tener cupo
--     (`max_responses`) para que no se llenen todas en la misma fecha.
--
-- Modelo:
--   - polls          : encabezado (título, tipo, ventana, sesión opcional)
--   - poll_options   : opciones del enunciado (label + cupo opcional)
--   - poll_responses : voto por usuario (single = una sola fila;
--                      multiple = N filas)
--
-- Tipo (`poll_type`):
--   - 'single'   : 1 opción por usuario, sin cupo. Caso A típico.
--   - 'multiple' : varias opciones por usuario. Encuesta de preferencias.
--   - 'slot'     : 1 opción por usuario CON cupo (max_responses). Caso B
--                  (fechas, horarios, lugares). RPC `vote_poll_option`
--                  hace el claim atómico (`UPDATE poll_options SET
--                  taken = taken + 1 WHERE id = X AND taken < max`).
--
-- Visibilidad de resultados (`results_visible_to_students`):
--   - 'always'      : el alumno ve los conteos al instante (encuesta
--                     pública estilo "show of hands").
--   - 'after_close' : solo después de `closes_at`.
--   - 'never'       : nunca; solo el docente.
--
-- Scope por tenant: heredado del `course_id` (RLS via courses.tenant_id).
-- No agregamos `tenant_id` directo porque el course ya lo trae y
-- `enforce_course_tenant` previene cross-tenant linkage.
-- ──────────────────────────────────────────────────────────────────────

-- ── poll_type enum ──────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.poll_type AS ENUM ('single', 'multiple', 'slot');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.poll_results_visibility AS ENUM ('always', 'after_close', 'never');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── polls ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.polls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  -- Opcional: si la encuesta nació durante una sesión presencial,
  -- queda atada para que aparezca destacada en la vista de esa clase.
  attendance_session_id UUID REFERENCES public.attendance_sessions(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT,
  poll_type public.poll_type NOT NULL DEFAULT 'single',
  results_visible_to_students public.poll_results_visibility NOT NULL DEFAULT 'after_close',
  opens_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closes_at TIMESTAMPTZ,
  -- `closed_manually` deja al docente cerrar antes de `closes_at` sin
  -- tener que editar la fecha. Si está true, está cerrada
  -- independientemente de `closes_at`.
  closed_manually BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_polls_course ON public.polls(course_id);
CREATE INDEX IF NOT EXISTS idx_polls_session ON public.polls(attendance_session_id);
CREATE INDEX IF NOT EXISTS idx_polls_opens_at ON public.polls(opens_at);

DROP TRIGGER IF EXISTS trg_polls_updated_at ON public.polls;
CREATE TRIGGER trg_polls_updated_at
  BEFORE UPDATE ON public.polls
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── poll_options ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.poll_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id UUID NOT NULL REFERENCES public.polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 300),
  -- Orden visual; el docente decide el orden al crear/editar.
  position INT NOT NULL DEFAULT 0,
  -- Cupo de respuestas para esta opción. Solo aplica a polls type='slot';
  -- en 'single'/'multiple' se ignora (NULL).
  max_responses INT CHECK (max_responses IS NULL OR max_responses > 0),
  -- Contador denormalizado para verificar capacidad sin contar filas en
  -- cada voto (race condition safe vía `vote_poll_option`).
  responses_count INT NOT NULL DEFAULT 0 CHECK (responses_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON public.poll_options(poll_id);

-- ── poll_responses ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.poll_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id UUID NOT NULL REFERENCES public.polls(id) ON DELETE CASCADE,
  option_id UUID NOT NULL REFERENCES public.poll_options(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- En polls 'single' y 'slot' un usuario solo puede tener UNA fila;
  -- esto lo enforza un partial unique index abajo (no constraint
  -- porque depende del tipo). En 'multiple' se permite (poll_id,
  -- user_id, option_id) único — un voto por (usuario, opción).
  UNIQUE (poll_id, user_id, option_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_responses_poll ON public.poll_responses(poll_id);
CREATE INDEX IF NOT EXISTS idx_poll_responses_user ON public.poll_responses(user_id);

-- Unique partial: solo UN voto por usuario para encuestas single/slot.
-- Se enforza via index parcial con check del tipo desde un trigger
-- (PostgreSQL no permite subqueries en CHECK ni en partial index).
CREATE OR REPLACE FUNCTION public._tg_poll_response_enforce_single()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_type public.poll_type;
  v_existing INT;
BEGIN
  SELECT poll_type INTO v_type FROM public.polls WHERE id = NEW.poll_id;
  IF v_type IN ('single', 'slot') THEN
    SELECT COUNT(*) INTO v_existing
    FROM public.poll_responses
    WHERE poll_id = NEW.poll_id
      AND user_id = NEW.user_id
      AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);
    IF v_existing > 0 THEN
      RAISE EXCEPTION 'Ya votaste en esta encuesta (tipo % permite un solo voto)', v_type
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_poll_response_enforce_single ON public.poll_responses;
CREATE TRIGGER trg_poll_response_enforce_single
  BEFORE INSERT OR UPDATE ON public.poll_responses
  FOR EACH ROW EXECUTE FUNCTION public._tg_poll_response_enforce_single();

-- ── responses_count: mantenerlo sync via trigger ────────────────────
CREATE OR REPLACE FUNCTION public._tg_poll_response_count_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.poll_options
       SET responses_count = responses_count + 1
     WHERE id = NEW.option_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.poll_options
       SET responses_count = GREATEST(responses_count - 1, 0)
     WHERE id = OLD.option_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_poll_response_count_sync ON public.poll_responses;
CREATE TRIGGER trg_poll_response_count_sync
  AFTER INSERT OR DELETE ON public.poll_responses
  FOR EACH ROW EXECUTE FUNCTION public._tg_poll_response_count_sync();

-- ── Helper: ¿la encuesta está abierta ahora? ────────────────────────
CREATE OR REPLACE FUNCTION public.poll_is_open(_poll public.polls)
RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE
AS $$
  SELECT NOT _poll.closed_manually
     AND _poll.opens_at <= now()
     AND (_poll.closes_at IS NULL OR _poll.closes_at > now());
$$;

-- ── RPC: vote_poll_option (atómico con check de cupo) ───────────────
-- Único path por donde un alumno emite un voto. Comprueba:
--   1. Encuesta abierta.
--   2. Usuario matriculado en el curso.
--   3. Si tipo='slot': cupo libre (UPDATE ... WHERE responses_count < max
--      retorna 0 filas si está lleno).
--   4. Si tipo IN ('single','slot'): no haya votado ya (lo enforza el
--      trigger; acá hacemos el INSERT y el trigger rechaza si dup).
-- Devuelve la fila insertada (id, poll_id, option_id) para confirmación
-- en el cliente.
CREATE OR REPLACE FUNCTION public.vote_poll_option(_option_id UUID)
RETURNS TABLE (response_id UUID, poll_id UUID, option_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_poll public.polls;
  v_option public.poll_options;
  v_uid UUID := auth.uid();
  v_enrolled BOOLEAN;
  v_response_id UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_option FROM public.poll_options WHERE id = _option_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Opción inexistente' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_poll FROM public.polls WHERE id = v_option.poll_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Encuesta inexistente' USING ERRCODE = '22023';
  END IF;
  IF NOT public.poll_is_open(v_poll) THEN
    RAISE EXCEPTION 'La encuesta está cerrada' USING ERRCODE = 'P0001';
  END IF;
  -- Matriculado en el curso.
  SELECT EXISTS (
    SELECT 1 FROM public.course_enrollments
     WHERE course_id = v_poll.course_id AND user_id = v_uid
  ) INTO v_enrolled;
  IF NOT v_enrolled THEN
    RAISE EXCEPTION 'No estás matriculado en este curso' USING ERRCODE = '42501';
  END IF;
  -- Para 'slot': claim de cupo antes del INSERT. UPDATE con WHERE
  -- responses_count < max es atómico — si llega lleno, no actualiza y
  -- caemos por NOT FOUND.
  IF v_poll.poll_type = 'slot' THEN
    IF v_option.max_responses IS NULL THEN
      RAISE EXCEPTION 'La opción no tiene cupo configurado' USING ERRCODE = '22023';
    END IF;
    -- NOTA: el responses_count se incrementa por el trigger DESPUÉS
    -- del INSERT, no acá. La verificación de cupo la hacemos contra
    -- el conteo CURRENT antes del INSERT — si dos usuarios entran a la
    -- vez, el trigger podría aceptarlos pasando el cupo. Para evitar
    -- la race usamos `FOR UPDATE` y comparamos antes:
    PERFORM 1 FROM public.poll_options
      WHERE id = _option_id AND responses_count < max_responses
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cupo agotado para esta opción' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  INSERT INTO public.poll_responses (poll_id, option_id, user_id)
       VALUES (v_poll.id, _option_id, v_uid)
    RETURNING id INTO v_response_id;
  RETURN QUERY SELECT v_response_id, v_poll.id, _option_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.vote_poll_option(UUID) TO authenticated;

-- ── RPC: clear_poll_response (cambiar voto) ─────────────────────────
-- Para polls 'single'/'slot' el alumno puede cambiar su voto si la
-- encuesta sigue abierta — borramos la fila vieja (trigger decrementa
-- responses_count) antes del nuevo INSERT que hará el cliente.
CREATE OR REPLACE FUNCTION public.clear_poll_response(_poll_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_poll public.polls;
  v_uid UUID := auth.uid();
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
  DELETE FROM public.poll_responses WHERE poll_id = _poll_id AND user_id = v_uid;
END;
$$;
GRANT EXECUTE ON FUNCTION public.clear_poll_response(UUID) TO authenticated;

-- ── RLS ────────────────────────────────────────────────────────────
ALTER TABLE public.polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poll_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poll_responses ENABLE ROW LEVEL SECURITY;

-- polls: SELECT abierto a authenticated que matchee el curso (docente
-- o estudiante matriculado); el filtro de tenant lo enforza
-- courses.tenant_id vía join, así que ni docentes ni alumnos de OTRO
-- tenant ven las encuestas.
DROP POLICY IF EXISTS polls_select_course_members ON public.polls;
CREATE POLICY polls_select_course_members
  ON public.polls FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.course_teachers
       WHERE course_id = polls.course_id AND user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.course_enrollments
       WHERE course_id = polls.course_id AND user_id = auth.uid()
    )
    OR public.has_role(auth.uid(), 'Admin')
    OR public.is_super_admin()
  );

-- polls: INSERT/UPDATE/DELETE solo docente del curso o Admin/SuperAdmin.
DROP POLICY IF EXISTS polls_write_course_teacher ON public.polls;
CREATE POLICY polls_write_course_teacher
  ON public.polls FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.course_teachers
       WHERE course_id = polls.course_id AND user_id = auth.uid()
    )
    OR public.has_role(auth.uid(), 'Admin')
    OR public.is_super_admin()
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.course_teachers
       WHERE course_id = polls.course_id AND user_id = auth.uid()
    )
    OR public.has_role(auth.uid(), 'Admin')
    OR public.is_super_admin()
  );

-- poll_options: visibilidad y escritura siguen al poll padre.
DROP POLICY IF EXISTS poll_options_select ON public.poll_options;
CREATE POLICY poll_options_select
  ON public.poll_options FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.polls p
      WHERE p.id = poll_options.poll_id
        AND (
          EXISTS (SELECT 1 FROM public.course_teachers WHERE course_id = p.course_id AND user_id = auth.uid())
          OR EXISTS (SELECT 1 FROM public.course_enrollments WHERE course_id = p.course_id AND user_id = auth.uid())
          OR public.has_role(auth.uid(), 'Admin')
          OR public.is_super_admin()
        )
    )
  );

DROP POLICY IF EXISTS poll_options_write_teacher ON public.poll_options;
CREATE POLICY poll_options_write_teacher
  ON public.poll_options FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.polls p
       WHERE p.id = poll_options.poll_id
         AND (
           EXISTS (SELECT 1 FROM public.course_teachers WHERE course_id = p.course_id AND user_id = auth.uid())
           OR public.has_role(auth.uid(), 'Admin')
           OR public.is_super_admin()
         )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.polls p
       WHERE p.id = poll_options.poll_id
         AND (
           EXISTS (SELECT 1 FROM public.course_teachers WHERE course_id = p.course_id AND user_id = auth.uid())
           OR public.has_role(auth.uid(), 'Admin')
           OR public.is_super_admin()
         )
    )
  );

-- poll_responses:
--   - El docente del curso ve TODAS las respuestas (necesita saber
--     quién votó qué — ej. fechas de sustentación elegidas por alumno).
--   - El estudiante ve SOLO sus propias respuestas Y, si la encuesta
--     tiene results_visible_to_students = 'always' o (= 'after_close'
--     y ya cerró), también ve los conteos vía poll_options.responses_count
--     (no necesita ver filas ajenas — solo el aggregate denormalizado).
DROP POLICY IF EXISTS poll_responses_select_own_or_teacher ON public.poll_responses;
CREATE POLICY poll_responses_select_own_or_teacher
  ON public.poll_responses FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.polls p
       WHERE p.id = poll_responses.poll_id
         AND (
           EXISTS (SELECT 1 FROM public.course_teachers WHERE course_id = p.course_id AND user_id = auth.uid())
           OR public.has_role(auth.uid(), 'Admin')
           OR public.is_super_admin()
         )
    )
  );

-- INSERT/DELETE de respuestas: SOLO vía RPCs vote_poll_option /
-- clear_poll_response (SECURITY DEFINER). Cerramos escritura directa.
DROP POLICY IF EXISTS poll_responses_no_direct_write ON public.poll_responses;
CREATE POLICY poll_responses_no_direct_write
  ON public.poll_responses FOR INSERT TO authenticated
  WITH CHECK (FALSE);

DROP POLICY IF EXISTS poll_responses_no_direct_delete ON public.poll_responses;
CREATE POLICY poll_responses_no_direct_delete
  ON public.poll_responses FOR DELETE TO authenticated
  USING (FALSE);

NOTIFY pgrst, 'reload schema';
