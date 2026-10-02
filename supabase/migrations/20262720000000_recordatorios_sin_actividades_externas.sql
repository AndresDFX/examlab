-- ═══════════════════════════════════════════════════════════════════════
-- Una actividad EXTERNA no recibe recordatorio de «vence pronto».
--
-- Desde 2026-10-01 un taller o un proyecto externo tiene fecha de inicio y de
-- fin como cualquier otro (antes se guardaba una sola fecha, la del evento ya
-- ocurrido). Lo que sigue sin tener es la entrega por la plataforma: se hace
-- presencial o en otra herramienta, y el docente solo carga la nota.
--
-- Con una fecha fin en el futuro, los recordatorios de talleres y proyectos le
-- habrían escrito a cada estudiante «vence en menos de N h. Entrega antes del
-- cierre» por algo que no tiene dónde entregar —y como no hay entrega, la
-- exclusión «ya entregó» nunca lo frenaba—. Los de examen ya excluían a los
-- externos (mig 20262620000000); esto deja a los tres iguales.
--
-- El taller externo hoy se guarda «cerrado» y no habría llegado a esta
-- consulta (exige `published`), pero el proyecto externo conserva su estado:
-- publicado, sí llegaba. Se excluye en las dos para no depender del estado.
--
-- Cuerpos idénticos a los de la mig 20262440000000 salvo la condición nueva.
-- ═══════════════════════════════════════════════════════════════════════

-- 1) ─────────────── Recordatorio de talleres
CREATE OR REPLACE FUNCTION public.notify_students_workshop_due_soon(
  _hours INTEGER DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _count INTEGER;
  _lead  INTEGER;
BEGIN
  -- Resolver el lead: arg explícito → setting → 1. Robusto si falta la tabla.
  _lead := _hours;
  IF _lead IS NULL THEN
    BEGIN
      SELECT due_reminder_lead_hours INTO _lead FROM public.app_settings LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      _lead := NULL;
    END;
  END IF;
  IF _lead IS NULL THEN _lead := 1; END IF;
  IF _lead < 1 THEN _lead := 1; ELSIF _lead > 168 THEN _lead := 168; END IF;

  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT
    wa.user_id,
    'Tu taller "' || w.title || '" vence pronto',
    'El taller del curso "' || COALESCE(c.name, 'sin curso') ||
      '" vence en menos de ' || _lead || ' h. Entrega antes del cierre.',
    'workshop',
    '/app/student/workshops'
  FROM public.workshops w
  LEFT JOIN public.courses c ON c.id = w.course_id
  JOIN public.workshop_assignments wa ON wa.workshop_id = w.id
  WHERE w.due_date IS NOT NULL
    AND w.due_date > NOW()
    AND w.due_date <= NOW() + make_interval(hours => _lead)
    AND w.status = 'published'
    AND w.deleted_at IS NULL
    -- Una externa no se entrega por la plataforma: no hay nada que recordar.
    AND COALESCE(w.is_external, false) = false
    -- Exclusión 1: ya entregaron
    AND NOT EXISTS (
      SELECT 1 FROM public.workshop_submissions s
       WHERE s.workshop_id = w.id
         AND s.user_id = wa.user_id
         AND public.estado_es_entrega(s.status)
    )
    -- Exclusión 2: dedup PERMANENTE — un único aviso por (alumno, taller).
    -- (Sin ventana de tiempo: ya no se repite cada N horas.)
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
       WHERE n.user_id = wa.user_id
         AND n.title = 'Tu taller "' || w.title || '" vence pronto'
    );

  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END
$$;

REVOKE ALL ON FUNCTION public.notify_students_workshop_due_soon(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_students_workshop_due_soon(INTEGER) TO service_role;

REVOKE EXECUTE ON FUNCTION public.notify_students_workshop_due_soon(INTEGER) FROM anon, authenticated;

-- 2) ─────────────── Recordatorio de proyectos
CREATE OR REPLACE FUNCTION public.notify_students_project_due_soon(
  _hours INTEGER DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _count INTEGER;
  _lead  INTEGER;
BEGIN
  _lead := _hours;
  IF _lead IS NULL THEN
    BEGIN
      SELECT due_reminder_lead_hours INTO _lead FROM public.app_settings LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      _lead := NULL;
    END;
  END IF;
  IF _lead IS NULL THEN _lead := 1; END IF;
  IF _lead < 1 THEN _lead := 1; ELSIF _lead > 168 THEN _lead := 168; END IF;

  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT DISTINCT
    target.user_id,
    'Tu proyecto "' || p.title || '" vence pronto',
    'El proyecto vence en menos de ' || _lead || ' h. Entrega antes del cierre.',
    'project',
    '/app/student/projects'
  FROM public.projects p
  CROSS JOIN LATERAL (
    SELECT pa.user_id
      FROM public.project_assignments pa
     WHERE pa.project_id = p.id
    UNION
    SELECT ce.user_id
      FROM public.project_courses pc
      JOIN public.course_enrollments ce ON ce.course_id = pc.course_id
     WHERE pc.project_id = p.id
  ) target
  WHERE p.due_date IS NOT NULL
    AND p.due_date > NOW()
    AND p.due_date <= NOW() + make_interval(hours => _lead)
    AND p.status = 'published'
    AND p.deleted_at IS NULL
    -- Una externa no se entrega por la plataforma: no hay nada que recordar.
    AND COALESCE(p.is_external, false) = false
    AND NOT EXISTS (
      SELECT 1 FROM public.project_submissions s
       WHERE s.project_id = p.id
         AND s.user_id = target.user_id
         AND public.estado_es_entrega(s.status)
    )
    -- Dedup PERMANENTE — un único aviso por (alumno, proyecto).
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
       WHERE n.user_id = target.user_id
         AND n.title = 'Tu proyecto "' || p.title || '" vence pronto'
    );

  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END
$$;

REVOKE ALL ON FUNCTION public.notify_students_project_due_soon(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_students_project_due_soon(INTEGER) TO service_role;
REVOKE EXECUTE ON FUNCTION public.notify_students_project_due_soon(INTEGER) FROM anon, authenticated;
