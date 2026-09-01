-- ══════════════════════════════════════════════════════════════════════════
-- Enlace PÚBLICO del documento: uno solo para compartir, y se firma con correo
-- y contraseña.
--
-- ── Qué había, y el intercambio que se cambia ─────────────────────────────
-- 20261860000000 dejó un enlace POR FIRMANTE (`report_signatures.public_token`),
-- y escribió de frente lo que eso cuesta: *"El enlace es la credencial: quien lo
-- tenga puede firmar EN NOMBRE de esa persona. Si un estudiante reenvía su
-- correo, el que lo recibe puede firmar por él. No hay contraseña de por medio."*
-- Esa misma migración nombró la alternativa que descartaba entonces: *"Un token
-- por documento obligaría a que el estudiante se identifique al abrirlo (correo,
-- o correo+contraseña)"*.
--
-- Esto agrega justamente esa alternativa, sin quitar la otra. Las dos coexisten y
-- sirven para cosas distintas:
--
--   * enlace POR FIRMANTE  → comodidad. Llega al correo de cada uno, no pide
--     nada, y firma con `signed_via='link'`.
--   * enlace DEL DOCUMENTO → un solo enlace para pegar en el grupo del curso. NO
--     identifica a nadie: solo deja LEER. Para firmar hay que iniciar sesión.
--
-- ── La decisión que hace que esto sea MÁS fuerte, no más débil ────────────
-- El token público NO habilita ninguna escritura. Firmar sigue pasando por
-- `sign_report`, que exige `auth.uid()` y que la persona esté entre las
-- solicitudes de ESE informe. O sea que el token solo reemplaza al "poder abrir
-- el documento", y la identidad la da la contraseña.
--
-- Consecuencia buena y medible: una firma hecha desde el enlace público queda
-- registrada como `signed_via='app'`, porque hubo sesión de verdad. Es MEJOR
-- evidencia que la del enlace personal. La regla ya estaba escrita en
-- 20261860000000 ("se decide por la SESIÓN, no por la URL") y acá se cumple sola:
-- no hay que tocar `sign_report` ni agregarle un modo.
--
-- Por eso NO se crea ningún RPC de firma nuevo. Un segundo camino de escritura
-- sería la parte peligrosa, y no hace falta.
--
-- ── Lo que el enlace muestra, y lo que no ─────────────────────────────────
-- Muestra el documento completo — que es lo mismo que ya hace el enlace por
-- firmante, y es lo que se necesita para poder leer antes de aceptar. Un acuerdo
-- de curso ES la lista del curso: los nombres ya están ahí. NO se exponen
-- correos, ni notas, ni el token de nadie, ni quién falta por firmar (lo que
-- falta lo dice la ranura en blanco).
--
-- `public_enabled` arranca en FALSE: nada se vuelve público solo. Y el token es
-- una columna aparte del `id` para poder CORTAR un enlace filtrado sin perder el
-- documento (el `id` ya circula en la app).
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1 · Las columnas ──────────────────────────────────────────────────────
DO $mig$
BEGIN
  IF to_regclass('public.generated_reports') IS NULL THEN
    RAISE NOTICE 'Sin generated_reports: nada que hacer.';
    RETURN;
  END IF;

  ALTER TABLE public.generated_reports
    ADD COLUMN IF NOT EXISTS public_token TEXT,
    ADD COLUMN IF NOT EXISTS public_enabled BOOLEAN NOT NULL DEFAULT false;

  CREATE UNIQUE INDEX IF NOT EXISTS uq_generated_reports_public_token
    ON public.generated_reports(public_token) WHERE public_token IS NOT NULL;

  COMMENT ON COLUMN public.generated_reports.public_token IS
    'Token del enlace publico del documento (32 hex). Solo habilita LEER; firmar exige sesion.';
  COMMENT ON COLUMN public.generated_reports.public_enabled IS
    'FALSE por defecto: ningun informe se vuelve publico solo. El docente lo activa.';
END $mig$;

