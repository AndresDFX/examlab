-- ══════════════════════════════════════════════════════════════════════════
-- El propio firmante puede REHACER su firma (pedido de producto: "poder editar
-- la firma").
--
-- Hasta acá solo existía `teacher_clear_report_signature`, que la usa el
-- DOCENTE/Admin para borrar la firma de OTRA persona y dejarla pendiente de
-- nuevo. No había forma de que el propio estudiante corrigiera un trazo que
-- salió mal sin pedirle a alguien de staff que se lo borre.
--
-- ── Solo la vía AUTENTICADA (`sign_report`), no el enlace público ─────────
-- `sign_report_public` bloquea a propósito re-firmar (20261940000000: "el
-- enlace ES la credencial"). Si `resign_report` aceptara el token público,
-- cualquiera que tuviera el enlace —que puede circular por WhatsApp, un
-- reenvío de correo— podría cambiarle la firma a otra persona después de que
-- ya firmó. La vía autenticada sí lo puede hacer: `auth.uid()` prueba que es
-- la MISMA cuenta que firmó la primera vez.
--
-- ── Por qué es un RPC nuevo y no tocar `sign_report` ───────────────────────
-- `sign_report` es idempotente a propósito (reabrir el enlace/la pantalla y
-- volver a pulsar "Firmar" no debe pisar la firma existente ni cambiar la
-- fecha). Si `sign_report` sobreescribiera cuando `signed_at IS NOT NULL`,
-- un doble-clic accidental correría la fecha de firma sin que la persona lo
-- pidiera. `resign_report` es un acto DELIBERADO distinto: solo se llama
-- desde el botón "Editar firma", nunca desde el flujo normal de firmar.
-- ══════════════════════════════════════════════════════════════════════════

DO $mig$
BEGIN
  IF to_regclass('public.report_signatures') IS NULL THEN
    RAISE NOTICE 'Sin report_signatures: se omite resign_report.';
    RETURN;
  END IF;
END $mig$;

CREATE OR REPLACE FUNCTION public.resign_report(
  _report_id   uuid,
  _user_agent  text DEFAULT NULL,
  _drawing     text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_fila  public.report_signatures%ROWTYPE;
  v_html  text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;

  IF NOT public._signature_drawing_ok(_drawing) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_drawing');
  END IF;

  SELECT * INTO v_fila
    FROM public.report_signatures
   WHERE report_id = _report_id AND user_id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_requested');
  END IF;

  -- Solo tiene sentido "rehacer" sobre una firma que YA existe. Si todavía está
  -- pendiente, el camino normal es `sign_report`.
  IF v_fila.signed_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_signed_yet');
  END IF;

  SELECT gr.html INTO v_html FROM public.generated_reports gr WHERE gr.id = _report_id;

  -- El acto se re-fecha (es una firma nueva, no un parche silencioso sobre la
  -- vieja): `signed_at` y el hash se recalculan igual que en `sign_report`.
  -- `signed_via` se conserva en 'app' porque esta vía SIEMPRE es autenticada.
  UPDATE public.report_signatures
     SET signed_at = now(),
         signed_hash = encode(extensions.digest(COALESCE(v_html, ''), 'sha256'), 'hex'),
         signed_user_agent = left(COALESCE(_user_agent, ''), 400),
         signed_via = 'app',
         signed_drawing = _drawing
   WHERE report_id = _report_id AND user_id = v_uid;

  RETURN jsonb_build_object('ok', true, 'signed_at', now(), 'signed_via', 'app');
END;
$$;

REVOKE ALL ON FUNCTION public.resign_report(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resign_report(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.resign_report(uuid, text, text) TO authenticated;

COMMENT ON FUNCTION public.resign_report(uuid, text, text) IS
  'El propio firmante (auth.uid()) rehace SU firma ya puesta: solo la via autenticada, nunca el enlace publico (que no distingue "el dueno" de "quien tiene el enlace").';

NOTIFY pgrst, 'reload schema';
