-- ============================================================================
-- Tenant scoping round 3b — cierre de ramas Admin SIN scope de tenant en RPCs
-- SECURITY DEFINER y en las policies de question_bank (anti-patrón documentado
-- en CLAUDE.md: `has_role('Admin')` global deja a un Admin de CUALQUIER tenant
-- operar/leer datos de otro). Detectado por las auditorías Exámenes + Talleres.
--
-- Cambios (la rama Admin pasa a `is_admin_of_course_tenant(<course>)`, que ya
-- incluye SuperAdmin):
--   - question_bank (SELECT + write FOR ALL): leak de lectura/escritura del
--     banco de preguntas cross-tenant.
--   - clone_exam / clone_workshop / clone_project: un Admin de otro tenant podía
--     CLONAR (y por ende LEER) contenido de un examen/taller/proyecto ajeno a
--     un curso propio -> exfiltración de contenido cross-tenant. Ahora exige ser
--     admin del tenant del ORIGEN **y** del DESTINO.
--   - add_questions_from_bank_to_{exam,workshop,project}: idem para importar
--     preguntas del banco (authz del destino + filtro del banco origen).
--   - requeue_ai_grading_job / cancel_ai_grading_job: un Admin de otro tenant
--     podía re-encolar/cancelar jobs de grading ajenos.
--
-- Las firmas y cuerpos se extrajeron textualmente de las migraciones fuente y
-- solo se reemplazó la condición de autorización; el resto es idéntico.
-- ============================================================================

-- ── question_bank: policies scopeadas al tenant del curso ──
DO $$
BEGIN
  IF to_regclass('public.question_bank') IS NULL THEN
    RAISE NOTICE 'question_bank no existe; skip policies';
    RETURN;
  END IF;

  EXECUTE 'DROP POLICY IF EXISTS "question_bank_select" ON public.question_bank';
  EXECUTE 'DROP POLICY IF EXISTS "question_bank_write" ON public.question_bank';

  EXECUTE $POLICY$
    CREATE POLICY "question_bank_select"
      ON public.question_bank FOR SELECT TO authenticated
      USING (
        public.is_admin_of_course_tenant(question_bank.course_id)
        OR EXISTS (
          SELECT 1 FROM public.course_teachers ct
          WHERE ct.course_id = question_bank.course_id AND ct.user_id = auth.uid()
        )
      )
  $POLICY$;

  EXECUTE $POLICY$
    CREATE POLICY "question_bank_write"
      ON public.question_bank FOR ALL TO authenticated
      USING (
        public.is_admin_of_course_tenant(question_bank.course_id)
        OR EXISTS (
          SELECT 1 FROM public.course_teachers ct
          WHERE ct.course_id = question_bank.course_id AND ct.user_id = auth.uid()
        )
      )
      WITH CHECK (
        public.is_admin_of_course_tenant(question_bank.course_id)
        OR EXISTS (
          SELECT 1 FROM public.course_teachers ct
          WHERE ct.course_id = question_bank.course_id AND ct.user_id = auth.uid()
        )
      )
  $POLICY$;
END $$;

CREATE OR REPLACE FUNCTION public.requeue_ai_grading_job(_job_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _job RECORD;
  _caller UUID := auth.uid();
  _authorized BOOLEAN := false;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT id, status, course_id, created_by, target_table, target_row_id, kind
    INTO _job
    FROM public.ai_grading_queue
   WHERE id = _job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job no encontrado';
  END IF;

  IF public.is_super_admin()
     OR (_job.course_id IS NOT NULL AND public.is_admin_of_course_tenant(_job.course_id)) THEN
    _authorized := true;
  ELSIF _job.created_by = _caller THEN
    _authorized := true;
  ELSIF _job.course_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.course_teachers ct
    WHERE ct.course_id = _job.course_id AND ct.user_id = _caller
  ) THEN
    _authorized := true;
  END IF;

  IF NOT _authorized THEN
    RAISE EXCEPTION 'No tienes permiso para re-encolar este job';
  END IF;

  IF _job.status NOT IN ('failed', 'cancelled') THEN
    RAISE EXCEPTION 'Solo se pueden re-encolar jobs en estado failed o cancelled (estado actual: %)', _job.status;
  END IF;

  -- No re-encolar si ya hay OTRO job activo para la misma entrega+tipo
  -- (el índice único parcial lo rechazaría con un error críptico).
  IF EXISTS (
    SELECT 1 FROM public.ai_grading_queue q2
     WHERE q2.id <> _job_id
       AND q2.target_table = _job.target_table
       AND q2.target_row_id = _job.target_row_id
       AND q2.kind = _job.kind
       AND q2.status IN ('pending', 'processing')
  ) THEN
    RAISE EXCEPTION 'Ya hay un job activo para esta entrega; espera a que termine en vez de re-encolar.'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.ai_grading_queue
     SET status = 'pending',
         attempts = 0,
         last_error = NULL,
         started_at = NULL,
         completed_at = NULL
   WHERE id = _job_id;