-- ── 2 · Abrir el documento con el token ───────────────────────────────────
-- Devuelve lo mismo que la vista por firmante MENOS la identidad: acá todavía no
-- se sabe quién está mirando, y no se puede adivinar.
CREATE OR REPLACE FUNCTION public.report_public_document(p_token text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_r record;
  v_firmas jsonb;
  v_pendientes integer;
BEGIN
  IF COALESCE(p_token, '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT gr.id, gr.html, gr.template_name, gr.course_name, gr.course_id,
         gr.public_enabled, c.deleted_at AS c_del
    INTO v_r
    FROM public.generated_reports gr
    LEFT JOIN public.courses c ON c.id = gr.course_id
   WHERE gr.public_token = p_token;

  -- Un token que no existe, uno desactivado y uno de un curso en papelera
  -- responden IGUAL: no hay por qué confirmarle a nadie que un token es "casi"
  -- válido, ni que existió y se cortó.
  IF NOT FOUND OR NOT v_r.public_enabled OR v_r.c_del IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  -- Solo las FIRMADAS, igual que el enlace por firmante: la ranura en blanco ya
  -- dice que falta, y enumerar a quién le falta no aporta nada al documento.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', f.id, 'user_id', f.user_id,
           'nombre', fp.full_name, 'signed_at', f.signed_at,
           'dibujo', f.signed_drawing
         ) ORDER BY f.signed_at), '[]'::jsonb)
    INTO v_firmas
    FROM public.report_signatures f
    LEFT JOIN public.profiles fp ON fp.id = f.user_id
   WHERE f.report_id = v_r.id AND f.signed_at IS NOT NULL;

  SELECT count(*) INTO v_pendientes
    FROM public.report_signatures f
   WHERE f.report_id = v_r.id AND f.signed_at IS NULL;

  RETURN jsonb_build_object(
    'ok', true,
    -- El id hace falta para que, tras iniciar sesión, la pantalla pueda usar los
    -- RPC autenticados de siempre (`get_report_to_sign`, `sign_report`). No es un
    -- dato sensible: quien tiene el token ya tiene el documento.
    'report_id', v_r.id,
    'html', v_r.html,
    'template_name', v_r.template_name,
    'course_name', v_r.course_name,
    'firmas', v_firmas,
    -- Cuántas faltan, sin decir de quién: es lo que le dice al docente que el
    -- enlace sirve, y al estudiante que no es el único.
    'pendientes', v_pendientes
  );
END;
$$;

REVOKE ALL ON FUNCTION public.report_public_document(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_public_document(text) TO anon, authenticated;

COMMENT ON FUNCTION public.report_public_document(text) IS
  'Abre un informe por su token publico. SOLO LECTURA: no identifica a nadie y no habilita firmar. Firmar exige sesion (sign_report).';

-- ── 3 · Activar, cortar y rotar el enlace ─────────────────────────────────
-- Autorización con scope de institución: docente del curso del informe, Admin de
-- la institución de ese curso, o SuperAdmin. Una rama `has_role('Admin')` suelta
-- sería un leak cross-tenant — los roles de este proyecto son globales.
--
-- TODOS los guards van en el CUERPO, no en el GRANT: Supabase otorga EXECUTE a
-- `anon` por `ALTER DEFAULT PRIVILEGES` y el `REVOKE … FROM PUBLIC` no borra esa
-- entrada del ACL. Por eso además se revoca `anon` explícitamente.
CREATE OR REPLACE FUNCTION public.report_set_public(
  _report_id uuid,
  _enabled boolean,
  _rotate boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_curso uuid;
  v_ok    boolean;
  v_token text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;

  SELECT gr.course_id INTO v_curso
    FROM public.generated_reports gr
   WHERE gr.id = _report_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.courses c
     WHERE c.id = v_curso
       AND c.deleted_at IS NULL
       AND (
         EXISTS (SELECT 1 FROM public.course_teachers ct
                  WHERE ct.course_id = c.id AND ct.user_id = v_uid)
         OR public.is_admin_of_course_tenant(c.id)
       )
  ) INTO v_ok;

  IF NOT v_ok THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT gr.public_token INTO v_token
    FROM public.generated_reports gr WHERE gr.id = _report_id;

  -- Se genera token cuando se activa y no había, o cuando se pide rotar. Rotar
  -- es lo que CORTA un enlace filtrado: el viejo deja de resolver.
  IF _rotate OR (_enabled AND v_token IS NULL) THEN
    v_token := encode(extensions.gen_random_bytes(16), 'hex');
  END IF;

  UPDATE public.generated_reports
     SET public_enabled = COALESCE(_enabled, false),
         public_token   = v_token
   WHERE id = _report_id;

  RETURN jsonb_build_object(
    'ok', true,
    'enabled', COALESCE(_enabled, false),
    -- Se devuelve el token para que la pantalla arme el enlace sin otra consulta.
    'token', CASE WHEN COALESCE(_enabled, false) THEN v_token ELSE NULL END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.report_set_public(uuid, boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_set_public(uuid, boolean, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.report_set_public(uuid, boolean, boolean) TO authenticated;

COMMENT ON FUNCTION public.report_set_public(uuid, boolean, boolean) IS
  'Activa, corta o rota el enlace publico de un informe. Docente del curso / Admin de la institucion / SuperAdmin.';

NOTIFY pgrst, 'reload schema';
