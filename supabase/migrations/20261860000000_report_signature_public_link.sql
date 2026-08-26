-- ══════════════════════════════════════════════════════════════════════
-- Enlace público para firmar un informe, y que el aviso LLEGUE por correo.
--
-- ── Qué ya había y qué faltaba ────────────────────────────────────────
-- 20261780000000 dejó lo de fondo: la tabla `report_signatures` sin policy de
-- escritura, `request_report_signatures` (que crea la notificación in-app),
-- `sign_report`, `get_report_to_sign` y la pantalla /app/student/signatures.
-- Faltaban las dos cosas que hacen que un acuerdo se firme de verdad:
--
--   1. que el aviso SALGA POR CORREO. El kind `report_signature` no estaba en
--      `_notification_kind_emails`, así que la notificación quedaba solo dentro
--      de la app: el alumno que no entra no se enteraba nunca;
--   2. un ENLACE que se pueda abrir sin iniciar sesión, como el de asistencia.
--
-- ── El token es POR FIRMANTE, no por documento ────────────────────────
-- Esta es la decisión que define el diseño. Un token por documento obligaría a
-- que el estudiante se identifique al abrirlo (correo, o correo+contraseña como
-- en asistencia). Un token por SOLICITUD ya sabe quién es: la fila
-- `report_signatures` es (informe, persona), así que el enlace identifica al
-- firmante sin pedirle nada.
--
-- Eso es además cómo funcionan las plataformas de firma: un enlace único por
-- firmante, no uno compartido. Y es el mismo patrón que el token del calendario
-- ICS que este repo ya usa (`resolve_calendar_token`), donde el token ES la
-- credencial.
--
-- ── Lo que eso cuesta, dicho de frente ────────────────────────────────
-- El enlace es la credencial: quien lo tenga puede firmar EN NOMBRE de esa
-- persona. Si un estudiante reenvía su correo, el que lo recibe puede firmar por
-- él. No hay contraseña de por medio.
--
-- Por eso el registro guarda el `signed_via` ('app' | 'link'): cuando alguien
-- discuta una firma, tiene que constar si hubo sesión de por medio. Y se decide
-- por la SESIÓN, no por la URL: si quien pulsa Firmar en el enlace está logueado
-- y es la misma persona, queda 'app', porque de eso sí hay prueba. Lo que degrada
-- la evidencia es la ausencia de sesión, no el camino por el que llegó.
--
-- ── Y por qué el aviso apunta al enlace personal ──────────────────────
-- El correo NO se arma aparte: `send-email` construye su botón como
-- `APP_PUBLIC_URL + notification.link` (ver `fullLink` en su index.ts). O sea que
-- el enlace personal llega al correo con solo ponerlo en el `link` del aviso
-- —sin tocar el edge y sin sumar otra invariante que mantener en sincronía—, y de
-- paso la notificación de la campana abre el documento concreto en vez de una
-- lista. La pantalla autenticada (/app/student/signatures) sigue existiendo y
-- firmando por `sign_report`.
--
-- NO es una firma digital — ni por la app ni por el enlace. Es un registro de
-- aceptación, como ya dice la migración que creó la tabla.
-- ══════════════════════════════════════════════════════════════════════

DO $mig$
BEGIN
  IF to_regclass('public.report_signatures') IS NULL THEN
    RAISE NOTICE 'report_signatures ausente — se omite el enlace público';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='report_signatures' AND column_name='public_token'
  ) THEN
    ALTER TABLE public.report_signatures ADD COLUMN public_token text;
    -- UNIQUE parcial: el token es el identificador del enlace. Parcial porque
    -- las filas viejas lo tienen en NULL y un UNIQUE normal las agruparía.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_report_signatures_public_token
      ON public.report_signatures(public_token) WHERE public_token IS NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='report_signatures' AND column_name='signed_via'
  ) THEN
    ALTER TABLE public.report_signatures ADD COLUMN signed_via text;
  END IF;

  -- Las filas que ya existan se quedan sin token: backfillearlas acá crearía
  -- enlaces que nadie envió. Quien las cubre es `request_report_signatures`: si
  -- el docente vuelve a pedir la firma de esa persona, le pone token a la fila
  -- que no tenía, sin volver a notificar.
END $mig$;

COMMENT ON COLUMN public.report_signatures.public_token IS
  'Token del enlace personal de firma. ES la credencial: quien lo tenga puede firmar por esa persona.';
COMMENT ON COLUMN public.report_signatures.signed_via IS
  'Por donde se firmo: app (con sesion) o link (enlace personal, sin sesion). Una firma por enlace vale menos como prueba.';

