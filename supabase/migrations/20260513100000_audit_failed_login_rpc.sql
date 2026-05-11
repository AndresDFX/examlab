-- ──────────────────────────────────────────────────────────────────────
-- RPC público `log_failed_login(p_email, p_reason)` para registrar
-- intentos fallidos de login. El usuario aún no está autenticado, así
-- que no podemos usar la RPC normal `log_audit_event` (que depende de
-- auth.uid()). Esta RPC es SECURITY DEFINER, expuesta a anon, e inserta
-- una fila marcada con actor_email = el email intentado.
--
-- Riesgo: un atacante puede inflar la tabla llamando esta RPC en loop.
-- Mitigamos con CHECK de longitud + actor_role hardcoded 'Anónimo'.
-- Si en el futuro vemos abuso, agregamos rate-limit a nivel pg.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.log_failed_login(
  p_email  text,
  p_reason text DEFAULT NULL
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  IF p_email IS NULL OR length(p_email) > 320 THEN
    RETURN;
  END IF;
  INSERT INTO public.audit_logs (
    actor_id, actor_email, actor_role,
    action, category, severity,
    entity_type, entity_id, entity_name,
    metadata
  ) VALUES (
    NULL, p_email, 'Anónimo',
    'user.login_failed', 'user', 'warning',
    'user', NULL, p_email,
    jsonb_build_object('reason', COALESCE(p_reason, 'invalid_credentials'))
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.log_failed_login(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_failed_login(text, text) TO anon, authenticated;
