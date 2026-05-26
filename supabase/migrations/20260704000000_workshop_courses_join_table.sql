-- ──────────────────────────────────────────────────────────────────────
-- workshops M:N courses — tabla join workshop_courses.
--
-- Bug reportado: crear un taller para 2 cursos generaba 2 filas en
-- `workshops`. Causa: workshops.course_id es 1:1 (NOT NULL FK), asi que
-- el cliente itera courseIds y hace N inserts.
--
-- Modelo: replicar el patron de `project_courses` (mig 20260428210225).
-- workshops queda como UN taller con N cursos asociados. Las entregas
-- (workshop_submissions) siguen siendo per-user, no cambian.
--
-- Cambios:
--   1. Nueva tabla workshop_courses(workshop_id, course_id, weight, cut_id).
--      weight + cut_id se mueven AQUI porque pueden diferir entre cursos
--      (un taller puede pesar 30% en Curso A y 20% en Curso B). En el
--      modelo viejo eso forzaba a crear filas separadas.
--   2. Backfill: para cada workshop existente, una fila en
--      workshop_courses con course_id + weight + cut_id actuales.
--   3. workshops.course_id queda como 'curso primario' (legacy compat,
--      todavia leido por algunos joins). Lo dejamos NOT NULL pero ahora
--      apunta al "primer curso" - se sigue manteniendo en sync via
--      trigger BEFORE INSERT/UPDATE en workshop_courses (mantiene la
--      primera fila como curso primario de workshops.course_id).
--   4. RLS: SELECT abierta a authenticated (igual que project_courses);
--      WRITE solo Docente/Admin. RLS de workshops NO cambia — sigue
--      filtrando por course_id legacy + nuevas reglas no rompen.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.workshop_courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id uuid NOT NULL REFERENCES public.workshops(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  -- Peso del taller en este curso (% sobre la nota final del corte).
  -- Movido DE workshops para que pueda variar por curso. NULL = se
  -- usa el valor de workshops.weight (legacy single-course).
  weight numeric,
  cut_id uuid REFERENCES public.grade_cuts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workshop_id, course_id)
);

CREATE INDEX IF NOT EXISTS idx_workshop_courses_workshop
  ON public.workshop_courses(workshop_id);
CREATE INDEX IF NOT EXISTS idx_workshop_courses_course
  ON public.workshop_courses(course_id);

ALTER TABLE public.workshop_courses ENABLE ROW LEVEL SECURITY;

-- SELECT: cualquier autenticado puede ver las relaciones (mirror exacto
-- de project_courses_view_all_authenticated). El recorte de visibilidad
-- de TALLERES sigue siendo via workshops RLS (course_teachers /
-- course_enrollments). workshop_courses solo expone "este taller está en
-- estos cursos" — info auxiliar.
DROP POLICY IF EXISTS "workshop_courses_view_all_authenticated" ON public.workshop_courses;
CREATE POLICY "workshop_courses_view_all_authenticated"
  ON public.workshop_courses FOR SELECT TO authenticated
  USING (true);

-- WRITE: docente/admin gestionan. Mismo patrón que project_courses.
DROP POLICY IF EXISTS "workshop_courses_manage_teachers_admins" ON public.workshop_courses;
CREATE POLICY "workshop_courses_manage_teachers_admins"
  ON public.workshop_courses FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'Docente'::public.app_role)
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
    OR public.is_super_admin()
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'Docente'::public.app_role)
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
    OR public.is_super_admin()
  );

-- ─── Backfill: 1 workshop → 1 workshop_courses ───────────────────────
-- Heredamos weight y cut_id que vivían en workshops.
INSERT INTO public.workshop_courses (workshop_id, course_id, weight, cut_id)
SELECT id, course_id, weight, cut_id
  FROM public.workshops
 WHERE course_id IS NOT NULL
ON CONFLICT (workshop_id, course_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
