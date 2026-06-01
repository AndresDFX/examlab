-- ──────────────────────────────────────────────────────────────────────
-- Email change flow: double-email + security delay.
--
-- Antes: click en link del NUEVO correo → cambio inmediato. El correo
-- ANTERIOR no se enteraba hasta despues. Si comprometian la cuenta, el
-- atacante podia cambiar el correo y bloquear al duenho legitimo en
-- minutos.
--
-- Ahora:
--   1. Request → email al NUEVO correo (confirmar) + email al
--      ANTERIOR correo (aviso + link para cancelar).
--   2. Click confirmar (nuevo correo) → NO se aplica todavia. Se
--      marca confirmed_at + apply_after = NOW + 24h. Se manda otro
--      email al anterior: "el cambio fue confirmado, se aplicara en
--      24h, cancela si no fuiste tu".
--   3. Click cancelar (anterior correo, en cualquier momento antes
--      de apply_after) → marca cancelled_at, el cambio NO se aplica.
--   4. Pasadas las 24h sin cancelacion → cron aplica el cambio.
--
-- Beneficio: el duenho original tiene 24h+ para detectar y revertir
-- un intento malicioso de toma de cuenta via cambio de correo.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) Nuevas columnas en email_change_tokens ─────────────────────────
ALTER TABLE public.email_change_tokens
  ADD COLUMN IF NOT EXISTS cancel_token TEXT,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS apply_after  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS applied_at   TIMESTAMPTZ;

-- cancel_token debe ser UNIQUE para que el lookup por el link del aviso
-- sea O(1) y no haya colisiones (32 bytes URL-safe → 256 bits entropia).
-- Partial UNIQUE para tolerar NULL en tokens viejos pre-migracion.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_email_change_tokens_cancel
  ON public.email_change_tokens(cancel_token)
  WHERE cancel_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_change_tokens_apply_after
  ON public.email_change_tokens(apply_after)
  WHERE confirmed_at IS NOT NULL
    AND cancelled_at IS NULL
    AND applied_at IS NULL;

-- ── 2) Funcion que aplica los cambios confirmados-y-no-cancelados ─────
-- Corre periodicamente via pg_cron. Idempotente: si una fila ya esta
-- aplicada (applied_at IS NOT NULL) no la toca. Cuenta como exito si:
--   - confirmed_at <= NOW - delay
--   - cancelled_at IS NULL
--   - applied_at IS NULL
--
-- El cambio real se hace via `auth.admin.updateUserById`-equivalent
-- desde SQL: UPDATE auth.users SET email = new_email WHERE id = user_id.
-- Tambien actualiza profiles.institutional_email para mantener
-- consistencia.
--
-- Retorna cuantas filas se aplicaron en esta corrida (para logging).
CREATE OR REPLACE FUNCTION public.apply_pending_email_changes()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  applied_count INTEGER := 0;
  r RECORD;
BEGIN
  FOR r IN
    SELECT id, user_id, new_email, token
    FROM public.email_change_tokens
    WHERE confirmed_at IS NOT NULL
      AND cancelled_at IS NULL
      AND applied_at IS NULL
      AND apply_after <= NOW()
      AND used_at IS NULL
    -- Procesamos uno a uno; volumen esperado bajo (<10/dia tipicamente).
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      -- Verificar de nuevo que el email no este tomado (race window
      -- de 24h+ es largo, otro user pudo reclamar el correo).
      IF EXISTS (
        SELECT 1 FROM auth.users
        WHERE LOWER(email) = LOWER(r.new_email)
          AND id <> r.user_id
      ) THEN
        -- Marcamos como "usado" para que no se reintente; el usuario
        -- debera solicitar de nuevo con otro email.
        UPDATE public.email_change_tokens
          SET used_at = NOW(),
              applied_at = NULL  -- explicitamente NO aplicado
          WHERE id = r.id;
        -- Audit warning (sin tirar el loop).
        INSERT INTO public.audit_logs (action, category, severity, entity_type, entity_id, entity_name, metadata)
        VALUES (
          'user.email_change_apply_failed',
          'user',
          'warning',
          'user',
          r.user_id,
          r.new_email,
          jsonb_build_object('token_id', r.id, 'reason', 'email_taken_by_other_user_at_apply')
        );
        CONTINUE;
      END IF;

      -- Aplicar el cambio en auth.users (RLS bypass via SECURITY DEFINER).
      UPDATE auth.users
        SET email = r.new_email,
            email_confirmed_at = COALESCE(email_confirmed_at, NOW()),
            updated_at = NOW()
        WHERE id = r.user_id;

      -- Sincronizar profiles.institutional_email.
      UPDATE public.profiles
        SET institutional_email = r.new_email
        WHERE id = r.user_id;

      -- Marcar el token como aplicado + usado.
      UPDATE public.email_change_tokens
        SET applied_at = NOW(),
            used_at = NOW()
        WHERE id = r.id;

      applied_count := applied_count + 1;

      INSERT INTO public.audit_logs (action, category, severity, entity_type, entity_id, entity_name, metadata)
      VALUES (
        'user.email_changed',
        'user',
        'info',
        'user',
        r.user_id,
        r.new_email,
        jsonb_build_object('token_id', r.id, 'applied_via', 'cron_delayed')
      );
    EXCEPTION WHEN OTHERS THEN
      -- Si algo falla, no abortamos el batch — seguimos con la siguiente
      -- fila. La fila erronea queda sin applied_at y el siguiente tick
      -- reintenta (con SKIP LOCKED no se queda atascada).
      INSERT INTO public.audit_logs (action, category, severity, entity_type, entity_id, entity_name, metadata)
      VALUES (
        'user.email_change_apply_failed',
        'user',
        'error',
        'user',
        r.user_id,
        r.new_email,
        jsonb_build_object('token_id', r.id, 'reason', 'exception', 'sqlerrm', SQLERRM)
      );
    END;
  END LOOP;

  RETURN applied_count;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_pending_email_changes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_pending_email_changes() TO service_role;

COMMENT ON FUNCTION public.apply_pending_email_changes() IS
  'Cron job que aplica los cambios de email confirmados cuyo apply_after ya paso. Idempotente. Devuelve cuantos se aplicaron en esta corrida.';

-- ── 3) Schedule del job (cada 15 min) ─────────────────────────────────
-- Latencia maxima: 15 min despues de cumplirse el delay. Aceptable; el
-- usuario ya espero 24h, 15 min mas no se notan.
DO $$
BEGIN
  -- Si el job ya existe (de un re-run de la migracion), lo borramos
  -- antes de crear el nuevo. cron.unschedule lanza si no existe — usamos
  -- bloque PL/pgSQL para silenciar.
  BEGIN
    PERFORM cron.unschedule('apply_pending_email_changes_15min');
  EXCEPTION WHEN OTHERS THEN
    -- No existia, todo bien.
    NULL;
  END;

  PERFORM cron.schedule(
    'apply_pending_email_changes_15min',
    '*/15 * * * *',
    $cron$ SELECT public.apply_pending_email_changes(); $cron$
  );
END $$;

-- Descripcion humana del job para el panel de Cron (mismo patron que
-- los otros jobs descritos).
INSERT INTO public.cron_job_descriptions (jobname, description)
VALUES (
  'apply_pending_email_changes_15min',
  'Aplica cambios de email confirmados cuyo delay de seguridad de 24h ya paso. Cada 15 minutos.'
)
ON CONFLICT (jobname) DO UPDATE SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';
