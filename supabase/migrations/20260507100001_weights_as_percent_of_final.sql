-- ============================================================
-- Refactor del modelo de pesos: cada item pesa directamente como
-- % de la nota final, no como % dentro de un bucket por componente.
-- ============================================================
-- Antes:
--   cut.weight = % del curso (cuts suman 100)
--   cut.exam_weight, workshop_weight, project_weight, attendance_weight =
--     bucket por componente, suman 100 dentro del corte.
--   item.weight (exam) = relativo dentro del bucket (uniforme = 1)
--
-- Ahora:
--   cut.weight = % de la nota final (cuts suman 100) — sin cambios
--   item.weight (exam, workshop, project) = % de la nota final
--   cut.attendance_weight = % de la nota final para asistencia del corte
--   cut.exam_weight, workshop_weight, project_weight = legacy, no se usan
--   La suma de (items + attendance_weight) dentro de un corte debe ser
--   igual a cut.weight (validación soft en UI).
--
-- Migración:
--   1) Add projects.weight (workshops.weight ya existe de migración previa)
--   2) cut.attendance_weight = round(att_weight * cut.weight / 100)
--      (convierte de "% del corte" a "% del total")
--   3) cut.exam_weight, workshop_weight, project_weight = 0 (legacy)
--   4) Items existentes mantienen su weight=1 (default), el docente
--      reconfigura post-migración. El cálculo usa weighted avg, así
--      que weight=1 uniforme equivale al promedio simple anterior.
-- ============================================================

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS weight numeric NOT NULL DEFAULT 1;

-- Convierte attendance_weight a "% del total". Se aplica una sola vez:
-- detectamos data en formato viejo si la suma de buckets de un corte
-- es ~100 (típico del modelo anterior). Si la suma ya es 0 o no
-- coincide, asumimos que está en formato nuevo y no tocamos.
UPDATE public.grade_cuts
SET
  attendance_weight = ROUND(
    (COALESCE(attendance_weight, 0) * COALESCE(weight, 0) / 100.0)::numeric,
    2
  ),
  exam_weight = 0,
  workshop_weight = 0,
  project_weight = 0
WHERE
  COALESCE(exam_weight, 0)
    + COALESCE(workshop_weight, 0)
    + COALESCE(project_weight, 0)
    + COALESCE(attendance_weight, 0)
  BETWEEN 99 AND 101;
