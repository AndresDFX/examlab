-- ──────────────────────────────────────────────────────────────────────
-- `calendar-recordings-sync-6h` viene FALLANDO cada 6 horas, desde siempre.
--
-- Verificado en producción el 2026-08-20 (último run 12:30, `last_status =
-- failed`), con este mensaje:
--
--   ERROR: cross-database references are not implemented: extensions.net.http_post
--
-- Y su comando tiene además el segundo defecto:
--   SELECT extensions.net.http_post(url := NU...   ← `url := NULL`
--
-- Son las dos mismas causas que dejaron sin crear el cron del worker de
-- generación (ver `20261660000000`):
--
-- 1. **`extensions.net.http_post` no existe.** pg_net vive en el schema `net`;
--    un nombre de TRES partes lo interpreta Postgres como
--    `base.esquema.objeto`, y de ahí el "cross-database references". Lo mismo
--    vale para `cron.schedule` / `cron.unschedule` / `cron.job`, que van SIN el
--    prefijo `extensions.`.
-- 2. **La URL se resolvía con `format()` AL CREAR el job**, así que el valor de
--    las GUCs quedó congelado en el comando. Estaban vacías → el comando nació
--    con `url := NULL` y falla en cada corrida, incluso si hoy se configuraran.
--
-- Por eso el arreglo NO es editar el comando: es moverlo a una función que
-- resuelva la configuración EN CADA EJECUCIÓN, que es el patrón de los crons
-- que sí funcionan (`SELECT public.<funcion>()`).
--
-- Qué hace este cron (se preserva idéntico): para los docentes con calendario
-- conectado, trae grabaciones, notas y enlaces de Google/Microsoft Calendar a
-- las sesiones ya vinculadas. Invoca el edge `calendar` con
-- `{"action":"cron_sync_recordings"}` y 120s de timeout.
--
-- Si las GUCs faltan, la función **audita un warning** en vez de callarse — el
-- silencio es lo que dejó este cron fallando meses sin que nadie lo mirara.
-- Configuración (una vez, en el SQL Editor; la clave NO va al repo):
--   ALTER DATABASE postgres SET app.settings.supabase_url = 'https://<ref>.supabase.co';
--   ALTER DATABASE postgres SET app.settings.service_role_key = '<service_role_key>';
--
-- NOTA sobre lo que NO se hace: el cron del worker de generación se saltea la
-- invocación cuando su cola está vacía. Acá no se agrega un guard equivalente
-- porque no hay una señal que se pueda comprobar con certeza desde SQL (el edge
-- resuelve por su cuenta qué docentes tienen calendario conectado). Preferimos
-- una invocación de más cada 6 horas antes que un guard basado en una suposición
-- sobre el modelo de datos.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.trigger_calendar_recordings_sync()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url text := current_setting('app.settings.supabase_url', true);
  v_key text := current_setting('app.settings.service_role_key', true);
BEGIN
  IF v_url IS NULL OR v_url = '' OR v_key IS NULL OR v_key = '' THEN
    INSERT INTO public.audit_logs (action, severity, metadata)
    VALUES (
      'calendar.recordings_sync_not_configured',
      'warning',
      jsonb_build_object(
        'falta', CASE
                   WHEN (v_url IS NULL OR v_url = '') AND (v_key IS NULL OR v_key = '')
                     THEN 'app.settings.supabase_url y app.settings.service_role_key'
                   WHEN (v_url IS NULL OR v_url = '') THEN 'app.settings.supabase_url'
                   ELSE 'app.settings.service_role_key'
                 END,
        'como_resolver', 'Correr ALTER DATABASE postgres SET ... (ver la migracion 20261670000000)'
      )
    );
    RETURN;
  END IF;

  -- `net.http_post`, NO `extensions.net.http_post`.
  PERFORM net.http_post(
    url := v_url || '/functions/v1/calendar',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := jsonb_build_object('action', 'cron_sync_recordings'),
    timeout_milliseconds := 120000
  );
END
$$;

COMMENT ON FUNCTION public.trigger_calendar_recordings_sync() IS
  'Invoca el edge calendar con action=cron_sync_recordings. La llama el cron calendar-recordings-sync-6h. Si las GUCs de config faltan, audita un warning en vez de callarse.';

REVOKE ALL ON FUNCTION public.trigger_calendar_recordings_sync() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.trigger_calendar_recordings_sync() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_calendar_recordings_sync() TO service_role;

-- ── Re-agendar el job con el comando correcto ─────────────────────────
DO $$
BEGIN
  -- Se pregunta si `cron.schedule` es INVOCABLE (no si figura en pg_extension):
  -- es la condición real y se puede ejercitar con un stub del schema `cron`.
  IF to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN
    RAISE NOTICE 'pg_cron no disponible — no se re-agenda calendar-recordings-sync-6h';
    RETURN;
  END IF;

  -- El job YA EXISTE con el comando roto: hay que borrarlo para reemplazarlo.
  PERFORM cron.unschedule('calendar-recordings-sync-6h')
   WHERE EXISTS (
     SELECT 1 FROM cron.job WHERE jobname = 'calendar-recordings-sync-6h'
   );

  PERFORM cron.schedule(
    'calendar-recordings-sync-6h',
    '30 */6 * * *',   -- se preserva la cadencia original
    'SELECT public.trigger_calendar_recordings_sync();'
  );
END $$;

-- La descripción del panel se mantiene (ya existe); se reafirma por si acaso.
DO $$
BEGIN
  IF to_regclass('public.cron_job_descriptions') IS NULL THEN RETURN; END IF;
  INSERT INTO public.cron_job_descriptions (jobname, description)
  VALUES (
    'calendar-recordings-sync-6h',
    'Cada 6 horas: para los docentes con calendario conectado, trae automáticamente las grabaciones, notas y enlaces de Google/Microsoft Calendar a las sesiones ya vinculadas (últimos 45 días).'
  )
  ON CONFLICT (jobname) DO UPDATE SET description = EXCLUDED.description;
END $$;

NOTIFY pgrst, 'reload schema';
