-- ══════════════════════════════════════════════════════════════════════════
-- La firma se DIBUJA: el estudiante traza su firma en su renglón.
--
-- Hasta acá firmar era un clic y la marca que quedaba en el documento era el
-- nombre tipeado. Funciona, pero en un teléfono el gesto de firmar es pasar el
-- dedo, y un acuerdo que circula impreso se lee distinto con un trazo que con un
-- nombre en cursiva.
--
-- ── La columna guarda un PNG en data URL, y eso hay que acotarlo ─────────
-- El trazo termina dentro del HTML del documento, en un `<img src="...">`. O sea
-- que es contenido que sube el usuario y se inyecta en marcado: la restricción de
-- abajo es la frontera, no una validación de conveniencia.
--
--   * SOLO `image/png`. Nada de SVG: un SVG puede traer `<script>` adentro. El
--     iframe del documento no habilita scripts, pero el mismo HTML se exporta a
--     Word y se imprime, y el PNG no tiene forma de ejecutar nada en ningún lado.
--   * El patrón `^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$` no admite ni `"`
--     ni `<`, así que el valor no puede romper el atributo por más que el
--     renderizador se olvide de escaparlo.
--   * Tope de 120 000 caracteres (~90 KB de imagen). Una firma de 600×200 pesa
--     entre 5 y 20 KB; el tope está para que nadie use la columna de depósito.
--
-- Va como CHECK de la tabla y NO solo como validación en la función: la función se
-- puede reemplazar, la restricción no se salta.
--
-- ── Por qué hay que DROPear las funciones antes de recrearlas ────────────
-- Agregar un parámetro con DEFAULT crea una SOBRECARGA en vez de reemplazar, y
-- PostgREST no sabe cuál llamar: la resolución falla con un error de ambigüedad.
-- Es la misma trampa que documenta el proyecto para `clone_exam`. Así que primero
-- se dropea la firma vieja de cada una.
--
-- El trazo es OPCIONAL. Quien firma desde un computador sin pantalla táctil puede
-- seguir firmando con un clic, y en ese caso la marca es el nombre tipeado, como
-- hasta ahora. Un documento con firmas de las dos clases es válido.
-- ══════════════════════════════════════════════════════════════════════════

DO $mig$
BEGIN
  IF to_regclass('public.report_signatures') IS NULL THEN
    RAISE NOTICE 'Sin report_signatures: nada que hacer.';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'report_signatures'
       AND column_name = 'signed_drawing'
  ) THEN
    ALTER TABLE public.report_signatures ADD COLUMN signed_drawing text;

    COMMENT ON COLUMN public.report_signatures.signed_drawing IS
      'Trazo de la firma como PNG en data URL. NULL = firmó con un clic y la marca es su nombre tipeado. Acotado por chk_report_signatures_drawing: solo image/png, sin comillas ni <, maximo 120000 caracteres.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_report_signatures_drawing'
       AND conrelid = 'public.report_signatures'::regclass
  ) THEN
    ALTER TABLE public.report_signatures
      ADD CONSTRAINT chk_report_signatures_drawing CHECK (
        signed_drawing IS NULL
        OR (
          signed_drawing ~ '^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$'
          AND length(signed_drawing) <= 120000
        )
      );
  END IF;
END $mig$;

-- ── Validación compartida ─────────────────────────────────────────────────
-- La misma regla que el CHECK, pero como función para que las dos RPC de firma
-- puedan RECHAZAR con un motivo legible en vez de dejar que explote la
-- restricción. Si divergen, gana el CHECK (que es el que no se salta).
CREATE OR REPLACE FUNCTION public._signature_drawing_ok(_d text)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
AS $fn$
  SELECT _d IS NULL
     OR (_d ~ '^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$' AND length(_d) <= 120000);
$fn$;

