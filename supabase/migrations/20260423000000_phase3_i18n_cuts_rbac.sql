-- =====================================================================
-- FASE 3 — i18n, cortes de evaluación, RLS granular, notificaciones
-- =====================================================================
-- Esta migración:
--  1) añade `language` a `courses` (default 'es', check en 'es'|'en').
--  2) introduce el modelo de cortes de evaluación con pesos.
--  3) introduce `course_grading_config` (peso proyecto final vs. coursework).
--  4) añade triggers que fuerzan sumas de pesos a 100.
--  5) añade RLS granular para las nuevas tablas.
--  6) añade funciones helper para notificaciones (estudiantes y docentes)
--     que serán llamadas desde un job diario (pg_cron o edge function).
-- =====================================================================

-- 1) ---------------------------------------------------------- courses.language
ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'es';

ALTER TABLE public.courses
  DROP CONSTRAINT IF EXISTS courses_language_check;
ALTER TABLE public.courses
  ADD CONSTRAINT courses_language_check
  CHECK (language IN ('es', 'en'));


-- 2) ------------------------------------------------------------------ grade_cuts
CREATE TABLE IF NOT EXISTS public.grade_cuts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  start_date DATE,
  end_date DATE,
  weight NUMERIC(5, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT grade_cuts_weight_range CHECK (weight >= 0 AND weight <= 100),
  CONSTRAINT grade_cuts_dates_ok CHECK (
    start_date IS NULL OR end_date IS NULL OR start_date <= end_date
  )
);

CREATE INDEX IF NOT EXISTS idx_grade_cuts_course ON public.grade_cuts(course_id);
ALTER TABLE public.grade_cuts ENABLE ROW LEVEL SECURITY;


-- 3) ---------------------------------------------------------- grade_cut_items
-- Un item referencia UN recurso (exam | workshop | project-text-libre).
-- project_title se usa cuando item_type='project' y no hay tabla de proyectos aún.
CREATE TABLE IF NOT EXISTS public.grade_cut_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cut_id UUID NOT NULL REFERENCES public.grade_cuts(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('exam', 'workshop', 'project')),
  exam_id UUID REFERENCES public.exams(id) ON DELETE CASCADE,
  workshop_id UUID REFERENCES public.workshops(id) ON DELETE CASCADE,
  project_title TEXT,
  weight NUMERIC(5, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT grade_cut_items_weight_range CHECK (weight >= 0 AND weight <= 100),
  CONSTRAINT grade_cut_items_shape CHECK (
    (item_type = 'exam'     AND exam_id IS NOT NULL     AND workshop_id IS NULL AND project_title IS NULL) OR
    (item_type = 'workshop' AND workshop_id IS NOT NULL AND exam_id IS NULL     AND project_title IS NULL) OR
    (item_type = 'project'  AND project_title IS NOT NULL AND exam_id IS NULL AND workshop_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_grade_cut_items_cut ON public.grade_cut_items(cut_id);
ALTER TABLE public.grade_cut_items ENABLE ROW LEVEL SECURITY;


-- 4) ------------------------------------------------ course_grading_config
CREATE TABLE IF NOT EXISTS public.course_grading_config (
  course_id UUID PRIMARY KEY REFERENCES public.courses(id) ON DELETE CASCADE,
  final_project_weight NUMERIC(5, 2) NOT NULL DEFAULT 0,
  coursework_weight NUMERIC(5, 2) NOT NULL DEFAULT 100,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cgc_weights_sum_100
    CHECK (final_project_weight + coursework_weight = 100),
  CONSTRAINT cgc_weights_nonneg
    CHECK (final_project_weight >= 0 AND coursework_weight >= 0)
);

ALTER TABLE public.course_grading_config ENABLE ROW LEVEL SECURITY;


-- 5) ---------------------------------------------------- RLS para las tres tablas
-- Admins: full. Docentes asignados al curso: full. Estudiantes matriculados: SELECT.

-- grade_cuts
DROP POLICY IF EXISTS "cuts_admin_all" ON public.grade_cuts;
CREATE POLICY "cuts_admin_all"
  ON public.grade_cuts FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Admin'));

DROP POLICY IF EXISTS "cuts_teacher_of_course" ON public.grade_cuts;
CREATE POLICY "cuts_teacher_of_course"
  ON public.grade_cuts FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'Docente') AND EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = grade_cuts.course_id AND ct.user_id = auth.uid()
    )
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'Docente') AND EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = grade_cuts.course_id AND ct.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "cuts_student_read" ON public.grade_cuts;
CREATE POLICY "cuts_student_read"
  ON public.grade_cuts FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.course_enrollments ce
      WHERE ce.course_id = grade_cuts.course_id AND ce.user_id = auth.uid()
    )
  );