END
$$;

REVOKE ALL ON FUNCTION public.requeue_ai_grading_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.requeue_ai_grading_job(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_ai_grading_job(_job_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _job RECORD;
  _caller UUID := auth.uid();
  _authorized BOOLEAN := false;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT id, status, course_id, created_by
    INTO _job
    FROM public.ai_grading_queue
   WHERE id = _job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job no encontrado';
  END IF;

  IF public.is_super_admin()
     OR (_job.course_id IS NOT NULL AND public.is_admin_of_course_tenant(_job.course_id)) THEN
    _authorized := true;
  ELSIF _job.created_by = _caller THEN
    _authorized := true;
  ELSIF _job.course_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.course_teachers ct
    WHERE ct.course_id = _job.course_id AND ct.user_id = _caller
  ) THEN
    _authorized := true;
  END IF;

  IF NOT _authorized THEN
    RAISE EXCEPTION 'No tienes permiso para cancelar este job';
  END IF;

  IF _job.status NOT IN ('pending', 'failed', 'processing') THEN
    RAISE EXCEPTION 'Solo se pueden cancelar jobs en estado pending, failed o processing (estado actual: %)', _job.status;
  END IF;

  UPDATE public.ai_grading_queue
     SET status = 'cancelled',
         completed_at = COALESCE(completed_at, now())
   WHERE id = _job_id;
END
$$;

REVOKE ALL ON FUNCTION public.cancel_ai_grading_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_ai_grading_job(UUID) TO authenticated;

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
    (
      public.is_admin_of_course_tenant((SELECT e.course_id FROM public.exams e WHERE e.id = _source_id))
      AND public.is_admin_of_course_tenant(_target_course_id)
    )
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
    (
      public.is_admin_of_course_tenant((SELECT w.course_id FROM public.workshops w WHERE w.id = _source_id))
      AND public.is_admin_of_course_tenant(_target_course_id)
    )
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
    (
      public.is_admin_of_course_tenant((SELECT p.course_id FROM public.projects p WHERE p.id = _source_id))
      AND public.is_admin_of_course_tenant(_target_course_id)
    )
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

CREATE OR REPLACE FUNCTION public.add_questions_from_bank_to_exam(
  _bank_ids UUID[],
  _exam_id UUID,
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
  _custom_points NUMERIC;
BEGIN
  -- Validación: el usuario debe ser docente del curso del examen o admin.
  IF NOT (
    public.is_admin_of_course_tenant((SELECT e2.course_id FROM public.exams e2 WHERE e2.id = _exam_id)) OR EXISTS (
      SELECT 1 FROM public.exams e
      JOIN public.course_teachers ct ON ct.course_id = e.course_id
      WHERE e.id = _exam_id AND ct.user_id = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para modificar este examen';
  END IF;

  SELECT COALESCE(MAX(position), -1) INTO _max_pos
    FROM public.questions WHERE exam_id = _exam_id;

  FOR _bank IN
    SELECT b.* FROM public.question_bank b
    WHERE b.id = ANY(_bank_ids)
    -- Tipo codigo_zip no aplica a examen (es solo para proyectos).
    AND b.type <> 'codigo_zip'
    -- El usuario también debe ver el banco (RLS lo refuerza).
    AND (
      public.is_admin_of_course_tenant(b.course_id) OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = b.course_id AND ct.user_id = auth.uid()
      )
    )
  LOOP
    _custom_points := COALESCE(
      (_points_override->>(_bank.id::text))::numeric,
      _bank.suggested_points
    );
    _max_pos := _max_pos + 1;

    INSERT INTO public.questions (
      exam_id, type, content, options, expected_rubric,
      language, starter_code, points, position
    ) VALUES (
      _exam_id, _bank.type, _bank.content, _bank.options, _bank.expected_rubric,
      _bank.language, _bank.starter_code, _custom_points, _max_pos
    );

    -- Trackear uso
    UPDATE public.question_bank
      SET times_used = times_used + 1, last_used_at = now()
      WHERE id = _bank.id;
    _inserted := _inserted + 1;
  END LOOP;

  RETURN _inserted;
END
$$;

REVOKE ALL ON FUNCTION public.add_questions_from_bank_to_exam(UUID[], UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_questions_from_bank_to_exam(UUID[], UUID, JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.add_questions_from_bank_to_workshop(
  _bank_ids UUID[],
  _workshop_id UUID,
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
  _custom_points NUMERIC;
BEGIN
  IF NOT (
    public.is_admin_of_course_tenant((SELECT w2.course_id FROM public.workshops w2 WHERE w2.id = _workshop_id)) OR EXISTS (
      SELECT 1 FROM public.workshops w
      JOIN public.course_teachers ct ON ct.course_id = w.course_id
      WHERE w.id = _workshop_id AND ct.user_id = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para modificar este taller';
  END IF;

  SELECT COALESCE(MAX(position), -1) INTO _max_pos
    FROM public.workshop_questions WHERE workshop_id = _workshop_id;

  FOR _bank IN
    SELECT b.* FROM public.question_bank b
    WHERE b.id = ANY(_bank_ids)
    AND b.type <> 'codigo_zip'  -- No aplica a workshop tampoco
    AND (
      public.is_admin_of_course_tenant(b.course_id) OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = b.course_id AND ct.user_id = auth.uid()
      )
    )
  LOOP
    _custom_points := COALESCE(
      (_points_override->>(_bank.id::text))::numeric,
      _bank.suggested_points
    );
    _max_pos := _max_pos + 1;

    INSERT INTO public.workshop_questions (
      workshop_id, type, content, options, expected_rubric,
      language, starter_code, points, position
    ) VALUES (
      _workshop_id, _bank.type, _bank.content, _bank.options, _bank.expected_rubric,
      _bank.language, _bank.starter_code, _custom_points, _max_pos
    );

    UPDATE public.question_bank
      SET times_used = times_used + 1, last_used_at = now()
      WHERE id = _bank.id;
    _inserted := _inserted + 1;
  END LOOP;

  RETURN _inserted;
END
$$;

REVOKE ALL ON FUNCTION public.add_questions_from_bank_to_workshop(UUID[], UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_questions_from_bank_to_workshop(UUID[], UUID, JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.add_questions_from_bank_to_project(
  _bank_ids UUID[],
  _project_id UUID,
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
  _custom_points NUMERIC;
BEGIN
  IF NOT (
    public.is_admin_of_course_tenant((SELECT p2.course_id FROM public.projects p2 WHERE p2.id = _project_id)) OR EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.course_teachers ct ON ct.course_id = p.course_id
      WHERE p.id = _project_id AND ct.user_id = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para modificar este proyecto';
  END IF;

  SELECT COALESCE(MAX(position), -1) INTO _max_pos
    FROM public.project_files WHERE project_id = _project_id;

  FOR _bank IN
    SELECT b.* FROM public.question_bank b
    WHERE b.id = ANY(_bank_ids)
    -- Proyecto SÍ acepta codigo_zip además del resto
    AND (
      public.is_admin_of_course_tenant(b.course_id) OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = b.course_id AND ct.user_id = auth.uid()
      )
    )
  LOOP
    _custom_points := COALESCE(
      (_points_override->>(_bank.id::text))::numeric,
      _bank.suggested_points
    );
    _max_pos := _max_pos + 1;

    INSERT INTO public.project_files (
      project_id, type, title, options, expected_rubric,
      language, starter_code, points, position
    ) VALUES (
      _project_id, _bank.type, _bank.content, _bank.options, _bank.expected_rubric,
      _bank.language, _bank.starter_code, _custom_points, _max_pos
    );

    UPDATE public.question_bank
      SET times_used = times_used + 1, last_used_at = now()
      WHERE id = _bank.id;
    _inserted := _inserted + 1;
  END LOOP;

  RETURN _inserted;
END
$$;

REVOKE ALL ON FUNCTION public.add_questions_from_bank_to_project(UUID[], UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_questions_from_bank_to_project(UUID[], UUID, JSONB) TO authenticated;
