-- ══════════════════════════════════════════════════════════════════════
-- change_poll_response: cambio de voto ATÓMICO para encuestas single/slot.
--
-- El cliente hacía DOS RPCs (clear_poll_response + vote_poll_option) en
-- transacciones separadas. Si el 2º fallaba (red, encuesta cerrada, o —en slot—
-- el cupo destino se llenó por carrera), el voto/reserva previo YA estaba
-- borrado irreversiblemente → el alumno quedaba SIN respuesta y su slot liberado
-- se lo llevaba otro. Este RPC hace DELETE+INSERT en UNA transacción (con claim
-- atómico del cupo destino ANTES de mutar), espejando teacher_reassign_poll_response:
-- si el destino no tiene cupo o el INSERT falla → ROLLBACK → el voto original
-- queda intacto.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.change_poll_response(_poll_id uuid, _new_option_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_poll public.polls;
  v_opt public.poll_options;
  v_enrolled BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_poll FROM public.polls WHERE id = _poll_id;
  IF v_poll.id IS NULL THEN
    RAISE EXCEPTION 'Encuesta inexistente' USING ERRCODE = '22023';
  END IF;
  IF NOT v_poll.is_published THEN
    RAISE EXCEPTION 'Esta encuesta todavía es un borrador' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.poll_is_open(v_poll) THEN
    RAISE EXCEPTION 'La encuesta está cerrada' USING ERRCODE = 'P0001';
  END IF;
  -- Matrícula (mismo check que vote_poll_option).
  SELECT EXISTS (
    SELECT 1
      FROM public.poll_courses pc
      JOIN public.course_enrollments ce ON ce.course_id = pc.course_id
     WHERE pc.poll_id = v_poll.id AND ce.user_id = v_uid
  ) INTO v_enrolled;
  IF NOT v_enrolled THEN
    RAISE EXCEPTION 'No estás matriculado en ningún curso de esta encuesta'
      USING ERRCODE = '42501';
  END IF;
  -- La opción destino debe pertenecer a ESTA encuesta.
  SELECT * INTO v_opt FROM public.poll_options WHERE id = _new_option_id AND poll_id = _poll_id;
  IF v_opt.id IS NULL THEN
    RAISE EXCEPTION 'La opción destino no pertenece a esta encuesta' USING ERRCODE = '22023';
  END IF;
  -- Slot: claim atómico del destino ANTES de borrar el voto viejo. Si se llenó
  -- por carrera → NOT FOUND → RAISE → ROLLBACK → el voto original se preserva.
  IF v_poll.poll_type = 'slot' THEN
    IF v_opt.max_responses IS NULL THEN
      RAISE EXCEPTION 'La opción no tiene cupo configurado' USING ERRCODE = '22023';
    END IF;
    PERFORM 1 FROM public.poll_options
      WHERE id = _new_option_id AND responses_count < max_responses
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cupo agotado para esta opción' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  -- DELETE (decrementa conteo del origen vía trigger) + INSERT (incrementa el
  -- destino). El enforce_single ve 0 respuestas al insertar (borramos antes).
  DELETE FROM public.poll_responses WHERE poll_id = _poll_id AND user_id = v_uid;
  INSERT INTO public.poll_responses (poll_id, option_id, user_id)
       VALUES (_poll_id, _new_option_id, v_uid);
END
$function$;

REVOKE ALL ON FUNCTION public.change_poll_response(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.change_poll_response(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