-- ── El aviso ahora emaila, y lleva el enlace ──────────────────────────
-- Los otros dos lados del invariante (send-email/index.ts y
-- src/modules/notifications/notification-email.ts) se tocan en el mismo commit.
DO $mig$
BEGIN
  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    CREATE OR REPLACE FUNCTION public._notification_kind_emails(_kind text, _link text)
      RETURNS boolean LANGUAGE sql STABLE
      AS $fn$
        SELECT
          _kind IN ('grade', 'exam', 'feedback', 'workshop', 'project', 'attendance', 'broadcast', 'course_welcome', 'session_start', 'report_signature')
          OR (_kind = 'info' AND _link IS NOT NULL AND _link LIKE '/app/messages%')
          OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/app/admin/system%')
          OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/auth/reset-password%')
          OR (
            _kind = 'support'
            AND COALESCE(
              (SELECT ps.support_emails_enabled FROM public.platform_settings ps WHERE ps.id = 1),
              true
            )
          );
      $fn$;
  ELSE
    CREATE OR REPLACE FUNCTION public._notification_kind_emails(_kind text, _link text)
      RETURNS boolean LANGUAGE sql STABLE
      AS $fn$
        SELECT
          _kind IN ('grade', 'exam', 'feedback', 'workshop', 'project', 'attendance', 'broadcast', 'course_welcome', 'session_start', 'report_signature')
          OR (_kind = 'info' AND _link IS NOT NULL AND _link LIKE '/app/messages%')
          OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/app/admin/system%')
          OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/auth/reset-password%');
      $fn$;
  END IF;
END $mig$;

-- ── Pedir firmas: además genera el token y lo pone en el aviso ────────
CREATE OR REPLACE FUNCTION public.request_report_signatures(
  _report_id uuid,
  _user_ids uuid[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_course uuid;
  v_titulo text;
  v_curso text;
  v_pedidas int := 0;
  v_omitidas int := 0;
  v_uid_estudiante uuid;
  v_token text;
  v_filas int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;

  SELECT gr.course_id, COALESCE(gr.template_name, 'Informe'), COALESCE(gr.course_name, '')
    INTO v_course, v_titulo, v_curso
    FROM public.generated_reports gr
   WHERE gr.id = _report_id;
  IF v_course IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'report_not_found');
  END IF;

  IF NOT (
    EXISTS (SELECT 1 FROM public.course_teachers ct
             WHERE ct.course_id = v_course AND ct.user_id = v_uid)
    OR public.is_admin_of_course_tenant(v_course)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  -- Papelera del curso: no se piden firmas de un documento de un curso borrado.
  -- (La regla universal de papelera; el camino de firmas no la tenía.)
  IF public._course_in_papelera(v_course) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'report_not_found');
  END IF;

  FOREACH v_uid_estudiante IN ARRAY COALESCE(_user_ids, ARRAY[]::uuid[])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.course_enrollments ce
       WHERE ce.course_id = v_course AND ce.user_id = v_uid_estudiante
    ) THEN
      v_omitidas := v_omitidas + 1;
      CONTINUE;
    END IF;

    v_token := encode(extensions.gen_random_bytes(16), 'hex');

    INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
    VALUES (_report_id, v_uid_estudiante, v_uid, v_token)
    ON CONFLICT (report_id, user_id) DO NOTHING;
    GET DIAGNOSTICS v_filas = ROW_COUNT;

    IF v_filas = 0 THEN
      -- Ya se le había pedido: no se re-notifica, sería spam. Pero si la fila
      -- viene de antes de esta migración no tiene token, y sin token el docente
      -- no puede darle el enlace NUNCA. Se le pone ahora. El `IS NULL` es lo que
      -- garantiza que a nadie se le rote un enlace que ya recibió.
      UPDATE public.report_signatures
         SET public_token = v_token
       WHERE report_id = _report_id
         AND user_id = v_uid_estudiante
         AND public_token IS NULL;
      v_omitidas := v_omitidas + 1;
      CONTINUE;
    END IF;

    v_pedidas := v_pedidas + 1;
    -- El link ES el enlace personal: así el botón del correo lleva directo al
    -- documento y la campana también. Firmar desde ahí estando logueado igual
    -- queda registrado como 'app'.
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    VALUES (
      v_uid_estudiante,
      'report_signature',
      '✍️ Tienes un documento para firmar',
      v_titulo || CASE WHEN v_curso <> '' THEN ' — ' || v_curso ELSE '' END
        || '. Revísalo y confirma tu aceptación.',
      '/acuerdo/' || v_token
    );
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'requested', v_pedidas, 'skipped', v_omitidas);
END;
$$;

