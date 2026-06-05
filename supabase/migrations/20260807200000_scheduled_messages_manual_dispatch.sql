-- ──────────────────────────────────────────────────────────────────────
-- Mensajes programados: dispatch manual + cron re-schedule defensivo
-- + hardening de permisos.
--
-- Caso real reportado: un mensaje directo programado para hoy 09:00
-- quedó en `status='pending'` con `send_at < now()` durante horas.
-- Causas posibles (no excluyentes):
--   1. El job `dispatch-scheduled-messages` fue pausado/desactivado por
--      Admin desde el panel SupabaseCronPanel.
--   2. pg_cron del proyecto Supabase no está escalando jobs (problema
--      de plataforma — raro).
--   3. La migración 20260709000000 nunca pudo agendar el cron (pg_cron
--      no estaba disponible al momento del primer apply) y nunca se
--      re-corrió.
--
-- Esta migración añade:
--   1. RPC `request_dispatch_scheduled_messages()`: cualquier authenticated
--      la puede llamar; corre `dispatch_scheduled_messages()` en su
--      transacción. Útil cuando la cola está atrasada y el cron tarda
--      en levantarse. SECURITY DEFINER + sin authz fina porque la
--      función subyacente ya re-valida `can_message` y permisos de
--      curso por fila — no hay riesgo de privilege escalation.
--   2. Re-schedule del cron (idempotente) para garantizar que existe.
--   3. HARDENING: REVOKE EXECUTE de `dispatch_scheduled_messages` para
--      PUBLIC / anon. La función original (mig 20260709) se creó sin
--      GRANT explícito → Postgres asigna EXECUTE a PUBLIC por default,
--      lo que permite a CUALQUIERA con la anon key (que es pública)
--      triggear el dispatch. Es un DoS vector (no privilege escalation
--      porque la función ya valida `can_message` por fila). Aún así
--      conviene cerrarlo: el dispatch lo invoca SOLO pg_cron (como
--      postgres) y la nueva RPC SECURITY DEFINER (también bypass perms).
-- ──────────────────────────────────────────────────────────────────────

-- 1) RPC público — fuerza un barrido inmediato de la cola.
CREATE OR REPLACE FUNCTION public.request_dispatch_scheduled_messages()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_count INT;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '28000';
  END IF;
  -- `dispatch_scheduled_messages` ya re-valida autorización por fila
  -- (can_message para direct, course_teachers para broadcast). No
  -- restringimos por caller aquí — un docente puede acelerar TODA la
  -- cola pendiente, no solo lo suyo, porque acelerar afecta la entrega
  -- a tiempo del resto sin permitir nada nuevo.
  SELECT public.dispatch_scheduled_messages() INTO v_count;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_dispatch_scheduled_messages() TO authenticated;

-- 2) Re-schedule del cron — idempotente. Si el job ya existe lo
-- recreamos con el mismo schedule para "reactivar" estado en caso de
-- haber sido pausado o desconfigurado. Si pg_cron no está disponible,
-- emitimos NOTICE y seguimos (el RPC del paso 1 sirve como workaround
-- manual hasta que se restablezca).
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron no disponible; dispatch solo manual via request_dispatch_scheduled_messages().';
    RETURN;
  END;

  -- Si el job existía, lo des-agendamos para re-crearlo limpio. Algunos
  -- estados raros (active=false sin manera fácil de re-activarlo via
  -- ALTER) se resuelven recreando.
  PERFORM extensions.cron.unschedule('dispatch-scheduled-messages')
  WHERE EXISTS (
    SELECT 1 FROM extensions.cron.job WHERE jobname = 'dispatch-scheduled-messages'
  );

  PERFORM extensions.cron.schedule(
    'dispatch-scheduled-messages',
    '* * * * *',
    $cron$ SELECT public.dispatch_scheduled_messages(); $cron$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Setup del cron de mensajes programados falló (re-schedule defensivo): %', SQLERRM;
END
$$;

-- Descripción si no existe (por compat con la migración previa).
INSERT INTO public.cron_job_descriptions (jobname, description)
VALUES (
  'dispatch-scheduled-messages',
  'Envía los mensajes programados (directos y de difusión) cuya fecha de envío ya pasó. Corre cada minuto.'
)
ON CONFLICT (jobname) DO UPDATE SET description = EXCLUDED.description;

-- 3) Defensa adicional contra zombis: CHECK que send_at > created_at.
-- Si un cliente con bug de TZ guarda send_at en el pasado (por ej.
-- interpreta el local string como UTC en vez de local), la fila queda
-- inmediatamente vencida. La validación client-side `validateScheduledSend`
-- requiere ≥1min en el futuro, pero un cliente malicioso o defectuoso
-- podría saltarse esa validación y enviar el INSERT directo. CHECK
-- server-side cierra ese caso.
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scheduled_messages_send_at_future'
      AND conrelid = 'public.scheduled_messages'::regclass
  ) THEN
    -- NOT VALID: aplica SOLO a INSERTs/UPDATEs nuevos. Filas viejas con
    -- data potencialmente inválida no rompen el ALTER. La idea es
    -- frenar futuras filas-zombi, no rejugar el pasado.
    -- 5min de gracia hacia atrás tolera clock skew leve y evita rechazar
    -- filas legítimas que el cliente creó justo antes (send_at = ahora-ish).
    ALTER TABLE public.scheduled_messages
      ADD CONSTRAINT scheduled_messages_send_at_future
      CHECK (send_at > created_at - INTERVAL '5 minutes') NOT VALID;
  END IF;
END
$check$;

-- 4) Hardening: cerrar `dispatch_scheduled_messages` a anon/PUBLIC.
-- Confirmado en runtime: con solo la anon key (que es pública en el
-- repo + bundled en frontend) un atacante podía hacer POST a
-- /rest/v1/rpc/dispatch_scheduled_messages y triggear un barrido de
-- toda la cola pendiente. No hay privilege escalation (la función
-- ya re-valida `can_message` por fila, así que solo acelera lo que
-- ya estaba programado), pero sí abre una vía DoS: spam de calls →
-- carga sobre el worker SQL + bumps de status='failed' si la
-- ventana de re-test de can_message coincide con un cambio de
-- enrollment temporal.
--
-- Quien NECESITA llamarla:
--   - pg_cron (corre como postgres, bypassa GRANT por ser superuser).
--   - `request_dispatch_scheduled_messages` (SECURITY DEFINER también
--     corre como postgres, bypassa).
--   - Nadie más.
--
-- Acción: REVOKE PUBLIC. Sin GRANT subsecuente: el rol authenticated
-- llama via `request_dispatch_scheduled_messages` (que sí tiene GRANT).
REVOKE EXECUTE ON FUNCTION public.dispatch_scheduled_messages() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.dispatch_scheduled_messages() FROM anon;
REVOKE EXECUTE ON FUNCTION public.dispatch_scheduled_messages() FROM authenticated;

NOTIFY pgrst, 'reload schema';