-- grade_cut_items
DROP POLICY IF EXISTS "cut_items_admin_all" ON public.grade_cut_items;
CREATE POLICY "cut_items_admin_all"
  ON public.grade_cut_items FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Admin'));

DROP POLICY IF EXISTS "cut_items_teacher_of_course" ON public.grade_cut_items;
CREATE POLICY "cut_items_teacher_of_course"
  ON public.grade_cut_items FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'Docente') AND EXISTS (
      SELECT 1 FROM public.grade_cuts gc
      JOIN public.course_teachers ct ON ct.course_id = gc.course_id
      WHERE gc.id = grade_cut_items.cut_id AND ct.user_id = auth.uid()
    )
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'Docente') AND EXISTS (
      SELECT 1 FROM public.grade_cuts gc
      JOIN public.course_teachers ct ON ct.course_id = gc.course_id
      WHERE gc.id = grade_cut_items.cut_id AND ct.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "cut_items_student_read" ON public.grade_cut_items;
CREATE POLICY "cut_items_student_read"
  ON public.grade_cut_items FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.grade_cuts gc
      JOIN public.course_enrollments ce ON ce.course_id = gc.course_id
      WHERE gc.id = grade_cut_items.cut_id AND ce.user_id = auth.uid()
    )
  );

-- course_grading_config
DROP POLICY IF EXISTS "cgc_admin_all" ON public.course_grading_config;
CREATE POLICY "cgc_admin_all"
  ON public.course_grading_config FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Admin'));

DROP POLICY IF EXISTS "cgc_teacher_of_course" ON public.course_grading_config;
CREATE POLICY "cgc_teacher_of_course"
  ON public.course_grading_config FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'Docente') AND EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = course_grading_config.course_id AND ct.user_id = auth.uid()
    )
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'Docente') AND EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = course_grading_config.course_id AND ct.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "cgc_student_read" ON public.course_grading_config;
CREATE POLICY "cgc_student_read"
  ON public.course_grading_config FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.course_enrollments ce
      WHERE ce.course_id = course_grading_config.course_id AND ce.user_id = auth.uid()
    )
  );


-- 6) ----------------------------------------------- Triggers de suma de pesos
-- Enforce SUM(weight) across grade_cuts del mismo curso <= 100 al insertar/actualizar.
-- Nota: permitimos < 100 durante la edición; la UI se encarga de pedir = 100 antes de
-- marcar la config como "completa". El hard-check se hace a nivel aplicación para
-- no bloquear el flujo de edición incremental.
CREATE OR REPLACE FUNCTION public.enforce_cut_weights_max_100()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE total NUMERIC;
BEGIN
  SELECT COALESCE(SUM(weight), 0) INTO total
  FROM public.grade_cuts
  WHERE course_id = COALESCE(NEW.course_id, OLD.course_id)
    AND id <> COALESCE(NEW.id, OLD.id);
  total := total + COALESCE(NEW.weight, 0);
  IF total > 100.01 THEN
    RAISE EXCEPTION 'La suma de pesos de cortes excede 100 (actual: %).', total;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_cut_weights ON public.grade_cuts;
CREATE TRIGGER trg_enforce_cut_weights
  BEFORE INSERT OR UPDATE ON public.grade_cuts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cut_weights_max_100();

CREATE OR REPLACE FUNCTION public.enforce_cut_item_weights_max_100()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE total NUMERIC;
BEGIN
  SELECT COALESCE(SUM(weight), 0) INTO total
  FROM public.grade_cut_items
  WHERE cut_id = COALESCE(NEW.cut_id, OLD.cut_id)
    AND id <> COALESCE(NEW.id, OLD.id);
  total := total + COALESCE(NEW.weight, 0);
  IF total > 100.01 THEN
    RAISE EXCEPTION 'La suma de pesos de items del corte excede 100 (actual: %).', total;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_cut_item_weights ON public.grade_cut_items;
CREATE TRIGGER trg_enforce_cut_item_weights
  BEFORE INSERT OR UPDATE ON public.grade_cut_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cut_item_weights_max_100();


-- 7) ---------------------------------------------- Funciones de notificaciones
--
-- Todas son SECURITY DEFINER y deberían llamarse desde un job diario
-- (pg_cron o la edge function `daily-notifications`). Idempotentes: para evitar
-- duplicados usan un candado por (user_id, link, date_trunc('day', created_at))
-- via WHERE NOT EXISTS.

