-- ──────────────────────────────────────────────────────────────────────
-- Clonado PARAMETRIZABLE de examen / taller / proyecto.
--
-- Antes los RPCs clone_* copiaban SIEMPRE la fila + sus hijos (preguntas /
-- archivos). Ahora el docente elige desde el dialog QUÉ información interna
-- copiar. Flags por tipo:
--   exam:     _copy_questions   (preguntas),  _copy_proctoring (navegación,
--                                              mezcla, máx. advertencias)
--   workshop: _copy_questions   (preguntas),  _copy_groups     (modo grupo)
--   project:  _copy_files       (archivos esperados/slots),
--                                _copy_groups (modo grupo)
--
-- Cuando un flag es FALSE, la copia usa defaults SEGUROS en vez de copiar
-- esa info del origen:
--   proctoring → navigation_type='libre', shuffle_enabled=false, max_warnings=3
--   groups     → group_mode='individual', tamaños NULL
--   questions/files → no se insertan (la copia nace sin contenido hijo)
--
-- NO clona (igual que antes): asignaciones, submissions, calificaciones,
-- grupos+miembros, eventos de calendario. Status del clon: 'draft' SIEMPRE.
--
-- Las firmas viejas (5 args) se DROPEAN para evitar overloads ambiguos en
-- PostgREST (dos candidatos que aceptan los mismos named-args → error
-- "could not choose best candidate function"). El front pasa los flags
-- explícitos; los DEFAULTs preservan compat con cualquier caller suelto.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) clone_exam ──
DROP FUNCTION IF EXISTS public.clone_exam(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION public.clone_exam(
  _source_id        UUID,
  _target_course_id UUID,
  _new_title        TEXT DEFAULT NULL,
  _new_start_time   TIMESTAMPTZ DEFAULT NULL,
  _new_end_time     TIMESTAMPTZ DEFAULT NULL,
  _copy_questions   BOOLEAN DEFAULT true,
  _copy_proctoring  BOOLEAN DEFAULT true
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _new_id UUID;
  _final_title TEXT;
  _final_start TIMESTAMPTZ;
  _final_end TIMESTAMPTZ;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'Admin')
    OR (
      EXISTS (
        SELECT 1 FROM public.exams e
        JOIN public.course_teachers ct ON ct.course_id = e.course_id
        WHERE e.id = _source_id AND ct.user_id = auth.uid()
      )
      AND EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = _target_course_id AND ct.user_id = auth.uid()
      )
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para clonar este examen al curso destino';
  END IF;

  SELECT
    COALESCE(_new_title, 'Copia de ' || e.title),
    COALESCE(_new_start_time, e.start_time),
    COALESCE(_new_end_time, e.end_time)
    INTO _final_title, _final_start, _final_end
    FROM public.exams e WHERE e.id = _source_id;

  INSERT INTO public.exams (
    course_id, created_by, title, description, time_limit_minutes, navigation_type,
    shuffle_enabled, start_time, end_time, status, max_warnings,
    weight, max_attempts, retry_mode, is_external, schedule_type,
    cut_id
  )
  SELECT
    _target_course_id, auth.uid(), _final_title, e.description, e.time_limit_minutes,
    CASE WHEN _copy_proctoring THEN e.navigation_type ELSE 'libre' END,
    CASE WHEN _copy_proctoring THEN e.shuffle_enabled ELSE false END,
    _final_start, _final_end, 'draft',
    CASE WHEN _copy_proctoring THEN e.max_warnings ELSE 3 END,
    e.weight, e.max_attempts, e.retry_mode, e.is_external, e.schedule_type,
    CASE WHEN _target_course_id = e.course_id THEN e.cut_id ELSE NULL END
  FROM public.exams e WHERE e.id = _source_id
  RETURNING id INTO _new_id;

  IF _copy_questions THEN
    INSERT INTO public.questions (
      exam_id, type, content, options, expected_rubric, language, starter_code,
      points, position
    )
    SELECT
      _new_id, q.type, q.content, q.options, q.expected_rubric, q.language, q.starter_code,
      q.points, q.position
    FROM public.questions q
    WHERE q.exam_id = _source_id;
  END IF;

  RETURN _new_id;
END
$$;

REVOKE ALL ON FUNCTION public.clone_exam(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clone_exam(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, BOOLEAN) TO authenticated;

-- ── 2) clone_workshop ──
DROP FUNCTION IF EXISTS public.clone_workshop(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION public.clone_workshop(
  _source_id        UUID,
  _target_course_id UUID,
  _new_title        TEXT DEFAULT NULL,
  _new_start_date   TIMESTAMPTZ DEFAULT NULL,
  _new_due_date     TIMESTAMPTZ DEFAULT NULL,
  _copy_questions   BOOLEAN DEFAULT true,
  _copy_groups      BOOLEAN DEFAULT true
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _new_id UUID;
  _final_title TEXT;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'Admin')
    OR (
      EXISTS (
        SELECT 1 FROM public.workshops w
        JOIN public.course_teachers ct ON ct.course_id = w.course_id
        WHERE w.id = _source_id AND ct.user_id = auth.uid()
      )
      AND EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = _target_course_id AND ct.user_id = auth.uid()
      )
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para clonar este taller al curso destino';
  END IF;

  SELECT COALESCE(_new_title, 'Copia de ' || w.title)
    INTO _final_title
    FROM public.workshops w WHERE w.id = _source_id;

  INSERT INTO public.workshops (
    course_id, title, description, instructions, start_date, due_date,
    status, weight, is_external, group_mode, group_size_min, group_size_max,
    max_score, cut_id
  )
  SELECT
    _target_course_id, _final_title, w.description, w.instructions,
    COALESCE(_new_start_date, w.start_date),
    COALESCE(_new_due_date, w.due_date),
    'draft', w.weight, w.is_external,
    CASE WHEN _copy_groups THEN w.group_mode ELSE 'individual' END,
    CASE WHEN _copy_groups THEN w.group_size_min ELSE NULL END,
    CASE WHEN _copy_groups THEN w.group_size_max ELSE NULL END,
    w.max_score,
    CASE WHEN _target_course_id = w.course_id THEN w.cut_id ELSE NULL END
  FROM public.workshops w WHERE w.id = _source_id
  RETURNING id INTO _new_id;

  IF _copy_questions THEN
    INSERT INTO public.workshop_questions (
      workshop_id, type, content, options, expected_rubric, language, starter_code,
      points, position
    )
    SELECT
      _new_id, q.type, q.content, q.options, q.expected_rubric, q.language, q.starter_code,
      q.points, q.position
    FROM public.workshop_questions q
    WHERE q.workshop_id = _source_id;
  END IF;

  RETURN _new_id;
END
$$;

REVOKE ALL ON FUNCTION public.clone_workshop(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clone_workshop(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, BOOLEAN) TO authenticated;

-- ── 3) clone_project ──
DROP FUNCTION IF EXISTS public.clone_project(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION public.clone_project(
  _source_id        UUID,
  _target_course_id UUID,
  _new_title        TEXT DEFAULT NULL,
  _new_start_date   TIMESTAMPTZ DEFAULT NULL,
  _new_due_date     TIMESTAMPTZ DEFAULT NULL,
  _copy_files       BOOLEAN DEFAULT true,
  _copy_groups      BOOLEAN DEFAULT true
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _new_id UUID;
  _final_title TEXT;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'Admin')
    OR (
      EXISTS (
        SELECT 1 FROM public.projects p
        JOIN public.course_teachers ct ON ct.course_id = p.course_id
        WHERE p.id = _source_id AND ct.user_id = auth.uid()
      )
      AND EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = _target_course_id AND ct.user_id = auth.uid()
      )
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para clonar este proyecto al curso destino';
  END IF;

  SELECT COALESCE(_new_title, 'Copia de ' || p.title)
    INTO _final_title
    FROM public.projects p WHERE p.id = _source_id;

  INSERT INTO public.projects (
    course_id, title, description, instructions, external_link,
    start_date, due_date, status, max_score, weight, is_external,
    group_mode, group_size_min, group_size_max
  )
  SELECT
    _target_course_id, _final_title, p.description, p.instructions, p.external_link,
    COALESCE(_new_start_date, p.start_date),
    COALESCE(_new_due_date, p.due_date),
    'draft', p.max_score, p.weight, p.is_external,
    CASE WHEN _copy_groups THEN p.group_mode ELSE 'individual' END,
    CASE WHEN _copy_groups THEN p.group_size_min ELSE NULL END,
    CASE WHEN _copy_groups THEN p.group_size_max ELSE NULL END
  FROM public.projects p WHERE p.id = _source_id
  RETURNING id INTO _new_id;

  IF _copy_files THEN
    INSERT INTO public.project_files (
      project_id, type, title, description, expected_rubric, language,
      starter_code, points, position, options
    )
    SELECT
      _new_id, f.type, f.title, f.description, f.expected_rubric, f.language,
      f.starter_code, f.points, f.position, f.options
    FROM public.project_files f
    WHERE f.project_id = _source_id;
  END IF;

  RETURN _new_id;
END
$$;

REVOKE ALL ON FUNCTION public.clone_project(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clone_project(UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, BOOLEAN) TO authenticated;

NOTIFY pgrst, 'reload schema';
