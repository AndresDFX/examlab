-- Add cut_id and weight to project_courses so each course linkage
-- can independently track its cut assignment and weight contribution.
-- This fixes the bug where a project assigned to N courses shared a
-- single cut_id/weight (stored in projects), making it impossible to
-- assign different cuts or weights per course.

ALTER TABLE project_courses
  ADD COLUMN cut_id uuid REFERENCES grade_cuts(id) ON DELETE SET NULL,
  ADD COLUMN weight numeric NOT NULL DEFAULT 1;

-- Backfill: for the primary course linkage, copy cut_id and weight
-- from projects. This preserves existing behavior for projects that
-- were already configured with a cut before this migration.
UPDATE project_courses pc
SET cut_id = p.cut_id,
    weight = COALESCE(p.weight, 1)
FROM projects p
WHERE pc.project_id = p.id
  AND pc.course_id  = p.course_id
  AND p.cut_id IS NOT NULL;
