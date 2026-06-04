-- ──────────────────────────────────────────────────────────────────────
-- Estandarización de estados draft / published
--
-- Objetivo: que el docente pueda crear CUALQUIER cosa (taller, examen,
-- proyecto, encuesta, contenido) como borrador y publicarla cuando esté
-- lista. El alumno nunca ve borradores.
--
-- Estado previo:
--   - workshops, projects: tenían `status text` con default 'draft'.
--     OK ya. UI ya lo respeta.
--   - exams: tenía `status text` con default 'published'. INCORRECTO —
--     el docente que crea un examen lo expone inmediatamente al alumno
--     antes de terminar de configurarlo. Cambiamos default a 'draft'
--     (filas existentes NO se tocan, así no rompemos exámenes ya
--     activos).
--   - polls: NO tenía concepto de borrador. Solo `closed_manually` y
--     ventana opens_at/closes_at. Si el docente crea una encuesta a
--     futuro pero quiere ajustar opciones antes, el alumno ya la vería
--     cuando llegue opens_at. Agregamos `is_published BOOLEAN DEFAULT
--     FALSE` y la RLS de alumnos se restringe a publicadas.
--     Backfill: encuestas existentes → is_published = true (paridad con
--     el comportamiento previo donde todo era visible).
--   - generated_contents: tenía `status content_status` enum (queued/
--     processing/done/failed) pero ese es el lifecycle de GENERACIÓN,
--     no de publicación. Agregamos `is_published BOOLEAN DEFAULT FALSE`
--     ortogonal. Backfill: contenidos con status='done' → published
--     true (paridad).
--
-- Convención uniforme:
--   - workshops.status / exams.status / projects.status: 'draft' antes
--     de publicar, 'published' al publicar, 'closed' al cerrar manual.
--   - polls.is_published: boolean (no enum porque polls no se "cierran"
--     en el mismo sentido — tienen `closed_manually` separado).
--   - generated_contents.is_published: boolean. El status del proceso
--     (queued/processing/done/failed) sigue siendo ortogonal.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) exams: cambiar default a 'draft' ──────────────────────────
ALTER TABLE public.exams
  ALTER COLUMN status SET DEFAULT 'draft';

COMMENT ON COLUMN public.exams.status IS
  'Estado del examen. ''draft'' = oculto para alumnos (default al crear). ''published'' = visible y abierto si está dentro de start_time/end_time. ''closed'' = cerrado manualmente por el docente.';

-- ── 2) polls: is_published BOOLEAN ───────────────────────────────
ALTER TABLE public.polls
  ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.polls.is_published IS
  'Si false, la encuesta es un borrador — solo el docente del curso (o Admin/SA) la ve. El alumno no la lista ni puede votar. Default false: el docente debe publicar explícitamente. RLS de alumnos filtra por is_published=true.';

-- Backfill: polls ya creados se consideran publicados (paridad
-- comportamental — antes todas eran visibles).
UPDATE public.polls SET is_published = TRUE WHERE is_published = FALSE;

-- RLS: el SELECT de alumnos solo trae publicadas. Docentes/Admin/SA
-- siguen viendo todo (drafts + publicadas) — pueden gestionar borradores.
DROP POLICY IF EXISTS polls_select_course_members ON public.polls;
CREATE POLICY polls_select_course_members
  ON public.polls FOR SELECT TO authenticated
  USING (
    -- Docente del curso ancla o de cualquier curso linkeado en junction.
    EXISTS (
      SELECT 1 FROM public.poll_courses pc
       JOIN public.course_teachers ct ON ct.course_id = pc.course_id
       WHERE pc.poll_id = polls.id AND ct.user_id = auth.uid()
    )
    -- Alumno: matriculado en algún curso linkeado Y la encuesta está
    -- publicada (los borradores quedan ocultos para el estudiantado).
    OR (
      is_published = TRUE
      AND EXISTS (
        SELECT 1 FROM public.poll_courses pc
         JOIN public.course_enrollments ce ON ce.course_id = pc.course_id
         WHERE pc.poll_id = polls.id AND ce.user_id = auth.uid()
      )
    )
    OR public.has_role(auth.uid(), 'Admin')
    OR public.is_super_admin()
  );

-- Importante: vote_poll_option ya validaba que la encuesta esté
-- "open" via `poll_is_open(v_poll)`. Agregamos check de publicación
-- para evitar que un estudiante con el ID del poll en mano pueda
-- intentar votar en un borrador (caso de ataque dirigido).
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
  IF NOT v_poll.is_published THEN
    RAISE EXCEPTION 'Esta encuesta todavía es un borrador' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.poll_is_open(v_poll) THEN
    RAISE EXCEPTION 'La encuesta está cerrada' USING ERRCODE = 'P0001';
  END IF;
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

-- ── 3) generated_contents: is_published BOOLEAN ──────────────────
ALTER TABLE public.generated_contents
  ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.generated_contents.is_published IS
  'Si false, el contenido es borrador del docente — visible solo para él/Admin/SA. Default false: tras generarse (status=''done'') queda en borrador hasta que el docente publique. Es ortogonal al status (que cubre el lifecycle de generación queued/processing/done/failed).';

-- Backfill: contenidos con status='done' se consideran publicados
-- (paridad — antes no había control de publicación, el docente que
-- generaba y dejaba en done era equivalente a publicado).
UPDATE public.generated_contents
   SET is_published = TRUE
 WHERE is_published = FALSE AND status = 'done';

-- Nota: la RLS de generated_contents la mantiene el docente que creó
-- (teacher_id) — no hay vista de "alumno ve content" directa. Los
-- alumnos acceden a contents vía referencias en attendance_sessions /
-- exam.source_content_id / etc. El flag is_published se usará en la
-- UI del docente (badge + filtro) y como gate suave en los lugares
-- donde un contenido se "expone" al alumno (próxima iteración).

NOTIFY pgrst, 'reload schema';
