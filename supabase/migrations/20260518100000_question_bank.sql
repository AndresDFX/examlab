-- ──────────────────────────────────────────────────────────────────────
-- Banco de preguntas reutilizable.
--
-- Modelo: una tabla `question_bank` con todos los tipos de pregunta que
-- soportan los 3 módulos (examen, taller, proyecto). Cada pregunta vive
-- dentro de un curso — todos los docentes asignados a ese curso pueden
-- ver/editar/borrar.
--
-- Al importar al examen/taller/proyecto, se CLONA la pregunta (no se
-- referencia). Eso permite ajustar puntos/contenido sin afectar el
-- banco, y desacopla items históricos de cambios futuros.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.question_bank (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Tipos soportados: union de los 3 módulos. `codigo_zip` es exclusivo
  -- de proyecto pero lo permitimos en el banco para que el docente pueda
  -- mantener una sola fuente.
  type TEXT NOT NULL CHECK (
    type IN ('cerrada','cerrada_multi','codigo','codigo_zip','abierta','diagrama','java_gui')
  ),
  content TEXT NOT NULL,
  options JSONB,
  expected_rubric TEXT,
  language TEXT,
  starter_code TEXT,
  -- Puntaje sugerido (el docente puede ajustarlo al importar)
  suggested_points NUMERIC NOT NULL DEFAULT 1 CHECK (suggested_points >= 0),

  -- Clasificación
  topic TEXT,
  difficulty INT CHECK (difficulty BETWEEN 1 AND 5),
  tags TEXT[] NOT NULL DEFAULT '{}',

  -- Estadísticas (se llenan al importar)
  times_used INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_question_bank_course ON public.question_bank(course_id);
CREATE INDEX IF NOT EXISTS idx_question_bank_topic  ON public.question_bank(topic);
CREATE INDEX IF NOT EXISTS idx_question_bank_difficulty ON public.question_bank(difficulty);
CREATE INDEX IF NOT EXISTS idx_question_bank_tags ON public.question_bank USING GIN (tags);

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_question_bank_updated_at ON public.question_bank;
CREATE TRIGGER trg_question_bank_updated_at
  BEFORE UPDATE ON public.question_bank
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── RLS: docentes asignados al curso O Admin ──

ALTER TABLE public.question_bank ENABLE ROW LEVEL SECURITY;

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
  );

DROP POLICY IF EXISTS "question_bank_write" ON public.question_bank;
CREATE POLICY "question_bank_write"
  ON public.question_bank FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = question_bank.course_id
        AND ct.user_id = auth.uid()
    )
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = question_bank.course_id
        AND ct.user_id = auth.uid()
    )
  );

-- ────────────────────────────────────────────────────────────────────
-- RPCs para clonar del banco a cada módulo
-- ────────────────────────────────────────────────────────────────────

-- 1) Banco → exam_questions
-- _points_override: JSONB con {bank_id: points} para sobreescribir
-- el suggested_points al importar. Si no hay override, usa el sugerido.

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
    -- Tipo codigo_zip no aplica a examen (es solo para proyectos).
    AND b.type <> 'codigo_zip'
    -- El usuario también debe ver el banco (RLS lo refuerza).
    AND (
      public.has_role(auth.uid(), 'Admin') OR EXISTS (
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

-- 2) Banco → workshop_questions

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
    AND b.type <> 'codigo_zip'  -- No aplica a workshop tampoco
    AND (
      public.has_role(auth.uid(), 'Admin') OR EXISTS (
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

-- 3) Banco → project_files
-- En proyectos `position` se infiere; los project_files usan `title` como
-- enunciado. Mapeamos: bank.content → title, bank.expected_rubric → expected_rubric.

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
    -- Proyecto SÍ acepta codigo_zip además del resto
    AND (
      public.has_role(auth.uid(), 'Admin') OR EXISTS (
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

NOTIFY pgrst, 'reload schema';
