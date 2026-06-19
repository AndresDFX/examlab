-- ════════════════════════════════════════════════════════════════════
-- Reintento automático de emails fallidos por error transitorio +
-- alerta al creador de una difusión cuando se agotan los reintentos.
--
-- Caso reportado: una difusión a 17 alumnos tuvo 16 OK y 1 que falló
-- con `421: 4.3.0 Temporary System Problem` (Gmail temporal). Hoy esa
-- notif queda con `email_skipped_reason` poblado y `email_delivered_at`
-- en NULL — nadie la reintenta. El alumno simplemente no recibe.
--
-- Esta migración agrega:
--   1. Columnas `email_retry_count` y `email_alerted_creator` en
--      notifications para rastrear intentos y meta-alertas.
--   2. Función `retry_failed_email_notifications()` que cada tick:
--      A) Reintenta emails con error transitorio (4xx SMTP, timeouts,
--         pg_net_call_failed). Máx 5 intentos por notif, solo si la
--         notif tiene <24h.
--      B) Si una notif ya agotó 5 intentos sin éxito, agrupa por
--         `related_user_id` (el creador de la difusión) y le manda UNA
--         notificación in-app listando los alumnos afectados. Usa
--         kind='system' con link a /app/messages para que NO dispare
--         email (el predicado `_notification_kind_emails` requiere link
--         que empiece con /app/admin/system o /auth/reset-password para
--         emailar 'system' — el nuestro no matchea, queda solo in-app).
--   3. Cron `retry-failed-email-notifications` cada 5 min.
--
-- Errores considerados TRANSITORIOS (se reintentan):
--   - provider_error: 4xx (todos los 4xx SMTP son temporales por RFC,
--     salvo 4xx específicos como 421 (server busy) que son los típicos)
--   - pg_net_call_failed: ... (red local cayó por unos segundos)
--   - cualquier que contenga 'timeout', 'temporary', 'try again'
--
-- Errores PERMANENTES (NO se reintentan, alertan al creator de una):
--   - provider_error: 5xx (excepto 503 que sí es retryable)
--   - user_opted_out, no_settings, pg_net_missing, kind_not_critical
--     → estos NO califican para alerta tampoco (son intencionales).
-- ════════════════════════════════════════════════════════════════════

-- ── 1) Columnas nuevas ──────────────────────────────────────────────
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS email_retry_count INT NOT NULL DEFAULT 0;
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS email_alerted_creator BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS email_last_retry_at TIMESTAMPTZ;

COMMENT ON COLUMN public.notifications.email_retry_count IS
  'Número de intentos de envío de email para esta notificación. Incrementado por retry_failed_email_notifications. Tope = 5.';
COMMENT ON COLUMN public.notifications.email_alerted_creator IS
  'TRUE cuando ya le avisamos al creador de la difusión (related_user_id) que ESTA notif falló definitivamente. Evita re-alertar.';
COMMENT ON COLUMN public.notifications.email_last_retry_at IS
  'Timestamp del último reintento de envío. Usado para esperar 10 min después del 5° intento antes de alertar al creador (la edge tarda en confirmar fail).';

-- Index para acelerar el SELECT del retry (filtra por
-- email_delivered_at IS NULL + retry_count + created_at).
CREATE INDEX IF NOT EXISTS idx_notifications_email_retry
  ON public.notifications (email_retry_count, created_at)
  WHERE email_delivered_at IS NULL;

-- ── 2) Función principal del retry + alerta ─────────────────────────
CREATE OR REPLACE FUNCTION public.retry_failed_email_notifications()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  v_url           text;
  v_key           text;
  v_retried       int := 0;
  v_alerted       int := 0;
  v_net_exists    boolean;
  r               record;
  v_creator       uuid;
  v_failed_names  text;
  v_failed_count  int;
  v_subject       text;
