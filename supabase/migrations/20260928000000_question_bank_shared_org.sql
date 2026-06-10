-- ──────────────────────────────────────────────────────────────────────
-- Banco de preguntas: compartir con TODA LA ORGANIZACIÓN (tenant)
--
-- Hasta ahora una pregunta del banco solo la veían los docentes del MISMO
-- curso (course_teachers) + Admin. Ahora un Docente puede marcar una
-- pregunta como `shared_org=true` para que CUALQUIER docente del mismo
-- tenant la pueda VER e IMPORTAR (a sus exámenes/talleres/proyectos/Kahoot),
-- sin poder editarla (la edición/borrado sigue siendo solo del dueño =
-- docente del curso, o Admin).
--
-- Modelo (estándar, confirmado): compartir = lectura/importación a nivel
-- tenant; editar = solo el dueño. El tenant se deriva del curso de la
-- pregunta (question_bank no tiene tenant_id propio; courses.tenant_id manda).
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.question_bank') IS NOT NULL THEN
    ALTER TABLE public.question_bank
      ADD COLUMN IF NOT EXISTS shared_org BOOLEAN NOT NULL DEFAULT false;

    -- SELECT: Admin, o docente del curso, o (compartida con la org Y del
    -- mismo tenant que el lector). El tenant del lector = current_tenant_id();
    -- el de la pregunta = courses.tenant_id de su course_id.
    DROP POLICY IF EXISTS "question_bank_select" ON public.question_bank;
    CREATE POLICY "question_bank_select"
      ON public.question_bank FOR SELECT TO authenticated
      USING (
        public.has_role(auth.uid(), 'Admin')
        OR EXISTS (
          SELECT 1 FROM public.course_teachers ct
          WHERE ct.course_id = question_bank.course_id
            AND ct.user_id = auth.uid()
        )
        OR (
          question_bank.shared_org = true
          AND EXISTS (
            SELECT 1 FROM public.courses c
            WHERE c.id = question_bank.course_id
              AND c.tenant_id = public.current_tenant_id()
          )
        )
      );

    -- WRITE (INSERT/UPDATE/DELETE) NO se toca: sigue siendo Admin o docente
    -- del curso. Así un docente solo puede marcar/desmarcar shared_org en SUS
    -- propias preguntas, y nadie ajeno puede editar una compartida.

    CREATE INDEX IF NOT EXISTS idx_question_bank_shared_org
      ON public.question_bank(shared_org) WHERE shared_org = true;
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- Importar preguntas compartidas con la org: extender el guard INTERNO de
-- las 4 RPCs de importación. Eran SECURITY DEFINER y filtraban el banco a
-- "Admin o docente del curso de la pregunta" — eso saltaba SILENCIOSAMENTE
-- las preguntas de OTRO curso aunque estuvieran compartidas con la org. Se
-- agrega la rama `shared_org = true AND mismo tenant` (idéntica a la RLS
-- SELECT de arriba). El guard EXTERNO (autorización sobre el examen/taller/
-- proyecto/Kahoot destino) NO cambia: sigues necesitando ser docente del
-- destino. CREATE OR REPLACE (misma firma) — sin DROP.
-- ──────────────────────────────────────────────────────────────────────

-- 1) Banco → exam
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
  IF NOT (
    public.has_role(auth.uid(), 'Admin') OR EXISTS (
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
    AND b.type <> 'codigo_zip'
    AND (
      public.has_role(auth.uid(), 'Admin') OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = b.course_id AND ct.user_id = auth.uid()
      )
      OR (
        b.shared_org = true AND EXISTS (
          SELECT 1 FROM public.courses c
          WHERE c.id = b.course_id AND c.tenant_id = public.current_tenant_id()
        )
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

    UPDATE public.question_bank
      SET times_used = times_used + 1, last_used_at = now()
      WHERE id = _bank.id;
    _inserted := _inserted + 1;
  END LOOP;

  RETURN _inserted;
END
$$;

-- 2) Banco → workshop
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
    public.has_role(auth.uid(), 'Admin') OR EXISTS (
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
    AND b.type <> 'codigo_zip'
    AND (
      public.has_role(auth.uid(), 'Admin') OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = b.course_id AND ct.user_id = auth.uid()
      )
      OR (
        b.shared_org = true AND EXISTS (
          SELECT 1 FROM public.courses c
          WHERE c.id = b.course_id AND c.tenant_id = public.current_tenant_id()
        )
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

-- 3) Banco → project
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
    public.has_role(auth.uid(), 'Admin') OR EXISTS (
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
    AND (
      public.has_role(auth.uid(), 'Admin') OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = b.course_id AND ct.user_id = auth.uid()
      )
      OR (
        b.shared_org = true AND EXISTS (
          SELECT 1 FROM public.courses c
          WHERE c.id = b.course_id AND c.tenant_id = public.current_tenant_id()
        )
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

-- 4) Banco → Kahoot (2 tablas: kahoot_questions + kahoot_question_options)
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
  _label TEXT;
  _idx INT;
  _is_correct BOOLEAN;
BEGIN
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
      AND b.type IN ('cerrada', 'cerrada_multi')
      AND b.options IS NOT NULL
      AND (
        public.has_role(auth.uid(), 'Admin') OR EXISTS (
          SELECT 1 FROM public.course_teachers ct
          WHERE ct.course_id = b.course_id AND ct.user_id = auth.uid()
        )
        OR (
          b.shared_org = true AND EXISTS (
            SELECT 1 FROM public.courses c
            WHERE c.id = b.course_id AND c.tenant_id = public.current_tenant_id()
          )
        )
      )
  LOOP
    _choices := _bank.options->'choices';
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

    _idx := 0;
    FOR _label IN
      SELECT value FROM jsonb_array_elements_text(_choices) LIMIT 4
    LOOP
      IF _multi THEN
        _is_correct := COALESCE((_bank.options->'correct_indices') @> to_jsonb(_idx), false);
      ELSE
        _is_correct := ((_bank.options->>'correct_index')::int = _idx);
      END IF;
      INSERT INTO public.kahoot_question_options (question_id, label, is_correct, position)
      VALUES (_qid, left(_label, 200), COALESCE(_is_correct, false), _idx);
      _idx := _idx + 1;
    END LOOP;

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

NOTIFY pgrst, 'reload schema';
