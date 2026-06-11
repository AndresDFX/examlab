-- ════════════════════════════════════════════════════════════════════
-- Permitir REASIGNAR cupos (mover un alumno a otro slot) en encuestas CERRADAS.
--
-- Motivo: tras cerrar una encuesta de cupos (Doodle), el docente a veces
-- necesita corregir la asignación de un alumno —ej. un conflicto de horario
-- detectado después del cierre— sin tener que reabrir la encuesta para todos.
-- El RPC `teacher_reassign_poll_response` bloqueaba esto con un check de
-- `poll_is_open`. Lo quitamos SOLO de la reasignación.
--
-- Se mantiene todo lo demás:
--   - Autorización scopeada al tenant (_poll_linked_teacher / _poll_admin_in_tenant).
--   - Restricción a encuestas de tipo 'slot'.
--   - CLAIM ATÓMICO del cupo destino (responses_count < max_responses + FOR
--     UPDATE) → sigue SIN permitir sobrecupo, esté abierta o cerrada.
--
-- NO se cambia `teacher_assign_remaining_to_slots`: la asignación MASIVA de los
-- estudiantes que no respondieron sigue requiriendo la encuesta abierta (es una
-- acción distinta de "reasignar"). Si más adelante se quiere habilitar también
-- en cerradas, se quita su check de poll_is_open de forma análoga.
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.teacher_reassign_poll_response(
  _poll_id UUID,
  _user_id UUID,
  _to_option_id UUID
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _caller UUID := auth.uid();
  v_poll public.polls;
  v_opt public.poll_options;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_poll FROM public.polls WHERE id = _poll_id;
  IF v_poll.id IS NULL THEN RAISE EXCEPTION 'Encuesta inexistente' USING ERRCODE = '22023'; END IF;

  -- Autorización scopeada al tenant (no el has_role('Admin') laxo).
  IF NOT (public._poll_linked_teacher(_poll_id, _caller) OR public._poll_admin_in_tenant(_poll_id, _caller)) THEN
    RAISE EXCEPTION 'No tienes permiso para gestionar respuestas en esta encuesta' USING ERRCODE = '42501';
  END IF;

  -- NOTA: a diferencia de antes, NO bloqueamos si la encuesta está cerrada.
  -- Reasignar un cupo es una corrección puntual que el docente debe poder
  -- hacer también post-cierre. El claim atómico de abajo evita sobrecupo.

  IF v_poll.poll_type <> 'slot' THEN
    RAISE EXCEPTION 'Esta acción solo aplica a encuestas de cupos' USING ERRCODE = 'P0001';
  END IF;

  -- El cupo destino debe pertenecer a esta encuesta y tener capacidad.
  SELECT * INTO v_opt FROM public.poll_options WHERE id = _to_option_id AND poll_id = _poll_id;
  IF v_opt.id IS NULL THEN
    RAISE EXCEPTION 'El cupo destino no pertenece a esta encuesta' USING ERRCODE = '22023';
  END IF;
  IF v_opt.max_responses IS NULL THEN
    RAISE EXCEPTION 'El cupo destino no tiene capacidad configurada' USING ERRCODE = '22023';
  END IF;

  -- CLAIM ATÓMICO del cupo destino: si otra respuesta lo llenó en el instante
  -- → NOT FOUND → rechazamos SIN sobrecupo.
  PERFORM 1 FROM public.poll_options
    WHERE id = _to_option_id AND responses_count < max_responses
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El cupo ya ha sido ocupado por otra respuesta' USING ERRCODE = 'P0001';
  END IF;

  -- Mover = DELETE viejo (decrementa origen) + INSERT nuevo (incrementa destino),
  -- ambos vía el trigger de conteo (que solo dispara en INSERT/DELETE).
  DELETE FROM public.poll_responses WHERE poll_id = _poll_id AND user_id = _user_id;
  INSERT INTO public.poll_responses (poll_id, option_id, user_id)
       VALUES (_poll_id, _to_option_id, _user_id);
END $$;
REVOKE ALL ON FUNCTION public.teacher_reassign_poll_response(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.teacher_reassign_poll_response(UUID, UUID, UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
