-- Duplicar un examen conserva si el portapapeles suma advertencia.
--
-- `clone_exam` enumera A MANO las columnas del INSERT, así que una columna nueva
-- no entra sola: `clipboard_counts_as_warning` (mig 20262600000000) se quedaba
-- en su default y la copia nacía con el interruptor apagado aunque el original
-- lo tuviera encendido. Sin error, sin aviso, y nadie se entera hasta que
-- alguien rinde el duplicado y pegar no cuenta.
--
-- Va gateada por `_copy_proctoring`, igual que `max_warnings`,
-- `navigation_type` y `shuffle_enabled`: es configuración de proctoring, y el
-- diálogo de duplicar ya pregunta si se copia.
--
-- Se reproduce la función entera porque la 20261016000000 ya está aplicada. Al
-- agregar OTRA columna a `exams` que deba viajar en la copia, hay que volver
-- acá: la lista es explícita a propósito, un `SELECT *` copiaría el id.

DO $mig$ BEGIN
  IF to_regclass('public.exams') IS NULL THEN
    RAISE NOTICE 'exams no existe en este entorno: se omite';
    RETURN;
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
    clipboard_counts_as_warning,
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
