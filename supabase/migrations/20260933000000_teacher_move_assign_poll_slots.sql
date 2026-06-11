-- ════════════════════════════════════════════════════════════════════
-- Gestión de cupos en tiempo real (encuestas tipo slot) — acciones del docente.
--
-- NO hay backend de sockets: la "actualización en tiempo real de todas las
-- pantallas" la da Supabase Realtime (poll_responses/poll_options publicados
-- con REPLICA IDENTITY FULL, mig 20260721000000) — usePollRealtime ya re-pide
-- estado en host y alumno ante cualquier INSERT/DELETE de poll_responses, así
-- que mover/asignar desde el docente refleja en la vista del alumno SIN
-- recargar. Acá solo agregamos las escrituras server-side (atómicas).
--
-- RPCs:
--  1. teacher_reassign_poll_response(_poll_id,_user_id,_to_option_id): mueve a
--     un alumno (que ya respondió o no) al cupo destino. CLAIM ATÓMICO del
--     destino (FOR UPDATE + responses_count<max) → si se llenó en el instante,
--     rechaza con "El cupo ya ha sido ocupado por otra respuesta" (revierte en
--     el front). Mover = DELETE viejo + INSERT nuevo (el trigger de conteo solo
--     dispara en INSERT/DELETE, NO en UPDATE de option_id). Bloquea sobrecupo y
--     encuesta cerrada.
--  2. teacher_assign_remaining_to_slots(_poll_id): asigna los matriculados que
--     NO respondieron a los cupos libres (claim atómico por cupo, por position),
--     sin exceder max_responses. Devuelve cuántos asignó.
--
-- Autorización (ambos): docente de un curso linkeado (_poll_linked_teacher) o
-- Admin del tenant de la encuesta / SuperAdmin (_poll_admin_in_tenant). NO el
-- has_role('Admin') laxo — eso fugaba cross-tenant (ver 20260932000000). De
-- paso re-scopeamos el bypass laxo del RPC viejo teacher_clear_poll_response_for_user.
-- ════════════════════════════════════════════════════════════════════

-- ── 1) Mover/reasignar un alumno a otro cupo ─────────────────────────
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

  -- Estado de la encuesta: bloquear movimientos si está cerrada/finalizada.
  IF NOT public.poll_is_open(v_poll) THEN
    RAISE EXCEPTION 'La encuesta está cerrada' USING ERRCODE = 'P0001';
  END IF;

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

  -- CLAIM ATÓMICO del cupo destino (mismo patrón que vote_poll_option): el
  -- FOR UPDATE bajo READ COMMITTED re-evalúa el predicado tras tomar el lock,
  -- así que si otra respuesta llenó el cupo en el instante → NOT FOUND →
  -- rechazamos SIN sobrecupo. El lock se sostiene hasta el commit, bloqueando
  -- a votantes concurrentes sobre el mismo cupo.
  PERFORM 1 FROM public.poll_options
    WHERE id = _to_option_id AND responses_count < max_responses
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El cupo ya ha sido ocupado por otra respuesta' USING ERRCODE = 'P0001';
  END IF;

  -- Mover = borrar la respuesta vieja (decrementa origen vía trigger) + crear
  -- la nueva (incrementa destino vía trigger). NO un UPDATE de option_id: el
  -- trigger _tg_poll_response_count_sync solo dispara en INSERT/DELETE. El
  -- trigger _tg_poll_response_enforce_single tolera esto (borramos antes).
  DELETE FROM public.poll_responses WHERE poll_id = _poll_id AND user_id = _user_id;
  INSERT INTO public.poll_responses (poll_id, option_id, user_id)
       VALUES (_poll_id, _to_option_id, _user_id);
