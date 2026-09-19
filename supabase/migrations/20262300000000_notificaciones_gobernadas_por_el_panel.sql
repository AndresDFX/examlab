-- El panel de Notificaciones pasa a gobernar la CAMPANITA, no solo el correo.
--
-- ── El problema, medido en producción (30 días) ──────────────────────
-- 6.592 notificaciones y un 14% de lectura. La correlación es INVERSA: los
-- tipos de volumen alto están todos entre 12% y 16% (`exam` 1.859 · `workshop`
-- 1.786 · `content` 1.113 · `attendance` 845), y los de volumen bajo son los
-- que sí se leen (`feedback` 26 → 50%, `exam_integrity_staff` 8 → 88%). O sea:
-- cuanto más mandamos de algo, menos se lee. Y el volumen no sale de que pase
-- mucho — en esos mismos 30 días hubo 8 talleres, 11 exámenes, 3 contenidos y
-- 3 encuestas. Tres contenidos generaron 1.113 avisos a 84 personas.
--
-- ── Por qué un trigger y no tocar donde se notifica ──────────────────
-- Hay **54 migraciones que hacen INSERT INTO notifications**. Apagar un tipo
-- editando los sitios de inserción significa encontrarlos todos hoy y acordarse
-- de gatear el próximo que alguien escriba; el que se olvide no falla, solo
-- vuelve a mandar. Un BEFORE INSERT que devuelve NULL cancela la fila para
-- TODOS los caminos, presentes y futuros — incluidos los que entren por RPC o
-- por SQL a mano. Y como cancela la fila, se lleva por delante también el
-- correo y el push: `notifications_send_email` y `notifications_send_push` son
-- AFTER INSERT, así que sin fila no se disparan. Es lo que queremos: apagar la
-- notificación, no apagarle un canal y dejar el otro.
--
-- ── Reusa el interruptor que YA existe ───────────────────────────────
-- `email_settings.enabled_kinds` es el JSON que edita Configuración → Correos.
-- No se crea una tabla nueva ni un segundo lugar donde configurar lo mismo: a
-- partir de acá ese panel gobierna la campanita Y el correo, y el próximo
-- cambio de criterio se hace con un clic en vez de con una migración.
--
-- ── Lo que NO se puede apagar, a propósito ───────────────────────────
-- Los correos TRANSACCIONALES (recuperar contraseña, confirmar cambio de
-- correo). Sin ellos alguien queda sin poder entrar y el panel se vuelve un
-- arma. Es la MISMA excepción que ya aplica el edge `send-email`.

CREATE OR REPLACE FUNCTION public.tg_notifications_respect_enabled_kinds()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_kinds      jsonb;
  v_categoria  text;
  v_transac    boolean;
BEGIN
  SELECT enabled_kinds INTO v_kinds FROM public.email_settings WHERE id = 1;
  IF v_kinds IS NULL THEN
    RETURN NEW;  -- sin configuración legible no se silencia nada
  END IF;

  -- INVARIANTE: este mapeo es el MISMO de `supabase/functions/send-email/index.ts`
  -- (`isMessage` / `isSystemAlert` / `isTransactional` / `categoryKey`). Si allá
  -- cambia, cambia acá: si divergen, el panel apaga el correo de un tipo y deja
  -- la campanita encendida (o al revés), que es peor que no tener el panel.
  v_transac := NEW.kind = 'system'
               AND (NEW.link LIKE '/auth/reset-password%'
                 OR NEW.link LIKE '/auth/confirm-email-change%');

  v_categoria := CASE
    WHEN NEW.kind = 'info'   AND NEW.link LIKE '/app/messages%'     THEN 'messages'
    WHEN NEW.kind = 'system' AND NEW.link LIKE '/app/admin/system%' THEN 'system_alerts'
    ELSE NEW.kind
  END;

  -- Se exige el literal `false`, no "distinto de true": una clave AUSENTE deja
  -- pasar. Así, un tipo nuevo notifica hasta que alguien decida apagarlo —
  -- al revés, estrenar un aviso lo dejaría mudo sin que nadie entienda por qué.
  IF NOT v_transac AND (v_kinds -> v_categoria) = 'false'::jsonb THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_notifications_respect_enabled_kinds ON public.notifications;
CREATE TRIGGER trg_notifications_respect_enabled_kinds
  BEFORE INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.tg_notifications_respect_enabled_kinds();

-- ── El recorte pedido: quedan SOLO comentarios y conversaciones ──────
-- `feedback` (comentarios sobre una entrega) y `messages` (conversación 1-a-1)
-- son los dos que la gente efectivamente lee y a los que responde.
-- `system_alerts` se deja PRENDIDO aunque no esté en esa lista: no es ruido
-- para el estudiante, es el aviso al dueño de la plataforma de que el
-- almacenamiento se está llenando, y son ~3 al mes.
--
-- DOS EXCEPCIONES que este UPDATE no puede apagar, y conviene saberlas:
--   · `welcome` ("Bienvenida a ExamLab — Define tu contraseña") se apaga acá
--     pero NO tiene efecto, y es PREVIO a esta migración: esa notificación se
--     crea con `kind='system'` + `link='/auth/reset-password?token=…'`
--     (`bulk-import-users`), o sea exactamente el patrón que el filtro de
--     arriba —y el edge `send-email` desde antes— tratan como TRANSACCIONAL y
--     dejan pasar siempre. Es lo correcto: sin ese correo el usuario nuevo no
--     puede definir su contraseña y no entra nunca. Para que el interruptor
--     tenga dientes habría que darle un `kind` propio en vez de reusar el de
--     recuperar contraseña, y eso es otro cambio.
--   · Los propios transaccionales (recuperar contraseña, confirmar cambio de
--     correo), por la misma razón y a propósito.
UPDATE public.email_settings
   SET enabled_kinds = COALESCE(enabled_kinds, '{}'::jsonb) || jsonb_build_object(
         'feedback',         true,
         'messages',         true,
         'system_alerts',    true,
         'exam',             false,
         'workshop',         false,
         'project',          false,
         'content',          false,
         'poll',             false,
         'grade',            false,
         'attendance',       false,
         'report_signature', false,
         'course_welcome',   false,
         'welcome',          false,
         'session_start',    false
       )
 WHERE id = 1;
