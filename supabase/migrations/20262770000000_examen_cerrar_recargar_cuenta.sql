-- Que cerrar o recargar el examen cuente como advertencia, por EXAMEN.
--
-- ── Por qué existe ───────────────────────────────────────────────────────
--
-- Hasta el 2026-10-08 cerrar o recargar la página del examen SUMABA una
-- advertencia, y al llegar al tope cerraba el intento. Era la más injusta de
-- todas: el corte puede ser un cuelgue del navegador, un apagón o que se cayó el
-- internet, y ese camino ni siquiera dejaba un evento en `__warning_events`, así
-- que el docente veía «3/3» con dos eventos listados y no podía perdonar la
-- tercera. Desde ese día salir y volver solo se ANOTA (evento
-- `salida_de_la_pagina` con `suma = false`) y el monitor muestra cuántas veces
-- pasó; lo decide el cliente en `cuerpoAlSalirDeLaPagina`
-- (src/modules/exams/proctoring.ts).
--
-- ── OPT-IN ───────────────────────────────────────────────────────────────
--
-- Esta columna es para el docente que lo quiera estricto. `DEFAULT false`: con
-- el interruptor apagado ningún examen existente cambia respecto de lo
-- publicado el 2026-10-08. Encendido, cada salida suma una advertencia —ahora
-- con su evento (`suma = true`), así que se puede perdonar— y al tope cierra el
-- intento como cualquier strike.
--
-- Las recargas que pide la PROPIA plataforma (versión nueva, archivo viejo)
-- no cuentan nunca: el cliente las marca (`recarga-propia.ts`).
--
-- ── Un cierre por advertencias también se califica ──────────────────────
--
-- Con la opción encendida, la salida que llega al tope cierra el intento desde
-- `beforeunload`, en un fetch keepalive: no queda ningún cliente que después
-- encole la calificación, y el cron de vencimientos solo mira `en_progreso`.
-- Es el mismo agujero que la mig 20262250000000 cerró para el cron y el cierre
-- del docente. Se cierra igual, en la base: un trigger encola en la TRANSICIÓN
-- a cerrado por advertencias. La suspensión normal (`performSubmit`) también
-- cierra con 'advertencias' y encola desde el cliente con el MISMO kind, y los
-- dos encoladores deduplican por (entrega, kind): no se califica dos veces. El
-- aviso al docente de esa suspensión sigue siendo del cliente; en la salida
-- por cierre de página no hay quien lo mande, y el docente la ve en el monitor.
--
-- ── `clone_exam` ─────────────────────────────────────────────────────────
--
-- Enumera A MANO las columnas del INSERT (ver la mig 20262610000000), así que
-- se reproduce entera para que la copia conserve el interruptor. Va gateado por
-- `_copy_proctoring`, como el resto de la configuración de supervisión. De paso
-- copia `allow_exam_notes` (notas de apoyo), que se quedaba en su default
-- (permitidas) aunque el original las tuviera desactivadas.

DO $mig$
BEGIN
  IF to_regclass('public.exams') IS NOT NULL THEN
    ALTER TABLE public.exams
      ADD COLUMN IF NOT EXISTS reload_counts_as_warning boolean NOT NULL DEFAULT false;

    COMMENT ON COLUMN public.exams.reload_counts_as_warning IS
      'Si cerrar o recargar la pagina del examen suma advertencia. Default false: salir y volver solo se anota (evento salida_de_la_pagina). Ver cuerpoAlSalirDeLaPagina en src/modules/exams/proctoring.ts.';
  ELSE
    RAISE NOTICE 'exams no existe en este entorno: se omite';
  END IF;
END $mig$;

