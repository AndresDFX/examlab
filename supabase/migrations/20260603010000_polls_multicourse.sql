-- ──────────────────────────────────────────────────────────────────────
-- Encuestas multi-curso
--
-- Una encuesta puede asociarse a N cursos en lugar de uno solo. Esto
-- es útil cuando el docente dicta el mismo material en varios cursos
-- y quiere lanzar UNA SOLA encuesta (ej. "Programación II A" y
-- "Programación II B") y consolidar resultados.
--
-- Modelo:
--   - polls.course_id          : se preserva como "curso ancla" para no
--                                romper queries existentes. Apunta al
--                                primer curso seleccionado.
--   - poll_courses (NUEVA)     : tabla puente con el set completo de
--                                cursos al que aplica la encuesta. Es
--                                el source of truth para RLS y RPCs.
--
-- Backfill:
--   - Cada poll existente recibe una fila en poll_courses con su
--     course_id actual. Después del backfill, poll_courses siempre
--     contiene polls.course_id (más cualquier curso adicional).
--
-- Reglas:
--   - SELECT: docente o estudiante matriculado en CUALQUIERA de los
--     cursos linkeados puede leer la encuesta y sus opciones.
--   - WRITE: solo el docente del curso ancla (polls.course_id) o
--     Admin/SA. Hacerlo "teacher de TODOS los cursos linkeados" sería
--     más estricto pero rompe el flujo de "docente crea, asigna a
--     cursos donde NO dicta" — por ahora dejamos al curso ancla como
--     fuente de autorización.
--   - VOTE: el alumno puede votar si está matriculado en CUALQUIERA
--     de los cursos linkeados. El RPC `vote_poll_option` se actualiza.
--   - AUTO-CLOSE: el trigger cuenta matriculados distintos sumando
--     TODOS los cursos linkeados. Cierra cuando los votantes únicos
--     llegan a ese total.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) Tabla puente ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.poll_courses (
  poll_id UUID NOT NULL REFERENCES public.polls(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, course_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_courses_poll ON public.poll_courses(poll_id);
CREATE INDEX IF NOT EXISTS idx_poll_courses_course ON public.poll_courses(course_id);

-- ── 2) Backfill: cada poll → su course_id en la tabla puente ──────
INSERT INTO public.poll_courses (poll_id, course_id)
SELECT id, course_id FROM public.polls
ON CONFLICT DO NOTHING;

-- ── 3) RLS poll_courses ───────────────────────────────────────────
ALTER TABLE public.poll_courses ENABLE ROW LEVEL SECURITY;

-- SELECT: docente o estudiante de cualquiera de los cursos linkeados
-- (necesario para el join en queries de polls). Admin/SA bypass.
DROP POLICY IF EXISTS poll_courses_select ON public.poll_courses;
CREATE POLICY poll_courses_select
  ON public.poll_courses FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.course_teachers ct
       WHERE ct.course_id = poll_courses.course_id AND ct.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.course_enrollments ce
       WHERE ce.course_id = poll_courses.course_id AND ce.user_id = auth.uid()
    )
    OR public.has_role(auth.uid(), 'Admin')
    OR public.is_super_admin()
  );

-- WRITE: solo docente del curso ancla del poll o Admin/SA. La idea es
-- que el creador de la encuesta (que ya pasó la WRITE policy de polls)
-- pueda agregar/quitar cursos linkeados sin restricciones extra.
DROP POLICY IF EXISTS poll_courses_write_teacher ON public.poll_courses;
CREATE POLICY poll_courses_write_teacher
  ON public.poll_courses FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.polls p
       JOIN public.course_teachers ct ON ct.course_id = p.course_id
       WHERE p.id = poll_courses.poll_id AND ct.user_id = auth.uid()
    )
    OR public.has_role(auth.uid(), 'Admin')
    OR public.is_super_admin()
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.polls p
       JOIN public.course_teachers ct ON ct.course_id = p.course_id
       WHERE p.id = poll_courses.poll_id AND ct.user_id = auth.uid()
    )
    OR public.has_role(auth.uid(), 'Admin')
    OR public.is_super_admin()
  );

-- ── 4) Actualizar SELECT policies de polls / options / responses ──
-- Para que un estudiante matriculado en un curso "extra" pueda
-- también ver la encuesta y sus opciones. Reemplazamos el predicado
-- "matriculado en polls.course_id" por "matriculado en algún
-- poll_courses".

