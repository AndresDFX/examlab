-- ══════════════════════════════════════════════════════════════════════════
-- El DOCENTE puede firmar un informe (y se puede pedir la firma sin notificar).
--
-- ── Por qué hoy es imposible ──────────────────────────────────────────────
-- `request_report_signatures` (versión vigente: 20261860000000) solo acepta como
-- firmante a quien esté MATRICULADO en el curso del informe:
--
--     IF NOT EXISTS (SELECT 1 FROM course_enrollments ce WHERE …) THEN
--       v_omitidas := v_omitidas + 1; CONTINUE;
--
-- Un docente está en `course_teachers`, no en `course_enrollments`, así que se
-- omitía EN SILENCIO: el diálogo decía "Se le pidió la firma a 0" y no había
-- forma de saber por qué. Y sin fila en `report_signatures`, `sign_report`
-- responde `not_requested`, así que tampoco podía firmar por su cuenta.
--
-- El caso real es el Acuerdo Pedagógico, que tiene tres casillas de firma —"El
-- Docente / Tutor", "El Vocero" y "Director"— y solo la del vocero (un
-- matriculado) era firmable.
--
-- ── Quién queda habilitado, y quién NO ────────────────────────────────────
-- Matriculado en el curso  → sí (como antes).
-- Docente del curso        → sí (lo nuevo).
-- Cualquier otro           → no, y ahora se INFORMA en vez de omitirse callado.
--
-- No se habilita "Admin del tenant" como firmante: `is_admin_of_course_tenant`
-- responde por el CALLER, no por un usuario arbitrario, así que usarla acá diría
-- que sí para cualquier id cuando el que pide es un Admin. Y el "Director" del
-- Acuerdo no es un usuario de la plataforma: su casilla se firma a mano, que es
-- lo que `renglonManualHtml` ya resuelve.
--
-- ── El contador nuevo, y por qué importa ──────────────────────────────────
-- Antes `skipped` mezclaba dos cosas muy distintas: "ya se le había pedido" (que
-- es correcto y esperable) y "esta persona no puede firmar este documento" (que
-- es un error que hay que ver). Se separan: `skipped` y `not_eligible`.
--
-- ── `_notificar` ──────────────────────────────────────────────────────────
-- Pedir la firma manda una notificación in-app y, por el pipeline de correos, un
-- correo. Hay un caso legítimo de pedirla SIN avisar: el docente que va a
-- repartir los enlaces él mismo (por el grupo del curso, en clase) y no quiere
-- que salgan 21 correos antes de haberlo explicado. El default sigue en TRUE:
-- quien no pase nada se comporta igual que antes.
--
-- Al propio caller NUNCA se le notifica, con `_notificar` o sin él: avisarle por
-- correo de algo que acaba de hacer no es información, es ruido.
--
-- ── DROP antes del CREATE, a propósito ────────────────────────────────────
-- Agregar un 3er parámetro con DEFAULT sin borrar la firma de 2 argumentos deja
-- DOS funciones con el mismo nombre, y PostgREST no puede resolver una llamada
-- con `{_report_id, _user_ids}` entre ambas: responde PGRST203 (ambiguo) y el
-- flujo de firmas queda roto entero. Es la misma trampa que ya documentó la
-- migración de `clone_exam` al parametrizarse.
-- ══════════════════════════════════════════════════════════════════════════

DO $guard$
BEGIN
  IF to_regclass('public.report_signatures') IS NULL
     OR to_regclass('public.generated_reports') IS NULL THEN
    RAISE NOTICE 'Sin las tablas de firmas: nada que hacer.';
    RETURN;
  END IF;

  DROP FUNCTION IF EXISTS public.request_report_signatures(uuid, uuid[]);
END $guard$;

CREATE OR REPLACE FUNCTION public.request_report_signatures(
  _report_id uuid,
  _user_ids uuid[],
  _notificar boolean DEFAULT true
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
  v_no_habilitados int := 0;
  v_uid_firmante uuid;
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

  -- Quién puede PEDIR firmas: el docente del curso o el Admin de su institución.
  -- `has_role()` a secas no alcanza: los roles son globales y dejaría pedir
  -- firmas en un curso de otra institución.
  IF NOT (
    EXISTS (SELECT 1 FROM public.course_teachers ct
             WHERE ct.course_id = v_course AND ct.user_id = v_uid)
    OR public.is_admin_of_course_tenant(v_course)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  IF public._course_in_papelera(v_course) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'report_not_found');
  END IF;

  FOREACH v_uid_firmante IN ARRAY COALESCE(_user_ids, ARRAY[]::uuid[])
  LOOP
    -- Quién puede FIRMAR: alguien del curso. Matriculado (el estudiante, el
    -- vocero) o docente (la casilla "El Docente / Tutor" del Acuerdo).
    IF NOT (
      EXISTS (
        SELECT 1 FROM public.course_enrollments ce
         WHERE ce.course_id = v_course AND ce.user_id = v_uid_firmante
      )
      OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
         WHERE ct.course_id = v_course AND ct.user_id = v_uid_firmante
      )
    ) THEN
      v_no_habilitados := v_no_habilitados + 1;
      CONTINUE;
    END IF;

    v_token := encode(extensions.gen_random_bytes(16), 'hex');

    INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
    VALUES (_report_id, v_uid_firmante, v_uid, v_token)
    ON CONFLICT (report_id, user_id) DO NOTHING;
    GET DIAGNOSTICS v_filas = ROW_COUNT;

    IF v_filas = 0 THEN
      -- Ya se le había pedido: no se re-notifica, sería spam. Pero si la fila
      -- viene de antes de la migración del enlace no tiene token, y sin token el
      -- docente no puede darle el enlace NUNCA. Se le pone ahora. El `IS NULL` es
      -- lo que garantiza que a nadie se le rote un enlace que ya recibió.
      UPDATE public.report_signatures
         SET public_token = v_token
       WHERE report_id = _report_id
         AND user_id = v_uid_firmante
         AND public_token IS NULL;
      v_omitidas := v_omitidas + 1;
      CONTINUE;
    END IF;

    v_pedidas := v_pedidas + 1;

    -- Sin aviso si el docente lo pidió así, y NUNCA a uno mismo.
    IF _notificar IS DISTINCT FROM FALSE AND v_uid_firmante <> v_uid THEN
      -- El link ES el enlace personal: así el botón del correo lleva directo al
      -- documento y la campana también. Firmar desde ahí estando logueado igual
      -- queda registrado como 'app'.
      INSERT INTO public.notifications (user_id, kind, title, body, link)
      VALUES (
        v_uid_firmante,
        'report_signature',
        '✍️ Tienes un documento para firmar',
        v_titulo || CASE WHEN v_curso <> '' THEN ' — ' || v_curso ELSE '' END
          || '. Revísalo y confirma tu aceptación.',
        '/acuerdo/' || v_token
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'requested', v_pedidas,
    'skipped', v_omitidas,
    'not_eligible', v_no_habilitados
  );
