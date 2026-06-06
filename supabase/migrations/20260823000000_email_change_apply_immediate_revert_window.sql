-- ──────────────────────────────────────────────────────────────────────
-- Email change: aplicar INMEDIATO + ventana de 24h para REVERTIR.
--
-- Antes (mig 20260802000000): confirmar el cambio marcaba confirmed_at
-- y agendaba apply_after=NOW+24h. El cron aplicaba a las 24h. UX:
-- usuario espera 24h para ver el correo nuevo.
--
-- Ahora: confirmar aplica YA en auth.users + profiles. La ventana de
-- 24h pasa a ser para REVERTIR si el cambio fue malicioso. Si dentro
-- de 24h el dueño del correo ANTERIOR clickea el link de revert,
-- restauramos auth.users.email al previous_email. Pasadas las 24h, el
-- cambio es firme.
--
-- Beneficio: UX inmediata (no esperar 24h) sin sacrificar la ventana
-- defensiva contra toma de cuenta — el dueño legítimo tiene el mismo
-- tiempo para detectar y revertir.
--
-- Cambios:
--  1. Nueva columna `previous_email` para guardar el email antes del
--     cambio (necesario para poder revertir).
--  2. Nueva columna `reverted_at` para marcar reversion.
--  3. Función `apply_email_change_now(token_id, current_email)` —
--     aplica el cambio inmediato + retorna previous_email.
--  4. Función `revert_email_change_to_previous(cancel_token)` — revierte
--     un cambio aplicado dentro de la ventana de 24h.
--  5. Cron job legacy (`apply_pending_email_changes_15min`) ya no
--     aplica nada (no quedan pendientes); lo dejamos como no-op por
--     compat. Si querés desactivarlo, podés con
--     SELECT cron.unschedule('apply_pending_email_changes_15min').
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) previous_email + reverted_at ───────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.email_change_tokens') IS NULL THEN
    RAISE NOTICE 'email_change_tokens no existe — se omite la migración';
    RETURN;
  END IF;

  ALTER TABLE public.email_change_tokens
    ADD COLUMN IF NOT EXISTS previous_email TEXT,
    ADD COLUMN IF NOT EXISTS reverted_at    TIMESTAMPTZ;

  COMMENT ON COLUMN public.email_change_tokens.previous_email IS
    'Email anterior (antes del cambio). Necesario para revertir si el usuario detecta toma de cuenta dentro de la ventana de 24h.';
  COMMENT ON COLUMN public.email_change_tokens.reverted_at IS
    'Si se setea, el cambio fue revertido — auth.users.email volvió a previous_email.';
END $$;

