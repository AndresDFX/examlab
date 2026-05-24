-- ============================================================
-- Horarios del curso.
--
-- Un curso (instancia por periodo) se dicta en bloques semanales
-- recurrentes. Ej. Programación II 341-A:
--   - lunes  10:00 – 12:00, aula 301 (presencial)
--   - jueves 14:00 – 16:00, virtual (Zoom)
--
-- Modelo: una fila por bloque. Múltiples bloques por curso.
-- Day of week = 0..6 con 0=domingo (compatible con JS Date.getDay()
-- y con `EXTRACT(DOW FROM x)` de Postgres). Esto facilita comparar
-- contra fechas de attendance_sessions sin conversiones.
--
-- Modalidad por bloque (no por curso) — un curso puede tener clases
-- presenciales y virtuales en distintos días. Si la institución no
-- diferencia, default 'presencial'.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.course_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  -- 0=domingo, 1=lunes, ..., 6=sábado (alineado con JS Date.getDay()).
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  -- Aula / salón / link de videollamada (texto libre).
  aula text,
  modalidad text NOT NULL DEFAULT 'presencial'
    CHECK (modalidad IN ('presencial', 'virtual', 'hibrida')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- start < end. Bloques que cruzan medianoche (raros en universidades)
  -- requieren dos filas.
  CONSTRAINT chk_course_schedules_time_order CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_course_schedules_course_id
  ON public.course_schedules(course_id);
CREATE INDEX IF NOT EXISTS idx_course_schedules_day
  ON public.course_schedules(day_of_week);

-- Trigger updated_at.
DROP TRIGGER IF EXISTS trg_course_schedules_updated_at ON public.course_schedules;
CREATE TRIGGER trg_course_schedules_updated_at
  BEFORE UPDATE ON public.course_schedules
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.course_schedules ENABLE ROW LEVEL SECURITY;

-- SELECT: Admin, docentes del curso, estudiantes matriculados.
-- Los estudiantes necesitan ver su propio horario.
DROP POLICY IF EXISTS "course_schedules_read" ON public.course_schedules;
CREATE POLICY "course_schedules_read"
  ON public.course_schedules FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = course_schedules.course_id AND ct.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.course_enrollments ce
      WHERE ce.course_id = course_schedules.course_id AND ce.user_id = auth.uid()
    )
  );

-- INSERT/UPDATE/DELETE: Admin o docente del curso.
DROP POLICY IF EXISTS "course_schedules_write" ON public.course_schedules;
CREATE POLICY "course_schedules_write"
  ON public.course_schedules FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = course_schedules.course_id AND ct.user_id = auth.uid()
    )
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = course_schedules.course_id AND ct.user_id = auth.uid()
    )
  );

NOTIFY pgrst, 'reload schema';
