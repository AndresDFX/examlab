-- ──────────────────────────────────────────────────────────────────────
-- RPC: teacher_clear_poll_response_for_user
--
-- Permite al docente del curso (o Admin / SuperAdmin) borrar TODAS las
-- respuestas de UN alumno específico en UNA encuesta. Caso de uso:
-- un alumno eligió una fecha de sustentación pero después tiene un
-- conflicto y necesita re-elegir. Sin esta RPC, las opciones serían:
--   - El alumno cambia su voto él mismo — pero requiere que la encuesta
--     tenga `allow_change_response = true`. Si está bloqueada, no puede.
--   - El docente edita la encuesta para abrir el lock — afecta a TODOS.
--   - Borrar la encuesta y recrear — destructivo.
--
-- Esta RPC es quirúrgica: borra solo las respuestas de un (poll, user)
-- y deja al alumno libre de re-votar la próxima vez que entre. El cupo
-- liberado pasa al `responses_count` denormalizado vía el trigger
-- `_tg_poll_response_count_sync`.
--
-- Autorización: docente del curso (vía `poll_courses` → `course_teachers`),
-- o Admin / SuperAdmin. RPC SECURITY DEFINER porque la RLS de
-- `poll_responses` bloquea DELETE directos (solo se permite via la
-- otra RPC `clear_poll_response`, que valida que el deletor sea el
-- propio alumno).
--
-- Retorna el conteo de filas borradas (0 si el alumno no había votado).
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.teacher_clear_poll_response_for_user(
  _poll_id UUID,
  _user_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller UUID := auth.uid();
  _is_authorized BOOLEAN := false;
  _deleted INT := 0;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
  END IF;

  -- Admin / SuperAdmin: bypass.
  IF public.has_role(_caller, 'Admin'::public.app_role) OR public.is_super_admin() THEN
    _is_authorized := true;
  ELSE
    -- Docente: debe dictar AL MENOS UNO de los cursos linkeados a la
    -- encuesta (via poll_courses junction). Esto es consistente con
    -- la WRITE policy del poll: si puede editar el poll, puede
    -- también gestionar respuestas.
    SELECT EXISTS (
      SELECT 1
        FROM public.poll_courses pc
        JOIN public.course_teachers ct ON ct.course_id = pc.course_id
       WHERE pc.poll_id = _poll_id AND ct.user_id = _caller
    ) INTO _is_authorized;
  END IF;

  IF NOT _is_authorized THEN
    RAISE EXCEPTION 'No tienes permiso para borrar respuestas en esta encuesta'
      USING ERRCODE = '42501';
  END IF;

  -- Borramos. El trigger AFTER DELETE actualiza `responses_count` y
  -- libera el cupo. No tocamos `closed_manually` ni otros campos del
  -- poll — si la encuesta estaba auto-cerrada porque "todos votaron"
  -- y ahora deja de cumplirse, el docente puede reabrirla manualmente.
  DELETE FROM public.poll_responses
   WHERE poll_id = _poll_id AND user_id = _user_id;

  GET DIAGNOSTICS _deleted = ROW_COUNT;
  RETURN _deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_clear_poll_response_for_user(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.teacher_clear_poll_response_for_user(UUID, UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
