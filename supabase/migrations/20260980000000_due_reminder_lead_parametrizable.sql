-- ═══════════════════════════════════════════════════════════════════════
-- Recordatorio de entrega "1 hora antes", parametrizable y UNA sola vez.
--
-- Antes: `notify_students_{workshop,project}_due_soon(24)` corría cada 2h con
-- ventana de 24h y dedup de SOLO 6h → el alumno recibía el aviso al entrar en
-- la ventana de 24h y LUEGO otra vez cada 6h hasta el cierre (varios correos
-- por la misma entrega). Eso es el "me llega cada hora / todo el tiempo".
--
-- Ahora:
--   • Ventana = el lead configurable (por defecto 1h): se avisa cuando la
--     entrega vence DENTRO de ese lead, no 24h antes.
--   • Dedup PERMANENTE: un único aviso por (alumno, entrega). Nunca se repite.
--   • Lead PARAMETRIZABLE desde `app_settings.due_reminder_lead_hours` (Admin
--     lo edita en Configuración → Parámetros). El arg explícito de la función
--     sigue ganando (compat); si es NULL, lee el setting; si no hay, cae a 1.
--   • El cron pasa a cada 15 min (necesario para acertar la ventana de 1h);
--     como el dedup es permanente, el alumno igual recibe UN solo aviso.
-- ═══════════════════════════════════════════════════════════════════════

-- 1) ─────────────── Parámetro configurable en app_settings (defensivo)
DO $$
BEGIN
  IF to_regclass('public.app_settings') IS NOT NULL THEN
    ALTER TABLE public.app_settings
      ADD COLUMN IF NOT EXISTS due_reminder_lead_hours INT NOT NULL DEFAULT 1
      CHECK (due_reminder_lead_hours BETWEEN 1 AND 168);
  END IF;
END $$;

-- 2) ─────────────── Recordatorio de talleres (1h antes, una vez)
-- plpgsql es de enlace tardío: referir a tablas que podrían faltar no rompe
-- la creación (se evalúa al ejecutar). Por eso el CREATE va a nivel superior.
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
         AND s.status IN ('entregado', 'calificado', 'ai_revisado')
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

-- 3) ─────────────── Recordatorio de proyectos (1h antes, una vez)
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
         AND s.status IN ('entregado', 'calificado', 'ai_revisado')
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

-- 4) ─────────────── Reagendar el cron: cada 15 min, lead configurable
-- Quitamos los jobs viejos (ventana 24h / cada 2h) y registramos los nuevos
-- que llaman a la función SIN arg → toma el lead de app_settings.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron no disponible; reagendar los recordatorios manualmente.';
    RETURN;
  END;

  -- Quitar jobs previos (cualquiera de los nombres usados).
  PERFORM extensions.cron.unschedule('workshop-due-24h')
   WHERE EXISTS (SELECT 1 FROM extensions.cron.job WHERE jobname = 'workshop-due-24h');
  PERFORM extensions.cron.unschedule('project-due-24h')
   WHERE EXISTS (SELECT 1 FROM extensions.cron.job WHERE jobname = 'project-due-24h');
  PERFORM extensions.cron.unschedule('workshop-due-reminder')
   WHERE EXISTS (SELECT 1 FROM extensions.cron.job WHERE jobname = 'workshop-due-reminder');
  PERFORM extensions.cron.unschedule('project-due-reminder')
   WHERE EXISTS (SELECT 1 FROM extensions.cron.job WHERE jobname = 'project-due-reminder');

  -- Cada 15 min: necesario para acertar la ventana de 1h. El dedup permanente
  -- garantiza UN solo aviso por entrega.
  PERFORM extensions.cron.schedule(
    'workshop-due-reminder',
    '*/15 * * * *',
    $cron$ SELECT public.notify_students_workshop_due_soon(); $cron$
  );
  PERFORM extensions.cron.schedule(
    'project-due-reminder',
    '*/15 * * * *',
    $cron$ SELECT public.notify_students_project_due_soon(); $cron$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Reagendado de recordatorios falló: %', SQLERRM;
END
$$;

-- 5) ─────────────── Descripciones humanas para el panel SuperAdmin
DO $$
BEGIN
  IF to_regclass('public.cron_job_descriptions') IS NOT NULL THEN
    DELETE FROM public.cron_job_descriptions WHERE jobname IN ('workshop-due-24h', 'project-due-24h');
    INSERT INTO public.cron_job_descriptions (jobname, description) VALUES
      ('workshop-due-reminder',
       'Cada 15 min avisa UNA sola vez al estudiante cuando un taller que no ha entregado está por vencer, dentro del lead configurable (Configuración → Parámetros → "Recordatorio de entregas (horas antes)", por defecto 1 h). No se repite por entrega.'),
      ('project-due-reminder',
       'Cada 15 min avisa UNA sola vez al estudiante cuando un proyecto que no ha entregado está por vencer, dentro del lead configurable (por defecto 1 h). No se repite por entrega.')
    ON CONFLICT (jobname) DO UPDATE SET description = EXCLUDED.description, updated_at = now();
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