CREATE OR REPLACE FUNCTION public.clone_exam(_source_id uuid, _target_course_id uuid, _new_title text DEFAULT NULL::text, _new_start_time timestamp with time zone DEFAULT NULL::timestamp with time zone, _new_end_time timestamp with time zone DEFAULT NULL::timestamp with time zone, _copy_questions boolean DEFAULT true, _copy_proctoring boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _new_id UUID;
  _final_title TEXT;
  _final_start TIMESTAMPTZ;
  _final_end TIMESTAMPTZ;
BEGIN
  IF NOT (
    (
      public.is_admin_of_course_tenant((SELECT e.course_id FROM public.exams e WHERE e.id = _source_id))
      AND public.is_admin_of_course_tenant(_target_course_id)
    )
    OR (
      EXISTS (
        SELECT 1 FROM public.exams e
        JOIN public.course_teachers ct ON ct.course_id = e.course_id
        WHERE e.id = _source_id AND ct.user_id = auth.uid()
      )
      AND EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = _target_course_id AND ct.user_id = auth.uid()
      )
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para clonar este examen al curso destino';
  END IF;

  -- Papelera: no se puede clonar un examen origen en la papelera (defensa
  -- server-side; el chooser del cliente ya filtra deleted_at, esto cubre ids
  -- stale / llamadas directas a la API).
  IF (SELECT e.deleted_at FROM public.exams e WHERE e.id = _source_id) IS NOT NULL THEN
    RAISE EXCEPTION 'No se puede clonar: el examen origen está en la papelera';
  END IF;

  SELECT
    COALESCE(_new_title, 'Copia de ' || e.title),
    COALESCE(_new_start_time, e.start_time),
    COALESCE(_new_end_time, e.end_time)
    INTO _final_title, _final_start, _final_end
    FROM public.exams e WHERE e.id = _source_id;

  INSERT INTO public.exams (
    course_id, created_by, title, description, time_limit_minutes, navigation_type,
    shuffle_enabled, start_time, end_time, status, max_warnings,
    clipboard_counts_as_warning, reload_counts_as_warning, allow_exam_notes,
    weight, max_attempts, retry_mode, is_external, schedule_type,
    cut_id
  )
  SELECT
    _target_course_id, auth.uid(), _final_title, e.description, e.time_limit_minutes,
    CASE WHEN _copy_proctoring THEN e.navigation_type ELSE 'libre' END,
    CASE WHEN _copy_proctoring THEN e.shuffle_enabled ELSE false END,
    _final_start, _final_end, 'draft',
    CASE WHEN _copy_proctoring THEN e.max_warnings ELSE 3 END,
    -- Va con el resto del proctoring, no suelto: si el docente pidió NO copiar
    -- esa configuración, la copia nace con el default (apagado).
    CASE WHEN _copy_proctoring THEN e.clipboard_counts_as_warning ELSE false END,
    CASE WHEN _copy_proctoring THEN e.reload_counts_as_warning ELSE false END,
    CASE WHEN _copy_proctoring THEN e.allow_exam_notes ELSE true END,
    e.weight, e.max_attempts, e.retry_mode, e.is_external, e.schedule_type,
    CASE WHEN _target_course_id = e.course_id THEN e.cut_id ELSE NULL END
  FROM public.exams e WHERE e.id = _source_id
  RETURNING id INTO _new_id;

  IF _copy_questions THEN
    INSERT INTO public.questions (
      exam_id, type, content, options, expected_rubric, language, starter_code,
      points, position
    )
    SELECT
      _new_id, q.type, q.content, q.options, q.expected_rubric, q.language, q.starter_code,
      q.points, q.position
    FROM public.questions q
    WHERE q.exam_id = _source_id;
  END IF;

  RETURN _new_id;
END
$function$;

-- ── Trigger: encolar la calificación de un cierre por advertencias ─────────
CREATE OR REPLACE FUNCTION public.tg_encolar_cierre_por_advertencias()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $fn$
BEGIN
  -- Un fallo al encolar NO puede revertir el cierre: el cierre es lo que
  -- protege la integridad del examen. Misma regla que el cron.
  BEGIN
    PERFORM public.enqueue_attempt_grading(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'No se pudo encolar la calificacion del intento %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION public.tg_encolar_cierre_por_advertencias() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tg_encolar_cierre_por_advertencias() FROM anon;

DO $mig$
BEGIN
  IF to_regclass('public.submissions') IS NULL
     OR to_regprocedure('public.enqueue_attempt_grading(uuid)') IS NULL THEN
    RAISE NOTICE 'submissions o enqueue_attempt_grading no existen en este entorno: se omite el trigger';
    RETURN;
  END IF;

  DROP TRIGGER IF EXISTS trg_encolar_cierre_por_advertencias ON public.submissions;
  -- `OF closed_at`: solo corre cuando un UPDATE escribe esa columna. Los
  -- guardados del examen (respuestas, latido) no la tocan, así que no se paga
  -- nada en cada uno.
  CREATE TRIGGER trg_encolar_cierre_por_advertencias
    AFTER UPDATE OF closed_at ON public.submissions
    FOR EACH ROW
    WHEN (OLD.closed_at IS NULL
          AND NEW.closed_at IS NOT NULL
          AND NEW.close_reason = 'advertencias')
    EXECUTE FUNCTION public.tg_encolar_cierre_por_advertencias();
END
$mig$;