END $$;
REVOKE ALL ON FUNCTION public.teacher_reassign_poll_response(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.teacher_reassign_poll_response(UUID, UUID, UUID) TO authenticated;

-- ── 2) Asignar masivamente los estudiantes que NO respondieron ───────
CREATE OR REPLACE FUNCTION public.teacher_assign_remaining_to_slots(_poll_id UUID)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _caller UUID := auth.uid();
  v_poll public.polls;
  v_assigned INT := 0;
  v_student UUID;
  v_slot UUID;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_poll FROM public.polls WHERE id = _poll_id;
  IF v_poll.id IS NULL THEN RAISE EXCEPTION 'Encuesta inexistente' USING ERRCODE = '22023'; END IF;

  IF NOT (public._poll_linked_teacher(_poll_id, _caller) OR public._poll_admin_in_tenant(_poll_id, _caller)) THEN
    RAISE EXCEPTION 'No tienes permiso para gestionar respuestas en esta encuesta' USING ERRCODE = '42501';
  END IF;
  IF NOT public.poll_is_open(v_poll) THEN
    RAISE EXCEPTION 'La encuesta está cerrada' USING ERRCODE = 'P0001';
  END IF;
  IF v_poll.poll_type <> 'slot' THEN
    RAISE EXCEPTION 'Esta acción solo aplica a encuestas de cupos' USING ERRCODE = 'P0001';
  END IF;

  -- Matriculados en CUALQUIER curso linkeado que NO han respondido. Orden
  -- estable (joined_at, user_id) para reparto determinista.
  FOR v_student IN
    SELECT ce.user_id
      FROM public.poll_courses pc
      JOIN public.course_enrollments ce ON ce.course_id = pc.course_id
     WHERE pc.poll_id = _poll_id
       AND NOT EXISTS (
         SELECT 1 FROM public.poll_responses pr
          WHERE pr.poll_id = _poll_id AND pr.user_id = ce.user_id
       )
     GROUP BY ce.user_id
     ORDER BY min(ce.created_at) NULLS LAST, ce.user_id
  LOOP
    -- Primer cupo con espacio (por position). FOR UPDATE SKIP LOCKED: si un
    -- votante está reclamando ese cupo justo ahora, lo saltamos (no esperamos
    -- ni arriesgamos sobrecupo). responses_count lo mantiene el trigger, así
    -- que la siguiente iteración ve el conteo ya incrementado.
    SELECT id INTO v_slot
      FROM public.poll_options
     WHERE poll_id = _poll_id AND max_responses IS NOT NULL AND responses_count < max_responses
     ORDER BY position
     FOR UPDATE SKIP LOCKED
     LIMIT 1;
    IF v_slot IS NULL THEN
      EXIT;  -- no quedan cupos libres → dejamos al resto sin asignar
    END IF;
    INSERT INTO public.poll_responses (poll_id, option_id, user_id)
         VALUES (_poll_id, v_slot, v_student);
    v_assigned := v_assigned + 1;
  END LOOP;

  RETURN v_assigned;
END $$;
REVOKE ALL ON FUNCTION public.teacher_assign_remaining_to_slots(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.teacher_assign_remaining_to_slots(UUID) TO authenticated;

-- ── 3) Re-scope del bypass laxo del RPC existente ────────────────────
-- teacher_clear_poll_response_for_user usaba has_role('Admin') laxo (mismo
-- leak cross-tenant que 20260932000000 cerró en RLS). Lo scopeamos al tenant.
CREATE OR REPLACE FUNCTION public.teacher_clear_poll_response_for_user(
  _poll_id UUID,
  _user_id UUID
)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _caller UUID := auth.uid();
  _deleted INT := 0;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501'; END IF;
  IF NOT (public._poll_linked_teacher(_poll_id, _caller) OR public._poll_admin_in_tenant(_poll_id, _caller)) THEN
    RAISE EXCEPTION 'No tienes permiso para borrar respuestas en esta encuesta' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.poll_responses WHERE poll_id = _poll_id AND user_id = _user_id;
  GET DIAGNOSTICS _deleted = ROW_COUNT;
  RETURN _deleted;
END $$;
REVOKE ALL ON FUNCTION public.teacher_clear_poll_response_for_user(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.teacher_clear_poll_response_for_user(UUID, UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
