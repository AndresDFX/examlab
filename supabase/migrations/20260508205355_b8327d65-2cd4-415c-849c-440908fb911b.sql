-- Reasignar exam con cut_id huérfano (cut_id pertenece a otro curso) al cut
-- del MISMO curso con el mismo nombre. Si no hay match, dejar NULL.
UPDATE exams e
SET cut_id = (
  SELECT gc2.id FROM grade_cuts gc2
  WHERE gc2.course_id = e.course_id
    AND gc2.name = (SELECT name FROM grade_cuts WHERE id = e.cut_id)
  LIMIT 1
)
WHERE e.cut_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM grade_cuts gc
    WHERE gc.id = e.cut_id AND gc.course_id = e.course_id
  );

-- Lo mismo para workshops y projects (defensivo, hoy no hay huérfanos)
UPDATE workshops w
SET cut_id = (
  SELECT gc2.id FROM grade_cuts gc2
  WHERE gc2.course_id = w.course_id
    AND gc2.name = (SELECT name FROM grade_cuts WHERE id = w.cut_id)
  LIMIT 1
)
WHERE w.cut_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM grade_cuts gc
    WHERE gc.id = w.cut_id AND gc.course_id = w.course_id
  );

UPDATE projects p
SET cut_id = (
  SELECT gc2.id FROM grade_cuts gc2
  WHERE gc2.course_id = p.course_id
    AND gc2.name = (SELECT name FROM grade_cuts WHERE id = p.cut_id)
  LIMIT 1
)
WHERE p.cut_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM grade_cuts gc
    WHERE gc.id = p.cut_id AND gc.course_id = p.course_id
  );