END;
$$;

REVOKE ALL ON FUNCTION public.request_report_signatures(uuid, uuid[], boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_report_signatures(uuid, uuid[], boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.request_report_signatures(uuid, uuid[], boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ══════════════════════════════════════════════════════════════════════════
-- Y se conectan las tres casillas de firma del Acuerdo Pedagógico.
--
-- ── El ancla, y por qué NO es un regexp ───────────────────────────────────
-- La fila de las tres casillas en blanco está ANTES de sus rótulos ("El Docente /
-- Tutor", "El Vocero", "Director"), no después, y las tres celdas son
-- byte-idénticas entre sí. Verificado contra la plantilla global de producción:
-- la CELDA vacía aparece 3 veces (así que anclar a la celda es ambiguo) y la FILA
-- completa de 3 celdas aparece **exactamente 1 vez**, inmediatamente antes de los
-- rótulos.
--
-- Por eso se reemplaza el `<tr>` COMPLETO con `replace()` de literal exacto, y no
-- con `regexp_replace` anclado al rótulo: ese fue el error que ya llegó a
-- producción —un `.*?` cruzó de celda y el correo del vocero terminó en la
-- casilla "Ciudad"— y está escrito en 20262010000000.
--
-- ── La tercera casilla queda en blanco a propósito ────────────────────────
-- "Director" no es un usuario de la plataforma: no hay a quién anclarle una
-- ranura, y ofrecerle un recuadro "firmable" sería prometer algo que falla al
-- hacer clic. Su celda se firma a mano, como siempre.
-- ══════════════════════════════════════════════════════════════════════════

DO $acuerdo$
DECLARE
  v_id uuid;
  v_vieja text;
  v_nueva text;
  v_celda text;
  v_antes int;
BEGIN
  IF to_regclass('public.report_templates') IS NULL THEN
    RAISE NOTICE 'Sin report_templates: nada que conectar.';
    RETURN;
  END IF;

  v_celda := '<td style="padding:4px 6px;vertical-align:top;width:16.7%;border:1px solid #444;">&nbsp;</td>';
  v_vieja := '<tr>' || v_celda || v_celda || v_celda || '</tr>';

  -- Las dos primeras casillas reciben su ranura; la tercera queda como estaba.
  v_nueva :=
    '<tr>'
    || '<td style="padding:4px 6px;vertical-align:top;width:16.7%;border:1px solid #444;">'
    || '&nbsp;{{{firmantes.docente.ranura}}}</td>'
    || '<td style="padding:4px 6px;vertical-align:top;width:16.7%;border:1px solid #444;">'
    || '&nbsp;{{{firmantes.vocero.ranura}}}</td>'
    || v_celda
    || '</tr>';

  -- `LIKE 'Acuerdo Pedagógico%'` y no `=`: la copia por curso se llama
  -- "Acuerdo Pedagógico (personalizada)", y con `=` se quedaba con las casillas
  -- muertas justamente en el curso donde el docente iba a usarla.
  FOR v_id IN
    SELECT id FROM public.report_templates
     WHERE name LIKE 'Acuerdo Pedagógico%'
       AND body_html LIKE '%' || v_vieja || '%'
  LOOP
    -- Se actualiza también la copia por curso si existe: sin eso, el docente que
    -- ya personalizó el Acuerdo se queda con las casillas muertas. El
    -- `updated_at` es lo que dispara el aviso de "la base cambió" en su copia.
    UPDATE public.report_templates
       SET body_html = replace(body_html, v_vieja, v_nueva),
           updated_at = now()
     WHERE id = v_id;
    RAISE NOTICE 'Acuerdo %: casillas de firma conectadas.', v_id;
  END LOOP;

  -- Verificación explícita sobre la plantilla GLOBAL, que es la que importa.
  SELECT count(*) INTO v_antes
    FROM public.report_templates
   WHERE name = 'Acuerdo Pedagógico' AND owner_id IS NULL AND course_id IS NULL
     AND body_html LIKE '%{{{firmantes.docente.ranura}}}%'
     AND body_html LIKE '%{{{firmantes.vocero.ranura}}}%';
  IF v_antes = 1 THEN
    RAISE NOTICE 'Acuerdo global: las dos ranuras quedaron puestas.';
  ELSE
    RAISE NOTICE 'ATENCION: el Acuerdo global NO quedo con las ranuras. Revisar la maquetacion.';
  END IF;
END $acuerdo$;

NOTIFY pgrst, 'reload schema';