REVOKE ALL ON FUNCTION public.request_report_signatures(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_report_signatures(uuid, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.request_report_signatures(uuid, uuid[]) TO authenticated;

-- ── Lo que ve quien abre el enlace ────────────────────────────────────
-- Devuelve el documento COMPLETO: el punto es que el estudiante pueda LEER lo
-- que va a firmar. El token ya lo identifica, así que no hay nada que exponer
-- que no sea suyo.
CREATE OR REPLACE FUNCTION public.report_signature_public_info(p_token text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_r record;
BEGIN
  IF COALESCE(p_token, '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT rs.signed_at, rs.requested_at, rs.signed_via,
         gr.html, gr.template_name, gr.course_name, gr.course_id,
         p.full_name AS firmante,
         c.deleted_at AS c_del
    INTO v_r
    FROM public.report_signatures rs
    JOIN public.generated_reports gr ON gr.id = rs.report_id
    LEFT JOIN public.courses c ON c.id = gr.course_id
    LEFT JOIN public.profiles p ON p.id = rs.user_id
   WHERE rs.public_token = p_token;

  -- Un token que no existe y uno de un curso en papelera responden IGUAL: no
  -- hay por qué confirmarle a nadie que un token es "casi" válido.
  IF NOT FOUND OR v_r.c_del IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'html', v_r.html,
    'template_name', v_r.template_name,
    'course_name', v_r.course_name,
    'signer_name', v_r.firmante,
    'requested_at', v_r.requested_at,
    'signed_at', v_r.signed_at,
    'signed_via', v_r.signed_via
  );
END;
$$;

REVOKE ALL ON FUNCTION public.report_signature_public_info(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_signature_public_info(text) TO anon, authenticated;

-- ── Firmar por el enlace ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sign_report_public(
  p_token text,
  p_user_agent text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  v_fila public.report_signatures%ROWTYPE;
  v_html text;
  v_borrado timestamptz;
  v_medio text;
BEGIN
  IF COALESCE(p_token, '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT * INTO v_fila FROM public.report_signatures WHERE public_token = p_token;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT c.deleted_at, gr.html INTO v_borrado, v_html
    FROM public.generated_reports gr
    LEFT JOIN public.courses c ON c.id = gr.course_id
   WHERE gr.id = v_fila.report_id;
  IF v_borrado IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  -- Idempotente, igual que `sign_report`: volver a abrir el enlace y pulsar
  -- Firmar no cambia la fecha original ni el medio.
  IF v_fila.signed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true, 'already', true,
      'signed_at', v_fila.signed_at, 'signed_via', v_fila.signed_via
    );
  END IF;

  -- Si quien firma está logueado Y es la persona de la fila, hubo sesión: eso es
  -- exactamente la prueba que separa 'app' de 'link'. Marcar 'link' por el solo
  -- hecho de haber entrado por el correo subestimaría la evidencia, y el aviso
  -- apunta justamente a esta URL.
  v_medio := CASE WHEN auth.uid() IS NOT NULL AND auth.uid() = v_fila.user_id
                  THEN 'app' ELSE 'link' END;

  UPDATE public.report_signatures
     SET signed_at = now(),
         signed_hash = encode(extensions.digest(COALESCE(v_html, ''), 'sha256'), 'hex'),
         signed_user_agent = left(COALESCE(p_user_agent, ''), 400),
         signed_via = v_medio
   WHERE public_token = p_token;

  RETURN jsonb_build_object('ok', true, 'signed_at', now(), 'signed_via', v_medio);
END;
$$;

REVOKE ALL ON FUNCTION public.sign_report_public(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sign_report_public(text, text) TO anon, authenticated;

-- ── La firma desde la app deja constancia de que fue por la app ───────
CREATE OR REPLACE FUNCTION public.sign_report(
  _report_id uuid,
  _user_agent text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_fila public.report_signatures%ROWTYPE;
  v_html text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;

  SELECT * INTO v_fila
    FROM public.report_signatures
   WHERE report_id = _report_id AND user_id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_requested');
  END IF;

  IF v_fila.signed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true, 'already', true,
      'signed_at', v_fila.signed_at, 'signed_via', v_fila.signed_via
    );
  END IF;

  SELECT gr.html INTO v_html FROM public.generated_reports gr WHERE gr.id = _report_id;

  UPDATE public.report_signatures
     SET signed_at = now(),
         signed_hash = encode(extensions.digest(COALESCE(v_html, ''), 'sha256'), 'hex'),
         signed_user_agent = left(COALESCE(_user_agent, ''), 400),
         signed_via = 'app'
   WHERE report_id = _report_id AND user_id = v_uid;

  RETURN jsonb_build_object('ok', true, 'signed_at', now(), 'signed_via', 'app');
END;
$$;

REVOKE ALL ON FUNCTION public.sign_report(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sign_report(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.sign_report(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