-- ── 2) apply_email_change_now(token_id) ───────────────────────────────
-- Aplica el cambio inmediato y retorna el previous_email (para que la
-- edge se lo mande al user en el email de "puedes revertir hasta ...").
--
-- - Verifica que el token está confirmable (no usado, no expirado, no
--   cancelado, no ya aplicado).
-- - Verifica que el new_email no esté tomado.
-- - Guarda previous_email = email actual en auth.users.
-- - UPDATE auth.users.email = new_email + email_confirmed_at = NOW.
-- - UPDATE profiles.institutional_email.
-- - Marca confirmed_at + applied_at + apply_after (= NOW + 24h, ahora
--   es deadline de revert, no de aplicar).
--
-- SECURITY DEFINER — el caller (edge function) usa service_role pero
-- la función bypasea RLS para tocar auth.users.
CREATE OR REPLACE FUNCTION public.apply_email_change_now(_token_id UUID)
RETURNS TABLE(previous_email TEXT, apply_after TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_row RECORD;
  v_old_email TEXT;
  v_apply_after TIMESTAMPTZ;
BEGIN
  -- Lock + validar.
  SELECT id, user_id, new_email, used_at, expires_at, confirmed_at,
         cancelled_at, applied_at
    INTO v_row
    FROM public.email_change_tokens
   WHERE id = _token_id
   FOR UPDATE;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'token_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_row.used_at IS NOT NULL OR v_row.applied_at IS NOT NULL THEN
    RAISE EXCEPTION 'token_already_used' USING ERRCODE = 'P0001';
  END IF;
  IF v_row.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'token_cancelled' USING ERRCODE = 'P0001';
  END IF;
  IF v_row.expires_at < NOW() THEN
    RAISE EXCEPTION 'token_expired' USING ERRCODE = 'P0001';
  END IF;

  -- Re-check de unicidad del new_email (race window desde el request).
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE LOWER(email) = LOWER(v_row.new_email)
      AND id <> v_row.user_id
  ) THEN
    RAISE EXCEPTION 'email_already_taken' USING ERRCODE = 'P0001';
  END IF;

  -- Capturar el email actual (= previous_email).
  SELECT email INTO v_old_email FROM auth.users WHERE id = v_row.user_id;
  IF v_old_email IS NULL THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0001';
  END IF;

  v_apply_after := NOW() + INTERVAL '24 hours';

  -- Aplicar el cambio.
  UPDATE auth.users
     SET email = v_row.new_email,
         email_confirmed_at = COALESCE(email_confirmed_at, NOW()),
         updated_at = NOW()
   WHERE id = v_row.user_id;

  UPDATE public.profiles
     SET institutional_email = v_row.new_email
   WHERE id = v_row.user_id;

  -- Marcar el token: confirmed + applied + previous_email guardado +
  -- apply_after (ahora = deadline de revert).
  UPDATE public.email_change_tokens
     SET confirmed_at = NOW(),
         applied_at = NOW(),
         apply_after = v_apply_after,
         previous_email = v_old_email
   WHERE id = v_row.id;

  -- Audit.
  INSERT INTO public.audit_logs (
    action, category, severity, entity_type, entity_id, entity_name, metadata
  )
  VALUES (
    'user.email_changed',
    'user',
    'info',
    'user',
    v_row.user_id,
    v_row.new_email,
    jsonb_build_object(
      'token_id', v_row.id,
      'applied_via', 'immediate',
      'previous_email', v_old_email,
      'revert_deadline', v_apply_after
    )
  );

  previous_email := v_old_email;
  apply_after := v_apply_after;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_email_change_now(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_email_change_now(UUID) TO service_role;

COMMENT ON FUNCTION public.apply_email_change_now(UUID) IS
  'Aplica el cambio de email INMEDIATO (auth.users + profiles), guarda previous_email y setea apply_after = NOW+24h como deadline de revert. Retorna (previous_email, apply_after) para que la edge mande el email de notificación.';

-- ── 3) revert_email_change_to_previous(cancel_token) ──────────────────
-- Restaura auth.users.email al previous_email si:
--  - El cambio se aplicó (applied_at IS NOT NULL),
--  - Estamos dentro de la ventana de revert (NOW <= apply_after),
--  - No fue ya revertido (reverted_at IS NULL).
--
-- Si la fila aún no fue aplicada (caso legacy de tokens pre-migración
-- o race muy improbable), simplemente cancela (marca cancelled_at).
CREATE OR REPLACE FUNCTION public.revert_email_change_to_previous(_cancel_token TEXT)
RETURNS TABLE(restored_email TEXT, was_revert BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_row RECORD;
BEGIN
  SELECT id, user_id, new_email, previous_email, applied_at,
         cancelled_at, reverted_at, apply_after
    INTO v_row
    FROM public.email_change_tokens
   WHERE cancel_token = _cancel_token
   FOR UPDATE;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'token_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_row.reverted_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_reverted' USING ERRCODE = 'P0001';
  END IF;
  IF v_row.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_cancelled' USING ERRCODE = 'P0001';
  END IF;

  -- Caso 1: ya aplicado → REVERT.
  IF v_row.applied_at IS NOT NULL THEN
    IF v_row.apply_after IS NOT NULL AND NOW() > v_row.apply_after THEN
      RAISE EXCEPTION 'revert_window_expired' USING ERRCODE = 'P0001';
    END IF;
    IF v_row.previous_email IS NULL THEN
      -- Defensa: tokens legacy pre-migración sin previous_email.
      RAISE EXCEPTION 'previous_email_not_recorded' USING ERRCODE = 'P0001';
    END IF;

    -- Re-check que el previous_email no esté tomado por otro user
    -- (race muy improbable: alguien tomó nuestro email anterior dentro
    -- de las 24h y antes de revertir).
    IF EXISTS (
      SELECT 1 FROM auth.users
      WHERE LOWER(email) = LOWER(v_row.previous_email)
        AND id <> v_row.user_id
    ) THEN
      RAISE EXCEPTION 'previous_email_taken_by_other' USING ERRCODE = 'P0001';
    END IF;

    UPDATE auth.users
       SET email = v_row.previous_email,
           updated_at = NOW()
     WHERE id = v_row.user_id;

    UPDATE public.profiles
       SET institutional_email = v_row.previous_email
     WHERE id = v_row.user_id;

    UPDATE public.email_change_tokens
       SET reverted_at = NOW(),
           used_at = COALESCE(used_at, NOW())
     WHERE id = v_row.id;

    INSERT INTO public.audit_logs (
      action, category, severity, entity_type, entity_id, entity_name, metadata
    )
    VALUES (
      'user.email_change_reverted',
      'user',
      'warning',
      'user',
      v_row.user_id,
      v_row.previous_email,
      jsonb_build_object(
        'token_id', v_row.id,
        'reverted_from', v_row.new_email,
        'reverted_to', v_row.previous_email
      )
    );

    restored_email := v_row.previous_email;
    was_revert := TRUE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Caso 2: aún no aplicado (legacy / race) → CANCEL clásico.
  UPDATE public.email_change_tokens
     SET cancelled_at = NOW(),
         used_at = COALESCE(used_at, NOW())
   WHERE id = v_row.id;

  INSERT INTO public.audit_logs (
    action, category, severity, entity_type, entity_id, entity_name, metadata
  )
  VALUES (
    'user.email_change_cancelled',
    'user',
    'warning',
    'user',
    v_row.user_id,
    v_row.new_email,
    jsonb_build_object('token_id', v_row.id, 'cancelled_via', 'previous_email_link')
  );

  -- Para tokens no aplicados, restored_email es el email actual (no
  -- cambió nada). La edge lo usa solo para el mensaje al user.
  SELECT email INTO restored_email FROM auth.users WHERE id = v_row.user_id;
  was_revert := FALSE;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.revert_email_change_to_previous(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revert_email_change_to_previous(TEXT) TO service_role;

COMMENT ON FUNCTION public.revert_email_change_to_previous(TEXT) IS
  'Revierte un cambio de email aplicado dentro de la ventana de 24h, o cancela si aún no fue aplicado (legacy). Retorna (restored_email, was_revert).';
