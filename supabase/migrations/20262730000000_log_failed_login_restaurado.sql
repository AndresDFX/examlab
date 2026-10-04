-- ----------------------------------------------------------------------
-- Registro de inicios de sesión FALLIDOS — restaurado.
--
-- La pantalla de login llama `log_failed_login(p_email, p_reason)` en cada
-- intento fallido (auth.index.tsx). La función la creó la mig
-- 20260513100000, pero NO existe en esta base (es de la época en que
-- Lovable aplicaba migraciones; la base actual nunca la recibió): PostgREST
-- responde PGRST202, el cliente lo traga en silencio, y en `audit_logs` no
-- hay UN solo `user.login_failed`, de nadie, nunca. Se notó al investigar a
-- un estudiante que «no puede entrar hasta que le restablecen la clave»: sin
-- los fallos registrados no hay forma de ver qué está escribiendo.
--
-- Diferencia con la original: si el correo pertenece a una cuenta, la fila
-- lleva su `tenant_id` y su id en `entity_id`. Sin tenant, la RLS de
-- auditoría solo se la muestra al SuperAdmin, y el Admin de la institución
-- —que es quien atiende al estudiante— no la vería.
--
-- Riesgo conocido (el mismo de la original): un anónimo puede inflar la
-- tabla llamándola en bucle. Se acota la longitud de los parámetros.
-- ----------------------------------------------------------------------

DO $mig$
BEGIN
  IF to_regclass('public.audit_logs') IS NULL OR to_regclass('public.profiles') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE $fn$
  CREATE OR REPLACE FUNCTION public.log_failed_login(
    p_email  text,
    p_reason text DEFAULT NULL
  )
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $body$
  DECLARE
    v_email  text := lower(btrim(coalesce(p_email, '')));
    v_user   uuid;
    v_tenant uuid;
  BEGIN
    IF v_email = '' OR length(v_email) > 320 THEN
      RETURN;
    END IF;

    SELECT p.id, p.tenant_id INTO v_user, v_tenant
      FROM public.profiles p
     WHERE lower(p.institutional_email) = v_email
        OR lower(p.personal_email) = v_email
     LIMIT 1;

    INSERT INTO public.audit_logs (
      actor_id, actor_email, actor_role,
      action, category, severity,
      entity_type, entity_id, entity_name,
      metadata, tenant_id
    ) VALUES (
      NULL, v_email, 'Anónimo',
      'user.login_failed', 'user', 'warning',
      'user', v_user, v_email,
      jsonb_build_object(
        'reason', left(coalesce(p_reason, 'invalid_credentials'), 300),
        'cuenta_existe', v_user IS NOT NULL
      ),
      v_tenant
    );
  EXCEPTION WHEN OTHERS THEN
    -- Registrar un fallo nunca debe romper el login.
    NULL;
  END;
  $body$;
  $fn$;

  REVOKE ALL ON FUNCTION public.log_failed_login(text, text) FROM PUBLIC;
  -- anon a propósito: quien falla al iniciar sesión todavía no tiene sesión.
  GRANT EXECUTE ON FUNCTION public.log_failed_login(text, text) TO anon, authenticated;
END
$mig$;