DROP POLICY IF EXISTS polls_select_course_members ON public.polls;
CREATE POLICY polls_select_course_members
  ON public.polls FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.poll_courses pc
       JOIN public.course_teachers ct ON ct.course_id = pc.course_id
       WHERE pc.poll_id = polls.id AND ct.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.poll_courses pc
       JOIN public.course_enrollments ce ON ce.course_id = pc.course_id
       WHERE pc.poll_id = polls.id AND ce.user_id = auth.uid()
    )
    OR public.has_role(auth.uid(), 'Admin')
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS poll_options_select ON public.poll_options;
CREATE POLICY poll_options_select
  ON public.poll_options FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.polls p
       WHERE p.id = poll_options.poll_id
         AND (
           EXISTS (
             SELECT 1 FROM public.poll_courses pc
              JOIN public.course_teachers ct ON ct.course_id = pc.course_id
              WHERE pc.poll_id = p.id AND ct.user_id = auth.uid()
           )
           OR EXISTS (
             SELECT 1 FROM public.poll_courses pc
              JOIN public.course_enrollments ce ON ce.course_id = pc.course_id
              WHERE pc.poll_id = p.id AND ce.user_id = auth.uid()
           )
           OR public.has_role(auth.uid(), 'Admin')
           OR public.is_super_admin()
         )
    )
  );

DROP POLICY IF EXISTS poll_responses_select_own_or_teacher ON public.poll_responses;
CREATE POLICY poll_responses_select_own_or_teacher
  ON public.poll_responses FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.polls p
       WHERE p.id = poll_responses.poll_id
         AND (
           EXISTS (
             SELECT 1 FROM public.poll_courses pc
              JOIN public.course_teachers ct ON ct.course_id = pc.course_id
              WHERE pc.poll_id = p.id AND ct.user_id = auth.uid()
           )
           OR public.has_role(auth.uid(), 'Admin')
           OR public.is_super_admin()
         )
    )
  );

-- ── 5) vote_poll_option: enrollment check usa poll_courses ────────
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
  -- Matriculado en CUALQUIERA de los cursos linkeados.
  SELECT EXISTS (
    SELECT 1
      FROM public.poll_courses pc
      JOIN public.course_enrollments ce ON ce.course_id = pc.course_id
     WHERE pc.poll_id = v_poll.id AND ce.user_id = v_uid
  ) INTO v_enrolled;
  IF NOT v_enrolled THEN
    RAISE EXCEPTION 'No estás matriculado en ningún curso de esta encuesta'
      USING ERRCODE = '42501';
  END IF;
  IF v_poll.poll_type = 'slot' THEN
    IF v_option.max_responses IS NULL THEN
      RAISE EXCEPTION 'La opción no tiene cupo configurado' USING ERRCODE = '22023';
    END IF;
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

-- ── 6) Trigger auto-close: matriculados across linked courses ─────
CREATE OR REPLACE FUNCTION public._tg_poll_autoclose_when_all_responded()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_poll public.polls;
  v_voters INT;
  v_enrolled INT;
BEGIN
  SELECT * INTO v_poll FROM public.polls WHERE id = NEW.poll_id;
  IF NOT FOUND OR NOT v_poll.auto_close_when_all_responded OR v_poll.closed_manually THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(DISTINCT user_id) INTO v_voters
    FROM public.poll_responses
   WHERE poll_id = NEW.poll_id;

  -- Suma de matriculados ÚNICOS a través de TODOS los cursos linkeados.
  -- DISTINCT user_id evita doble conteo si un alumno está en dos
  -- cursos del mismo set.
  SELECT COUNT(DISTINCT ce.user_id) INTO v_enrolled
    FROM public.poll_courses pc
    JOIN public.course_enrollments ce ON ce.course_id = pc.course_id
   WHERE pc.poll_id = NEW.poll_id;

  IF v_enrolled > 0 AND v_voters >= v_enrolled THEN
    UPDATE public.polls
       SET closed_manually = TRUE,
           updated_at = now()
     WHERE id = NEW.poll_id
       AND NOT closed_manually;
  END IF;

  RETURN NULL;
END;
$$;

-- ── 7) Note de compat ─────────────────────────────────────────────
COMMENT ON COLUMN public.polls.course_id IS
  'Curso ancla (legacy). El conjunto completo de cursos al que aplica la encuesta vive en public.poll_courses (junction). RLS, votación y auto-cierre consultan la junction. La columna se preserva para no romper queries históricas y como autorización de WRITE en polls.';

NOTIFY pgrst, 'reload schema';
