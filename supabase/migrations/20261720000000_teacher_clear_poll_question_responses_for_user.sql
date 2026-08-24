-- ══════════════════════════════════════════════════════════════════════
-- El docente borra TODAS las respuestas de un alumno en una encuesta mixta.
--
-- El nombre sigue la familia que ya existe: `clear_poll_question_responses`
-- (el alumno borra las suyas), `teacher_clear_poll_question_response_for_user`
-- (el docente borra UNA de un alumno) y esta, en plural, que borra TODAS.
--
-- Hasta ahora solo existía `teacher_clear_poll_question_response_for_user`,
-- que borra UNA respuesta a UNA pregunta. En una encuesta de 10 preguntas eso
-- son 10 confirmaciones para el caso real —"este alumno respondió por error /
-- pidió empezar de nuevo"—, y el docente tiene que ir a buscar sus chips
-- pregunta por pregunta porque los resultados se agrupan POR PREGUNTA, no por
-- persona.
--
-- Se agrega la versión por ALUMNO en vez de resolverlo con 10 llamadas desde
-- el cliente por dos razones concretas:
--   · Atomicidad. Diez DELETE desde el navegador pueden quedar a mitad —el
--     alumno con 4 de 10 respuestas borradas es un estado que nadie pidió— y
--     la convención de operaciones en lote del repo obliga a reportar el
--     primer error real, o sea a manejar el parcial. Un solo DELETE no tiene
--     estado parcial.
--   · Autorización en UN lugar. Con N llamadas, el permiso se revalida N
--     veces y el borrado parcial ya ocurrió si el permiso cambia en el medio.
--
-- Espeja exactamente los guards de la RPC por pregunta: autenticado, la
-- encuesta existe, y el caller es docente vinculado o Admin del tenant de la
-- encuesta. `_poll_admin_in_tenant` acota la rama de Admin al tenant — sin eso
-- `has_role('Admin')` sería global y un Admin de otra institución podría
-- borrar respuestas acá (la clase de fuga que documenta CLAUDE.md).
--
-- NO valida `poll_is_open` ni `is_published`: el docente tiene que poder
-- limpiar respuestas de una encuesta ya cerrada, que es justo cuando se dan
-- cuenta del error. La RPC por pregunta tampoco lo valida — se mantiene la
-- simetría.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.teacher_clear_poll_question_responses_for_user(
  _poll_id UUID,
  _user_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_caller  UUID := auth.uid();
  v_exists  BOOLEAN;
  v_deleted INT := 0;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.polls WHERE id = _poll_id) INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'Encuesta inexistente' USING ERRCODE = '22023';
  END IF;

  IF NOT (
    public._poll_linked_teacher(_poll_id, v_caller)
    OR public._poll_admin_in_tenant(_poll_id, v_caller)
  ) THEN
    RAISE EXCEPTION 'No tienes permiso para borrar respuestas en esta encuesta'
      USING ERRCODE = '42501';
  END IF;

  -- El filtro por `poll_id` va además del join por pregunta: la columna existe
  -- en la tabla y usarla evita depender solo de la subconsulta.
  DELETE FROM public.poll_question_responses r
   WHERE r.user_id = _user_id
     AND r.poll_id = _poll_id
     AND EXISTS (
       SELECT 1 FROM public.poll_questions q
        WHERE q.id = r.question_id AND q.poll_id = _poll_id
     );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- El `FROM PUBLIC` NO borra la entrada de `anon` que Supabase otorga por
-- ALTER DEFAULT PRIVILEGES, así que va explícito: esta RPC borra datos y no
-- tiene por qué ser invocable sin sesión. El guard de `auth.uid()` del cuerpo
-- la cubriría igual, pero el GRANT sobrante no aporta nada.
REVOKE ALL ON FUNCTION public.teacher_clear_poll_question_responses_for_user(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.teacher_clear_poll_question_responses_for_user(UUID, UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