REVOKE ALL ON FUNCTION public._signature_drawing_ok(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._signature_drawing_ok(text) TO anon, authenticated;

-- ── Firmar por el enlace, con trazo ───────────────────────────────────────
DROP FUNCTION IF EXISTS public.sign_report_public(text, text);
CREATE OR REPLACE FUNCTION public.sign_report_public(
  p_token text,
  p_user_agent text DEFAULT NULL,
  p_drawing text DEFAULT NULL
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

  IF NOT public._signature_drawing_ok(p_drawing) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_drawing');
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
  -- Firmar no cambia la fecha original ni el medio. Tampoco reemplaza el trazo:
  -- una firma ya puesta no se re-dibuja, porque entonces el enlace serviría para
  -- cambiarle la firma a alguien después de que firmó.
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
         signed_via = v_medio,
         signed_drawing = p_drawing
   WHERE public_token = p_token;

  RETURN jsonb_build_object('ok', true, 'signed_at', now(), 'signed_via', v_medio);
END;
$$;

REVOKE ALL ON FUNCTION public.sign_report_public(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sign_report_public(text, text, text) TO anon, authenticated;

-- ── Firmar desde la app, con trazo ────────────────────────────────────────
DROP FUNCTION IF EXISTS public.sign_report(uuid, text);
CREATE OR REPLACE FUNCTION public.sign_report(
  _report_id uuid,
  _user_agent text DEFAULT NULL,
  _drawing text DEFAULT NULL
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

  IF NOT public._signature_drawing_ok(_drawing) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_drawing');
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
         signed_via = 'app',
         signed_drawing = _drawing
   WHERE report_id = _report_id AND user_id = v_uid;

  RETURN jsonb_build_object('ok', true, 'signed_at', now(), 'signed_via', 'app');
END;
$$;

REVOKE ALL ON FUNCTION public.sign_report(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sign_report(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.sign_report(uuid, text, text) TO authenticated;

-- ── Las tres RPC de lectura devuelven el trazo ────────────────────────────
CREATE OR REPLACE FUNCTION public.report_signature_public_info(p_token text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_r record;
  v_firmas jsonb;
BEGIN
  IF COALESCE(p_token, '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT rs.signed_at, rs.requested_at, rs.signed_via,
         rs.user_id AS signer_id, rs.report_id,
         gr.html, gr.template_name, gr.course_name, gr.course_id,
         p.full_name AS firmante,
         c.deleted_at AS c_del
    INTO v_r
    FROM public.report_signatures rs
    JOIN public.generated_reports gr ON gr.id = rs.report_id
    LEFT JOIN public.courses c ON c.id = gr.course_id
    LEFT JOIN public.profiles p ON p.id = rs.user_id
   WHERE rs.public_token = p_token;

  IF NOT FOUND OR v_r.c_del IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', f.id, 'user_id', f.user_id,
           'nombre', fp.full_name, 'signed_at', f.signed_at,
           'dibujo', f.signed_drawing
         ) ORDER BY f.signed_at), '[]'::jsonb)
    INTO v_firmas
    FROM public.report_signatures f
    LEFT JOIN public.profiles fp ON fp.id = f.user_id
   WHERE f.report_id = v_r.report_id AND f.signed_at IS NOT NULL;

  RETURN jsonb_build_object(
    'ok', true,
    'html', v_r.html,
    'template_name', v_r.template_name,
    'course_name', v_r.course_name,
    'signer_name', v_r.firmante,
    'signer_id', v_r.signer_id,
    'firmas', v_firmas,
    'requested_at', v_r.requested_at,
    'signed_at', v_r.signed_at,
    'signed_via', v_r.signed_via
  );
END;
$$;

REVOKE ALL ON FUNCTION public.report_signature_public_info(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_signature_public_info(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_report_to_sign(_report_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_r record;
  v_firmas jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;
  SELECT gr.html, gr.template_name, gr.course_name, rs.signed_at
    INTO v_r
    FROM public.report_signatures rs
    JOIN public.generated_reports gr ON gr.id = rs.report_id
   WHERE rs.report_id = _report_id AND rs.user_id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_requested');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', f.id, 'user_id', f.user_id,
           'nombre', fp.full_name, 'signed_at', f.signed_at,
           'dibujo', f.signed_drawing
         ) ORDER BY f.signed_at), '[]'::jsonb)
    INTO v_firmas
    FROM public.report_signatures f
    LEFT JOIN public.profiles fp ON fp.id = f.user_id
   WHERE f.report_id = _report_id AND f.signed_at IS NOT NULL;

  RETURN jsonb_build_object(
    'ok', true,
    'html', v_r.html,
    'template_name', v_r.template_name,
    'course_name', v_r.course_name,
    'signed_at', v_r.signed_at,
    'signer_id', v_uid,
    'firmas', v_firmas
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_report_to_sign(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_report_to_sign(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_report_to_sign(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.report_signatures_of(_report_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ok boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  SELECT EXISTS (
    SELECT 1
      FROM public.generated_reports gr
      LEFT JOIN public.courses c ON c.id = gr.course_id
     WHERE gr.id = _report_id
       AND (
         EXISTS (SELECT 1 FROM public.course_teachers ct
                  WHERE ct.course_id = gr.course_id AND ct.user_id = v_uid)
         OR (public.has_role(v_uid, 'Admin'::public.app_role)
             AND c.tenant_id = public.current_tenant_id())
         OR public.is_super_admin()
         OR EXISTS (SELECT 1 FROM public.report_signatures rs
                     WHERE rs.report_id = _report_id AND rs.user_id = v_uid)
       )
  ) INTO v_ok;
  IF NOT v_ok THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', f.id, 'user_id', f.user_id,
             'nombre', fp.full_name, 'signed_at', f.signed_at,
             'dibujo', f.signed_drawing
           ) ORDER BY f.signed_at), '[]'::jsonb)
      FROM public.report_signatures f
      LEFT JOIN public.profiles fp ON fp.id = f.user_id
     WHERE f.report_id = _report_id AND f.signed_at IS NOT NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.report_signatures_of(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_signatures_of(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.report_signatures_of(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
