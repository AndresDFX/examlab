-- ══════════════════════════════════════════════════════════════════════
-- Cerrar el hueco de auto-asignación de docentes.
--
-- Un Docente NO debe poder asignarse a sí mismo como docente de un curso
-- (lo asigna el Admin, o queda asignado al CREAR el curso vía trigger
-- SECURITY DEFINER). El dialog de docentes ya filtra al usuario actual de la
-- lista, pero la RLS tenía un agujero:
--
--   - 20260419090000 creó la policy "Docentes manage own course_teachers"
--     con USING/WITH CHECK = (has_role('Docente') AND auth.uid() = user_id),
--     que PERMITE gestionar la PROPIA fila (auto-asignarse / auto-quitarse).
--   - 20260528000000 endureció course_teachers (admin_manage +
--     docente_manage_others con user_id <> auth.uid()), pero sólo dropeó
--     "Docentes manage OTHER course_teachers", NO "Docentes manage OWN".
--
-- Como las policies permisivas se combinan con OR, la vieja "manage own"
-- seguía permitiendo que un Docente se auto-insertara en course_teachers de
-- CUALQUIER curso de su tenant vía API/REST (aunque el UI lo ocultara).
-- La eliminamos: queda sólo "course_teachers_docente_manage_others"
-- (user_id <> auth.uid()) + "course_teachers_admin_manage".
--
-- El trigger tg_course_add_creator_teacher (20260963) NO se ve afectado:
-- es SECURITY DEFINER, así que un Docente que crea un curso sigue quedando
-- como su docente sin pasar por esta policy.
-- ══════════════════════════════════════════════════════════════════════

DO $mig$
BEGIN
  IF to_regclass('public.course_teachers') IS NULL THEN
    RAISE NOTICE 'skip: course_teachers ausente';
    RETURN;
  END IF;

  -- La policy de auto-gestión (self-assign). IF EXISTS → idempotente.
  DROP POLICY IF EXISTS "Docentes manage own course_teachers" ON public.course_teachers;
END
$mig$;

NOTIFY pgrst, 'reload schema';
