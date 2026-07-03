-- ══════════════════════════════════════════════════════════════════════
-- enqueue_ai_grading: al DEDUPLICAR un job activo reusaba su id SIN actualizar el
-- body. En modo async (default), un re-envío de proyecto/taller (permitido mientras
-- la entrega sigue 'entregado' sin nota) hacía upsert del CONTENIDO NUEVO en las
-- filas de respuestas, pero el job encolado seguía con el body (respuestas VIEJAS)
-- de la 1ª entrega. El worker califica body.items → escribía notas de las respuestas
-- viejas sobre la entrega nueva (corrupción silenciosa de la nota).
--
-- Fix: si el job reusado está 'pending' (aún no lo tomó el worker), REFRESCAR su
-- body + resetear attempts/last_error/started_at → califica el contenido ACTUAL.
-- Si está 'processing' el worker ya leyó el body (ventana estrecha, worker horario):
-- lo dejamos como está (no se puede des-leer). Cubre todos los callers (project_full,
-- workshop_full, exam_question, codigo_zip) en un solo lugar. Migración forward.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.enqueue_ai_grading(_kind text, _invoke_target text, _body jsonb, _target_table text, _target_row_id uuid, _field_grade text DEFAULT 'ai_grade'::text, _field_feedback text DEFAULT 'ai_feedback'::text, _field_likelihood text DEFAULT NULL::text, _field_reasons text DEFAULT NULL::text, _course_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  _new_id UUID;
  _status TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  -- Dedup: si ya hay un job ACTIVO (pending/processing) para este mismo
  -- target + kind, reusarlo en vez de crear un duplicado. Un re-grade tras
  -- done/cancelled/rejected SÍ encola (esos estados no entran en el filtro).
  SELECT id, status INTO _new_id, _status
    FROM public.ai_grading_queue
   WHERE target_table = _target_table
     AND target_row_id = _target_row_id
     AND kind = _kind
     AND status IN ('pending', 'processing')
   ORDER BY created_at ASC
   LIMIT 1;
  IF _new_id IS NOT NULL THEN
    -- Re-envío: si el job aún no fue tomado por el worker, refrescamos el body
    -- para que califique el CONTENIDO ACTUAL (antes reusaba el body de la 1ª
    -- entrega → calificaba respuestas viejas sobre la entrega nueva).
    IF _status = 'pending' THEN
      UPDATE public.ai_grading_queue
         SET body = _body, attempts = 0, last_error = NULL, started_at = NULL
       WHERE id = _new_id;
    END IF;
    RETURN _new_id;
  END IF;
  BEGIN
    INSERT INTO public.ai_grading_queue (
      kind, invoke_target, body,
      target_table, target_row_id,
      field_grade, field_feedback, field_likelihood, field_reasons,
      course_id, created_by, status
    ) VALUES (
      _kind, _invoke_target, _body,
      _target_table, _target_row_id,
      _field_grade, _field_feedback, _field_likelihood, _field_reasons,
      _course_id, auth.uid(), 'pending'
    ) RETURNING id INTO _new_id;
  EXCEPTION WHEN unique_violation THEN
    -- Carrera: otro encoló el mismo target+kind entre el SELECT y el INSERT.
    -- Devolvemos el job ganador en vez de fallar (refrescando su body si pending).
    SELECT id, status INTO _new_id, _status
      FROM public.ai_grading_queue
     WHERE target_table = _target_table
       AND target_row_id = _target_row_id
       AND kind = _kind
       AND status IN ('pending', 'processing')
     ORDER BY created_at ASC
     LIMIT 1;
    IF _new_id IS NOT NULL AND _status = 'pending' THEN
      UPDATE public.ai_grading_queue
         SET body = _body, attempts = 0, last_error = NULL, started_at = NULL
       WHERE id = _new_id;
    END IF;
  END;
  RETURN _new_id;
END
$function$;

NOTIFY pgrst, 'reload schema';
