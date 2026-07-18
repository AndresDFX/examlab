-- ══════════════════════════════════════════════════════════════════════
-- Backoff EXPONENCIAL en el cron de reintento de correos.
--
-- Tormenta real (2026-07-18, ~01:00): un lote de correos falló con Gmail
-- `454 4.7.0 Too many login attempts` (rate limit de LOGIN). El cron
-- `retry-failed-email-notifications` (cada 5 min) reintentaba hasta 50 notifs
-- por tick SIN espaciado — y cada envío del edge abría además hasta 3 logins
-- (fix companion en send-email: fail-fast ante throttle de login). Resultado:
-- 183 fallos/hora auto-sostenidos hasta agotar los 5 retries de cada notif.
--
-- Fix: una notif solo es elegible para reintento cuando pasó el espaciado
-- exponencial desde su último intento: 5min × 2^retry_count
--   count=0 → elegible ya (el tick del cron da el 1er espaciado natural)
--   count=1 → 10 min · count=2 → 20 min · count=3 → 40 min · count=4 → 80 min
-- Así una ola de fallos DECAE en vez de martillar el SMTP cada 5 minutos,
-- dándole tiempo al rate limit del proveedor a liberarse.
--
-- El resto de la función (sección B: alerta al creador de difusión) queda
-- IDÉNTICO a la versión desplegada.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.retry_failed_email_notifications()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
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

  -- ─── A) REINTENTAR transitorios (con backoff exponencial) ─────────
  -- Patrones a reintentar: 4xx provider_error (típico 421/454),
  -- pg_net_call_failed, 'timeout' / 'temporary' / 'try again', y 503.
  -- NO reintenta: 5xx no-503, user_opted_out, no_settings, pg_net_missing,
  -- kind_not_critical (intencionales o de config — no se arreglan solos).
  FOR r IN
    SELECT id, user_id
    FROM public.notifications
    WHERE email_delivered_at IS NULL
      AND email_retry_count < 5
      AND created_at > now() - interval '24 hours'
      AND email_skipped_reason IS NOT NULL
      -- BACKOFF EXPONENCIAL: espaciado mínimo 5min × 2^retry_count desde el
      -- último intento. Evita que una ola de fallos (ej. 454 login throttle)
      -- se auto-sostenga martillando el SMTP cada tick del cron.
      AND (
        email_last_retry_at IS NULL
        OR email_last_retry_at < now() - (interval '5 minutes' * power(2, email_retry_count))
      )
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
$function$;
