-- ══════════════════════════════════════════════════════════════════════════
-- Firmar EN EL RENGLÓN: las firmas se dibujan dentro del documento, en la celda
-- de cada estudiante, y el estudiante firma desde ahí.
--
-- ── Qué faltaba ───────────────────────────────────────────────────────────
-- El flujo de firmas ya existía (`report_signatures`, el enlace público, la
-- pantalla del estudiante), pero la firma era un REGISTRO invisible: la tabla del
-- Acuerdo Pedagógico seguía imprimiendo un rectángulo en blanco por estudiante, y
-- el estudiante firmaba con un botón al final de un documento de varias páginas.
-- Nadie podía mirar el acuerdo y ver quién firmó.
--
-- Lo que falta para poder pintarlas es información que las RPC no devolvían:
--   * a QUIÉN corresponde el enlace (`signer_id`), para saber cuál de las N
--     ranuras del documento se vuelve el botón de esa persona;
--   * las firmas del informe (`firmas`), para dibujar las que ya están.
-- Sin lo primero, un estudiante vería el botón en la fila de todos; sin lo
-- segundo, el documento firmado se seguiría viendo en blanco.
--
-- ── Por qué el estudiante ve las firmas de sus compañeros ────────────────
-- Porque eso es un documento firmado. El acuerdo ES la lista del curso —los
-- nombres ya están todos ahí— y lo que se agrega es la fecha de cada firma, que
-- es justamente lo que hace verificable un acta colectiva. Es lo mismo que hacen
-- las plataformas de firma con varios firmantes. Lo que NO se expone es nada que
-- el documento no muestre ya: ni correos, ni notas, ni el token de nadie.
--
-- ── Compatibilidad ───────────────────────────────────────────────────────
-- Los dos RPC solo AGREGAN claves al objeto que ya devolvían, así que la pantalla
-- vieja sigue funcionando mientras se despliega la nueva. Y los informes ya
-- generados no tienen ranuras: se siguen viendo y firmando como hasta ahora, con
-- el botón al pie. Nada obliga a regenerarlos.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1 · El enlace público ─────────────────────────────────────────────────
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

  -- Un token que no existe y uno de un curso en papelera responden IGUAL: no
  -- hay por qué confirmarle a nadie que un token es "casi" válido.
  IF NOT FOUND OR v_r.c_del IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  -- Solo las FIRMADAS. Las pendientes no se listan: la ranura vacía ya dice que
  -- falta, y enumerar quién no firmó todavía no aporta nada al documento.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', f.id, 'user_id', f.user_id,
           'nombre', fp.full_name, 'signed_at', f.signed_at
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
    -- Nuevo: identifica la ranura de quien abrió el enlace.
    'signer_id', v_r.signer_id,
    -- Nuevo: las firmas ya puestas, para dibujarlas en el documento.
    'firmas', v_firmas,
    'requested_at', v_r.requested_at,
    'signed_at', v_r.signed_at,
    'signed_via', v_r.signed_via
  );
END;
$$;

REVOKE ALL ON FUNCTION public.report_signature_public_info(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_signature_public_info(text) TO anon, authenticated;

-- ── 2 · La vía autenticada, dentro de la app ──────────────────────────────
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
           'nombre', fp.full_name, 'signed_at', f.signed_at
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
    -- Acá el firmante ES el caller: se devuelve igual para que la pantalla no
    -- tenga que mezclar dos fuentes de identidad según por dónde entró.
    'signer_id', v_uid,
    'firmas', v_firmas
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_report_to_sign(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_report_to_sign(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_report_to_sign(uuid) TO authenticated;

-- ── 3 · Las firmas para el DOCENTE ────────────────────────────────────────
-- El docente ve el documento con las firmas puestas en su propia vista previa y
-- en la descarga. Podría leer `report_signatures` directo (su policy de SELECT ya
-- se lo permite), pero necesita el NOMBRE del firmante, que vive en `profiles`, y
-- `report_signatures.user_id` apunta a `auth.users`: no es embebible a `profiles`
-- desde PostgREST (la trampa que este repo ya documenta y que hace fallar el
-- embed en silencio). Con esta RPC es una sola llamada y sin ese riesgo.
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
  -- Misma autorización que la policy de SELECT de report_signatures: el docente
  -- del curso del informe, el Admin de la institución, o el propio firmante. Se
  -- repite acá porque la función es SECURITY DEFINER y por lo tanto la policy no
  -- se aplica sola.
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
             'nombre', fp.full_name, 'signed_at', f.signed_at
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

COMMENT ON FUNCTION public.report_signatures_of(uuid) IS
  'Firmas PUESTAS de un informe, con el nombre del firmante. Para dibujarlas dentro del documento. Autorizacion replicada de la policy de SELECT de report_signatures (la funcion es SECURITY DEFINER).';

-- ── 4 · La plantilla del Acuerdo Pedagógico estrena la ranura ─────────────
-- Se hace por reemplazo puntual y no re-sembrando el cuerpo entero: la plantilla
-- global viene de varias migraciones sucesivas (texto, generalización,
-- maquetación) y volver a escribirla completa acá pisaría lo que aquellas
-- corrigieron. Lo único que cambia es la celda de Firma de la fila del listado.
--
-- Idempotente: si la ranura ya está, no toca nada.
DO $mig$
DECLARE
  v_celda_vieja text := '<td style="padding:4px 6px;border:1px solid #444;height:30px;">&nbsp;</td>';
  v_celda_nueva text := '<td style="padding:4px 6px;border:1px solid #444;height:30px;">'
    || '<span class="examlab-firma" data-firma-uid="{{user_id}}" style="display:block;min-height:30px;">&nbsp;</span>'
    || '</td>';
  v_n integer;
BEGIN
  IF to_regclass('public.report_templates') IS NULL THEN
    RAISE NOTICE 'Sin report_templates: nada que actualizar.';
    RETURN;
  END IF;

  -- "Global" en `report_templates` NO es `tenant_id IS NULL`: esta tabla no tiene
  -- columna `tenant_id`. Una plantilla global es la que no pertenece a un docente
  -- ni a un curso ni deriva de otra — `owner_id`, `course_id` y `parent_id` en
  -- NULL, que es exactamente como la inserta el seed (mig 20261760000000).
  --
  -- La primera versión de esta migración decía `tenant_id IS NULL` y falló al
  -- aplicarse con "column tenant_id does not exist". El arnés de verificación no
  -- lo detectó porque CREÓ la tabla con esa columna: probó el SQL contra un
  -- esquema inventado. Se corrigió leyendo las columnas reales por REST.
  UPDATE public.report_templates
     SET body_html = replace(body_html, v_celda_vieja, v_celda_nueva)
   WHERE name = 'Acuerdo Pedagógico'
     AND owner_id IS NULL
     AND course_id IS NULL
     AND position(v_celda_vieja in body_html) > 0
     AND position('examlab-firma' in body_html) = 0;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RAISE NOTICE 'La plantilla del Acuerdo ya tiene la ranura (o no coincide la celda): sin cambios.';
  ELSE
    RAISE NOTICE 'Ranura de firma agregada a la plantilla del Acuerdo Pedagogico.';
  END IF;
END $mig$;

NOTIFY pgrst, 'reload schema';
