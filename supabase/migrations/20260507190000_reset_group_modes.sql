-- ============================================================
-- One-shot: resetear talleres y proyectos a group_mode='individual'.
--
-- Contexto: el botón "Grupos / Activar grupos" auto-activa
-- teacher_assigned al click. Eso convirtió por error en grupales a
-- talleres y proyectos que el docente solo abrió para explorar. La
-- data correcta es individual; cuando el docente quiera grupos los
-- activa explícitamente desde el form o reabre el dialog.
--
-- Se eliminan los grupos creados — sus members caen por CASCADE y
-- las submissions huérfanas quedan con group_id=NULL por la FK con
-- ON DELETE SET NULL (definida en 20260507150000 / 20260507180000).
-- ============================================================

UPDATE public.workshops SET group_mode = 'individual';
UPDATE public.projects  SET group_mode = 'individual';

DELETE FROM public.workshop_groups;
DELETE FROM public.project_groups;