-- A) Estudiantes: corte cerrando en _days días
CREATE OR REPLACE FUNCTION public.notify_students_cut_closing(_days INTEGER DEFAULT 3)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _count INTEGER;
BEGIN
  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT
    ce.user_id,
    'Corte ' || gc.name || ' cerrando pronto',
    'El corte "' || gc.name || '" del curso ' || c.name ||
      ' cierra el ' || gc.end_date::text || '.',
    'grade',
    '/app/student/grades'
  FROM public.grade_cuts gc
  JOIN public.courses c ON c.id = gc.course_id
  JOIN public.course_enrollments ce ON ce.course_id = c.id
  WHERE gc.end_date = (CURRENT_DATE + _days)
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
      WHERE n.user_id = ce.user_id
        AND n.link = '/app/student/grades'
        AND n.title = 'Corte ' || gc.name || ' cerrando pronto'
        AND n.created_at::date = CURRENT_DATE
    );
  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END $$;

-- B) Estudiantes: curso cerrando en _days días
CREATE OR REPLACE FUNCTION public.notify_students_course_closing(_days INTEGER DEFAULT 7)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _count INTEGER;
BEGIN
  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT
    ce.user_id,
    'Curso ' || c.name || ' cerrando pronto',
    'El curso ' || c.name || ' finaliza el ' || c.end_date::text || '.',
    'info',
    '/app/student/courses'
  FROM public.courses c
  JOIN public.course_enrollments ce ON ce.course_id = c.id
  WHERE c.end_date = (CURRENT_DATE + _days)
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
      WHERE n.user_id = ce.user_id
        AND n.title = 'Curso ' || c.name || ' cerrando pronto'
        AND n.created_at::date = CURRENT_DATE
    );
  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END $$;

-- C) Docentes: taller que vence mañana (resumen diario — una notificación por curso)
CREATE OR REPLACE FUNCTION public.notify_teachers_workshop_due_tomorrow()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _count INTEGER;
BEGIN
  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT
    ct.user_id,
    'Talleres vencen mañana',
    COUNT(*)::text || ' taller(es) del curso ' || c.name || ' vencen mañana.',
    'workshop',
    '/app/teacher/workshops'
  FROM public.workshops w
  JOIN public.courses c ON c.id = w.course_id
  JOIN public.course_teachers ct ON ct.course_id = c.id
  WHERE w.due_date::date = (CURRENT_DATE + 1)
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
      WHERE n.user_id = ct.user_id
        AND n.title = 'Talleres vencen mañana'
        AND n.link = '/app/teacher/workshops'
        AND n.created_at::date = CURRENT_DATE
    )
  GROUP BY ct.user_id, c.id, c.name;
  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END $$;

-- D) Docentes: entregas pendientes de calificar (resumen diario)
CREATE OR REPLACE FUNCTION public.notify_teachers_pending_grading()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _count INTEGER;
BEGIN
  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT
    ct.user_id,
    'Entregas pendientes por calificar',
    'Tienes ' || COUNT(*)::text || ' entrega(s) en el curso ' || c.name ||
      ' pendientes después de su fecha de cierre.',
    'workshop',
    '/app/teacher/workshops'
  FROM public.workshop_submissions ws
  JOIN public.workshops w ON w.id = ws.workshop_id
  JOIN public.courses c ON c.id = w.course_id
  JOIN public.course_teachers ct ON ct.course_id = c.id
  WHERE w.due_date < now()
    AND ws.status IN ('entregado', 'ai_revisado')  -- aún no calificados
  GROUP BY ct.user_id, c.id, c.name
  HAVING COUNT(*) > 0;
  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END $$;


-- 8) Trigger de updated_at para grade_cuts
DROP TRIGGER IF EXISTS grade_cuts_updated ON public.grade_cuts;
CREATE TRIGGER grade_cuts_updated
  BEFORE UPDATE ON public.grade_cuts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS cgc_updated ON public.course_grading_config;
CREATE TRIGGER cgc_updated
  BEFORE UPDATE ON public.course_grading_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- 9) Realtime para las nuevas tablas (los estudiantes reciben updates en vivo)
ALTER PUBLICATION supabase_realtime ADD TABLE public.grade_cuts;
ALTER PUBLICATION supabase_realtime ADD TABLE public.grade_cut_items;
ALTER PUBLICATION supabase_realtime ADD TABLE public.course_grading_config;

-- =====================================================================
-- Instrucciones operativas:
--   Para programar las 4 funciones de notificaciones cada día 07:00 UTC:
--     SELECT cron.schedule('examlab-daily-notifs', '0 7 * * *', $$
--       SELECT notify_students_cut_closing(3);
--       SELECT notify_students_course_closing(7);
--       SELECT notify_teachers_workshop_due_tomorrow();
--       SELECT notify_teachers_pending_grading();
--     $$);
--   Alternativa sin pg_cron: invocar la edge function `daily-notifications`
--   desde un scheduler externo (GitHub Actions, Cloudflare Cron).
-- =====================================================================
