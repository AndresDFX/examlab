-- ═══════════════════════════════════════════════════════════════════════
-- «Ya entregó» deja de ser una lista suelta dentro de cada consulta.
--
-- El recordatorio «tu taller/proyecto vence pronto» excluía a quien ya había
-- entregado con  s.status IN ('entregado','calificado','ai_revisado').  Esa
-- lista se quedó sin `requiere_revision`, el estado que la propia plataforma
-- escribe cuando la IA marca una entrega para revisar. Consecuencia: a ese
-- alumno —que YA entregó— le llegaba un correo diciéndole que entregara antes
-- del cierre. El dedup es permanente, así que es un único correo por entrega,
-- pero un único correo que lo desmiente ya alcanza para que desconfíe del
-- aviso (y de paso, para que escriba preguntando si su entrega se perdió).
--
-- Es el mismo fallo que en la pantalla del estudiante marcaba «Vencido» sobre
-- entregas reales, y tiene la misma causa: una lista BLANCA de estados. Los
-- estados nuevos de estas tablas nacen del pipeline de calificación, o sea
-- DESPUÉS de entregar, así que con lista blanca cada uno se cae al peor lado.
--
-- Acá se invierte, igual que en el cliente: se enumeran los estados en los que
-- TODAVÍA no entregó y cualquier otro cuenta como entrega hecha.
--
-- ── Invariante cross-file ──────────────────────────────────────────────
-- `public.estado_es_entrega` es el espejo de `esEstadoDeEntrega` de
-- `src/modules/submissions/entrega-hecha.ts`, y su lista tiene que ser la
-- MISMA que `ESTADOS_SIN_ENTREGAR`. Si divergen, el correo del cron y la
-- pantalla se contradicen sobre la misma entrega, que es justo el síntoma que
-- esto viene a cerrar. Lo fija un test que lee esta migración del disco.
-- ═══════════════════════════════════════════════════════════════════════

-- 1) ─────────────── El predicado, espejo del cliente
CREATE OR REPLACE FUNCTION public.estado_es_entrega(_status TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  -- NULL o desconocido → sí entregó. Ver el encabezado: el default tiene que
  -- caer del lado de «entregó», no al revés.
  SELECT _status IS NULL
      OR btrim(_status) NOT IN (
           'en_progreso',
           'iniciado',
           'borrador',
           'draft',
           'pendiente',
           'no_entregado'
         );
$fn$;

REVOKE ALL ON FUNCTION public.estado_es_entrega(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.estado_es_entrega(TEXT) TO authenticated, service_role;

-- 2) ─────────────── Recordatorio de talleres (idéntico salvo la exclusión)
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

-- 3) ─────────────── Recordatorio de proyectos (ídem)
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
