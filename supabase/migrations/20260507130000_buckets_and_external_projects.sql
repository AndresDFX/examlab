-- ============================================================
-- 1) Buckets de pesos por TIPO dentro del corte:
--    grade_cuts ya tiene workshop_weight, exam_weight, project_weight
--    como columnas (legacy desde 20260507100000) — están en 0 tras esa
--    migración. Las reactivamos con un backfill que distribuye el
--    peso según los items realmente asignados, preservando el cálculo
--    actual.
--
--    Modelo nuevo:
--      cut.weight             = % de la nota final del curso
--      cut.attendance_weight  = % de la nota final para asistencia
--      cut.workshop_weight    = % para todos los talleres del corte
--      cut.exam_weight        = % para todos los exámenes del corte
--      cut.project_weight     = % para todos los proyectos del corte
--
--    Suma de los 4 buckets debe igualar cut.weight (validación soft).
--    Cada item.weight sigue siendo % de la nota final (sin cambio),
--    así que computeWeightedGrade no cambia. Los buckets son SOLO un
--    cap para el form al editar items.
--
-- 2) projects.is_external (flag para proyectos presenciales/externos)
--    + index para filtrado rápido.
--
-- 3) submissions.teacher_feedback (texto):
--    workshop_submissions y project_submissions ya tienen este campo;
--    submissions (de exámenes) no. Lo agregamos para que el editor de
--    notas externas pueda guardar la observación del docente.
-- ============================================================

-- ── 1) Backfill de buckets ──
-- Para cada cut, sumar el weight de los items asignados de ese tipo.
-- Solo se aplica a cuts cuyos buckets están vacíos (=0) para no pisar
-- configuraciones manuales si la migración corre dos veces.
UPDATE public.grade_cuts gc
SET workshop_weight = COALESCE((
  SELECT SUM(w.weight)::numeric
  FROM public.workshops w
  WHERE w.cut_id = gc.id
), 0)
WHERE gc.workshop_weight = 0;

UPDATE public.grade_cuts gc
SET exam_weight = COALESCE((
  SELECT SUM(e.weight)::numeric
  FROM public.exams e
  WHERE e.cut_id = gc.id AND e.parent_exam_id IS NULL
), 0)
WHERE gc.exam_weight = 0;

UPDATE public.grade_cuts gc
SET project_weight = COALESCE((
  SELECT SUM(p.weight)::numeric
  FROM public.projects p
  WHERE p.cut_id = gc.id
), 0)
WHERE gc.project_weight = 0;

-- ── 2) projects.is_external ──
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS is_external BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_projects_course_is_external
  ON public.projects(course_id, is_external);

-- ── 3) submissions.teacher_feedback ──
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS teacher_feedback TEXT;
