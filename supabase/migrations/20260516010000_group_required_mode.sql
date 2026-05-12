-- Agrega el modo 'group_required' (= "Grupal estricto") al CHECK constraint
-- de workshops.group_mode y projects.group_mode.
--
-- Mapeo UI -> DB:
--   "Individual" -> 'individual'
--   "Grupal"     -> 'group_required'  (nuevo) — bloquea entregas de
--                   estudiantes que no esten en un grupo.
--   "Mixto"      -> 'teacher_assigned' — coexisten entregas en grupo
--                   y entregas individuales.
--
-- 'self_signup' queda en el CHECK por compatibilidad con la columna
-- existente (V2: autoinscripcion con codigo), pero la UI actual no
-- la expone.
--
-- IMPORTANTE: el bloqueo en modo 'group_required' lo hace el frontend
-- (StudentProjectTaker / StudentWorkshopTaker) leyendo group_mode +
-- la membresia del estudiante en los grupos. NO se hace un trigger en
-- DB porque la logica de "alumno tiene grupo" requiere joins entre
-- tres tablas y un trigger lo haria fragil. La validacion frontend
-- es suficiente porque RLS ya impide modificar submissions ajenas.

-- workshops.group_mode
ALTER TABLE public.workshops
  DROP CONSTRAINT IF EXISTS workshops_group_mode_check;
ALTER TABLE public.workshops
  ADD CONSTRAINT workshops_group_mode_check
    CHECK (group_mode IN ('individual', 'teacher_assigned', 'self_signup', 'group_required'));

-- projects.group_mode
ALTER TABLE public.projects
  DROP CONSTRAINT IF EXISTS projects_group_mode_check;
ALTER TABLE public.projects
  ADD CONSTRAINT projects_group_mode_check
    CHECK (group_mode IN ('individual', 'teacher_assigned', 'self_signup', 'group_required'));

NOTIFY pgrst, 'reload schema';
