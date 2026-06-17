-- ═══════════════════════════════════════════════════════════════════════
-- La fecha FIN de una actividad nunca supera la fecha fin de su curso (DATOS).
--
-- El front ya topa la fecha fin al elegir el curso y al guardar (helper
-- `capEndToCourseEnd`). Esta migración añade el MISMO invariante a nivel de
-- datos: un trigger BEFORE INSERT/UPDATE que CLAMPa (no rechaza) la fecha fin
-- de exámenes (`end_time`), talleres y proyectos (`due_date`) al fin del día de
-- `courses.end_date`. Cubre escrituras que NO pasan por el form (import CSV,
-- clonado, RPC, API directa).
--
-- "Fin del día" = 23:59 en hora local es-CO (America/Bogota), para coincidir
-- bit a bit con el tope del front (la app fija el locale es-CO; ver
-- src/shared/lib/format.ts y date-range.ts). Si el curso no tiene `end_date`,
-- o la actividad no tiene fin, no se toca nada.
--
-- Se usa el `course_id` PRIMARIO de la fila (el ancla). Para actividades
-- multi-curso (workshop_courses / project_courses) el front topa al curso que
-- termina ANTES; este backstop garantiza al menos "≤ fin del curso primario",
-- que siempre es ≥ el tope del front, así que nunca re-topa un valor del front.
-- ═══════════════════════════════════════════════════════════════════════

-- Fin del último día del curso en hora local es-CO, como TIMESTAMPTZ.
CREATE OR REPLACE FUNCTION public._course_end_instant(_course_id UUID)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_end DATE;
BEGIN
  IF _course_id IS NULL THEN RETURN NULL; END IF;
  SELECT end_date INTO v_end FROM public.courses WHERE id = _course_id;
  IF v_end IS NULL THEN RETURN NULL; END IF;
  -- 00:00 del día siguiente en Bogota, menos 1 minuto → 23:59 del último día.
  RETURN ((v_end + 1)::timestamp AT TIME ZONE 'America/Bogota') - interval '1 minute';
END;
$$;

-- Trigger para columna `end_time` (exámenes).
CREATE OR REPLACE FUNCTION public.tg_cap_end_time_to_course()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max TIMESTAMPTZ;
BEGIN
  -- Externos: la fecha es un marcador del evento ya ocurrido (y end=start) — no
  -- se topa, igual que en el front.
  IF COALESCE(NEW.is_external, false) THEN RETURN NEW; END IF;
  IF NEW.course_id IS NULL OR NEW.end_time IS NULL THEN RETURN NEW; END IF;
  v_max := public._course_end_instant(NEW.course_id);
  IF v_max IS NOT NULL AND NEW.end_time > v_max THEN
    NEW.end_time := v_max;
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger para columna `due_date` (talleres y proyectos).
CREATE OR REPLACE FUNCTION public.tg_cap_due_date_to_course()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max TIMESTAMPTZ;
BEGIN
  -- Externos: la fecha es un marcador del evento ya ocurrido — no se topa,
  -- igual que en el front.
  IF COALESCE(NEW.is_external, false) THEN RETURN NEW; END IF;
  IF NEW.course_id IS NULL OR NEW.due_date IS NULL THEN RETURN NEW; END IF;
  v_max := public._course_end_instant(NEW.course_id);
  IF v_max IS NOT NULL AND NEW.due_date > v_max THEN
    NEW.due_date := v_max;
  END IF;
  RETURN NEW;
END;
$$;

-- Enganchar los triggers de forma defensiva (la tabla puede no existir en un
-- entorno desfasado; Lovable a veces marca migraciones aplicadas sin el CREATE).
DO $$
BEGIN
  IF to_regclass('public.exams') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS cap_end_time_to_course ON public.exams;
    CREATE TRIGGER cap_end_time_to_course
      BEFORE INSERT OR UPDATE OF end_time, course_id ON public.exams
      FOR EACH ROW EXECUTE FUNCTION public.tg_cap_end_time_to_course();
  END IF;

  IF to_regclass('public.workshops') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS cap_due_date_to_course ON public.workshops;
    CREATE TRIGGER cap_due_date_to_course
      BEFORE INSERT OR UPDATE OF due_date, course_id ON public.workshops
      FOR EACH ROW EXECUTE FUNCTION public.tg_cap_due_date_to_course();
  END IF;

  IF to_regclass('public.projects') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS cap_due_date_to_course ON public.projects;
    CREATE TRIGGER cap_due_date_to_course
      BEFORE INSERT OR UPDATE OF due_date, course_id ON public.projects
      FOR EACH ROW EXECUTE FUNCTION public.tg_cap_due_date_to_course();
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