BEGIN
  -- Settings y pg_net (mismo patrón que notify_send_email).
  SELECT value INTO v_url FROM private.app_settings WHERE key = 'send_email_url';
  SELECT value INTO v_key FROM private.app_settings WHERE key = 'service_role_key';
  SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') INTO v_net_exists;

  IF v_url IS NULL OR NOT v_net_exists THEN
    RETURN jsonb_build_object('retried', 0, 'alerted', 0, 'reason', 'no_settings_or_no_pgnet');
  END IF;

  -- ─── A) REINTENTAR transitorios ────────────────────────────────────
  -- Patrones a reintentar: 4xx provider_error (típico 421), pg_net_call_failed,
  -- cualquier mensaje con 'timeout' o 'temporary' o 'try again'.
  -- NO reintenta: 5xx no-503, user_opted_out, no_settings, pg_net_missing,
  -- kind_not_critical (todos son intencionales o config — no se arreglan solos).
  FOR r IN
    SELECT id, user_id
    FROM public.notifications
    WHERE email_delivered_at IS NULL
      AND email_retry_count < 5
      AND created_at > now() - interval '24 hours'
      AND email_skipped_reason IS NOT NULL
      AND (
        email_skipped_reason ~* '^provider_error: 4[0-9]{2}'
        OR email_skipped_reason ~* '^pg_net_call_failed'
        OR email_skipped_reason ~* 'timeout'
        OR email_skipped_reason ~* 'temporary'
        OR email_skipped_reason ~* 'try again'
        OR email_skipped_reason ~* '^provider_error: 503'  -- 503 Service Unavailable, sí retryable
      )
    ORDER BY created_at ASC
    LIMIT 50  -- Tope por tick para no martillar el SMTP
    FOR UPDATE SKIP LOCKED
  LOOP
    -- Bump del contador + timestamp + limpiar la razón anterior para
    -- que la edge pueda escribir el resultado nuevo (success →
    -- email_delivered_at, fail → nuevo email_skipped_reason).
    UPDATE public.notifications
      SET email_retry_count = email_retry_count + 1,
          email_last_retry_at = now(),
          email_skipped_reason = NULL
      WHERE id = r.id;

    -- Llamada fire-and-forget a la edge send-email (mismo payload que
    -- el trigger original notify_send_email).
    BEGIN
      PERFORM net.http_post(
        url := v_url,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || COALESCE(v_key, '')
        ),
        body := jsonb_build_object('notification_id', r.id),
        timeout_milliseconds := 10000
      );
      v_retried := v_retried + 1;
    EXCEPTION WHEN OTHERS THEN
      -- Si pg_net rebota, registramos y seguimos con la siguiente.
      UPDATE public.notifications
        SET email_skipped_reason = 'pg_net_call_failed: ' || SQLERRM
        WHERE id = r.id;
    END;
  END LOOP;

  -- ─── B) ALERTAR al creador cuando se agotaron los reintentos ──────
  -- Agrupamos por related_user_id (el creator que disparó la difusión).
  -- Solo notifs broadcast con retry_count agotado + tiempo de gracia
  -- post-último intento (10 min para que el último retry haya tenido
  -- chance de actualizar). created_at <7d para no resucitar histórico.
  FOR v_creator IN
    SELECT DISTINCT related_user_id
    FROM public.notifications
    WHERE email_delivered_at IS NULL
      AND email_retry_count >= 5
      AND email_alerted_creator = false
      AND related_user_id IS NOT NULL
      AND kind = 'broadcast'
      AND created_at > now() - interval '7 days'
      AND email_last_retry_at < now() - interval '10 minutes'
  LOOP
    -- Lista de hasta 10 nombres afectados (si hay más, indicamos "y N más").
    SELECT
      string_agg(p.full_name, ', ' ORDER BY p.full_name) FILTER (WHERE rn <= 10),
      count(*),
      -- El "asunto" lo tomamos del título de la primera notif (formato "📢 X").
      substring(min(n.title) from '^📢 (.*)$')
    INTO v_failed_names, v_failed_count, v_subject
    FROM (
      SELECT
        n2.id,
        n2.user_id,
        n2.title,
        row_number() OVER (ORDER BY n2.created_at) AS rn
      FROM public.notifications n2
      WHERE n2.email_delivered_at IS NULL
        AND n2.email_retry_count >= 5
        AND n2.email_alerted_creator = false
        AND n2.related_user_id = v_creator
        AND n2.kind = 'broadcast'
        AND n2.created_at > now() - interval '7 days'
        AND n2.updated_at < now() - interval '10 minutes'
    ) ranked
    JOIN public.notifications n ON n.id = ranked.id
    JOIN public.profiles p ON p.id = ranked.user_id;

    IF v_failed_count IS NULL OR v_failed_count = 0 THEN
      CONTINUE;
    END IF;

    -- Body humano (con "y N más" si hubo más de 10).
    INSERT INTO public.notifications (user_id, title, body, kind, link)
    VALUES (
      v_creator,
      '⚠️ Algunos correos de tu difusión no llegaron',
      'No pudimos entregar el correo de "' || COALESCE(v_subject, '(sin asunto)') || '" a ' ||
        v_failed_count || ' alumno(s): ' ||
        COALESCE(v_failed_names, '') ||
        CASE WHEN v_failed_count > 10 THEN ' y ' || (v_failed_count - 10) || ' más.' ELSE '.' END ||
        ' Recibieron la notificación in-app pero no el correo. Si necesitan saberlo por email, contactalos por otro medio.',
      'system',
      '/app/messages'  -- No matchea el predicado de email → solo in-app, sin emailear al creator
    );

    -- Marcamos las afectadas como ya alertadas para no re-notificar.
    UPDATE public.notifications
      SET email_alerted_creator = true
      WHERE related_user_id = v_creator
        AND kind = 'broadcast'
        AND email_delivered_at IS NULL
        AND email_retry_count >= 5
        AND email_alerted_creator = false;

    v_alerted := v_alerted + 1;
  END LOOP;

  RETURN jsonb_build_object('retried', v_retried, 'alerted', v_alerted);
END;
$$;

GRANT EXECUTE ON FUNCTION public.retry_failed_email_notifications() TO authenticated;
-- Hardening: solo postgres (pg_cron) y RPC controladas la llaman; cerramos
-- a anon/public para evitar DoS desde la anon key del frontend.
REVOKE EXECUTE ON FUNCTION public.retry_failed_email_notifications() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.retry_failed_email_notifications() FROM anon;

-- ── 3) Cron cada 5 minutos ──────────────────────────────────────────
DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    RAISE NOTICE 'pg_cron no instalado, salida limpia.';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retry-failed-email-notifications') THEN
    PERFORM cron.schedule(
      'retry-failed-email-notifications',
      '*/5 * * * *',
      $$ SELECT public.retry_failed_email_notifications(); $$
    );
  END IF;
END
$cron$;

-- Descripción humana para el panel SuperAdmin → Cron.
INSERT INTO public.cron_job_descriptions (jobname, description)
VALUES (
  'retry-failed-email-notifications',
  'Cada 5 minutos: reintenta el envío de notificaciones por correo que fallaron por error transitorio (4xx SMTP, timeouts). Tope 5 intentos por notif, ventana de 24h. Si se agotan los intentos, le notifica al creador de la difusión qué alumnos no recibieron el correo.'
)
ON CONFLICT (jobname) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at = now();

NOTIFY pgrst, 'reload schema';
