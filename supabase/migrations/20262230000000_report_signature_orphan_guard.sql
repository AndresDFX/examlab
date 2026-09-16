-- ══════════════════════════════════════════════════════════════════════════
-- Causa raíz: dejar de crear firmas HUÉRFANAS + poder agregar matriculados
-- faltantes a un informe ya generado, sin regenerarlo.
--
-- ── El bug que esto cierra (caso real UNIAJ, ya parchado a mano en
--    20262220000000 para ese curso puntual) ─────────────────────────────────
-- `generated_reports.html` es un SNAPSHOT inmutable: es lo que se firma y el
-- hash de verificación se calcula sobre él. Un informe de curso ancla una
-- RANURA de firma por persona (`data-firma-uid="<uid>"`, ver
-- src/modules/reports/signature-slots.ts). Quien se matricula DESPUÉS del
-- documento no tiene fila en ese HTML — ni ranura donde dibujar su firma.
--
-- Y sin embargo se le podía CREAR la solicitud de firma igual: tanto
-- `request_report_signatures` (mig 20262030000000) como el trigger
-- `tg_enroll_propagate_snapshots` (mig 20262200000000) insertaban en
-- `report_signatures` sin verificar que el usuario estuviera anclado en el HTML
-- del informe. Resultado: hasta 9 estudiantes que YA habían firmado por el
-- enlace de su correo, pero cuya firma no tenía dónde dibujarse — invisibles en
-- el documento que supuestamente firmaron.
--
-- ── Lo que hace esta migración ────────────────────────────────────────────
--   1. `report_html_has_signer(html, uid)` — ¿el HTML ancla a esa persona?
--   2. `request_report_signatures` — no crea la solicitud (ni notifica) si la
--      persona no está en el documento; lo cuenta aparte (`not_in_document`).
--   3. `tg_enroll_propagate_snapshots` — igual, y además avisa al/los DOCENTE(s)
--      del curso que hay un matriculado que el documento no incluye.
--   4. `report_append_students` — agrega las filas faltantes al HTML del informe
--      ya generado (append-only, sin tocar las firmas existentes) y pide sus
--      firmas por el camino de siempre.
--
-- Estructura: las funciones y sus GRANT van a NIVEL SUPERIOR (como la mig
-- 20262030000000) — `CREATE OR REPLACE FUNCTION` no falla aunque las tablas que
-- referencia su cuerpo no existan (el cuerpo se valida en ejecución), así que no
-- necesitan guard `to_regclass`. Solo el TRIGGER va dentro de un guard, porque
-- `CREATE TRIGGER` sí falla si `course_enrollments` no existe (patrón de la mig
-- 20262200000000).
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1 · ¿El documento ancla a esta persona? ───────────────────────────────
-- El atributo `data-firma-uid` lo emiten SOLO `ranuraHtml`/`ranuraPlantillaHtml`
-- (signature-slots.ts), así que buscar el string exacto alcanza — no hace falta
-- parsear HTML. `_uid` es de tipo `uuid` (validado), y `strpos` hace una
-- búsqueda de subcadena LITERAL (a diferencia de LIKE, no interpreta `%`/`_`),
-- así que la concatenación no puede inyectar nada.
CREATE OR REPLACE FUNCTION public.report_html_has_signer(_html text, _uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    strpos(COALESCE(_html, ''), 'data-firma-uid="' || _uid::text || '"') > 0,
    false
  );
$$;

REVOKE ALL ON FUNCTION public.report_html_has_signer(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_html_has_signer(text, uuid) TO authenticated;

COMMENT ON FUNCTION public.report_html_has_signer(text, uuid) IS
  'TRUE si el HTML del informe ancla una ranura de firma (data-firma-uid) para ese usuario. Base de "no crear firmas huerfanas".';

-- ── 2 · request_report_signatures: no pedir firma a quien no está en el doc ─
-- Se conserva EXACTA la lógica de 20262030000000 (autorización del caller,
-- papelera, docente-o-matriculado como firmante, `_notificar`, back-fill de
-- token). Lo nuevo: si el documento TIENE ranuras y la persona no está anclada,
-- no se inserta ni se notifica; se cuenta en `not_in_document`. Un documento
-- SIN ranuras (informe viejo, se firma "en general") no se toca: ahí no hay a
-- quién anclar y el comportamiento previo se preserva.
--
-- Misma firma (uuid, uuid[], boolean) y mismo RETURNS jsonb → CREATE OR REPLACE
-- alcanza, sin DROP.
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
  v_html text;
  v_tiene_ranuras boolean;
  v_pedidas int := 0;
  v_omitidas int := 0;
  v_no_habilitados int := 0;
  v_sin_documento int := 0;
  v_uid_firmante uuid;
  v_token text;
  v_filas int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;

  SELECT gr.course_id, COALESCE(gr.template_name, 'Informe'), COALESCE(gr.course_name, ''), gr.html
    INTO v_course, v_titulo, v_curso, v_html
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

  -- ¿El documento usa ranuras? Si no (informe viejo), se firma "en general" y no
  -- se puede exigir un ancla que no existe. `examlab-firma` es la clase de la
  -- ranura (CLASE_RANURA); `examlab-renglon` —el renglón a mano— no la contiene,
  -- así que esta comprobación no lo confunde.
  v_tiene_ranuras := strpos(COALESCE(v_html, ''), 'examlab-firma') > 0;

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

    -- No crear firmas HUÉRFANAS: si el documento ancla a otras personas pero NO
    -- a esta, pedirle la firma dejaría una solicitud sin ranura donde dibujarse.
    -- Se cuenta aparte para que la pantalla lo diga en vez de omitirlo callado.
    IF v_tiene_ranuras AND NOT public.report_html_has_signer(v_html, v_uid_firmante) THEN
      v_sin_documento := v_sin_documento + 1;
      CONTINUE;
    END IF;

    v_token := encode(extensions.gen_random_bytes(16), 'hex');

    INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
    VALUES (_report_id, v_uid_firmante, v_uid, v_token)
    ON CONFLICT (report_id, user_id) DO NOTHING;
    GET DIAGNOSTICS v_filas = ROW_COUNT;

    IF v_filas = 0 THEN
      -- Ya se le había pedido: no se re-notifica. Pero si la fila viene de antes
      -- de la migración del enlace no tiene token, y sin token el docente no
      -- puede darle el enlace NUNCA. Se le pone ahora. El `IS NULL` garantiza
      -- que a nadie se le rote un enlace que ya recibió.
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
    'not_eligible', v_no_habilitados,
    -- Personas del curso a las que NO se les pidió porque el documento ya
    -- generado no las incluye. La comodidad para cerrarlo: report_append_students.
    'not_in_document', v_sin_documento
  );
END;
$$;

REVOKE ALL ON FUNCTION public.request_report_signatures(uuid, uuid[], boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_report_signatures(uuid, uuid[], boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.request_report_signatures(uuid, uuid[], boolean) TO authenticated;

-- ── 3 · El trigger de propagación: no propagar firmas huérfanas ────────────
-- Cuando alguien se matricula, el trigger propagaba una fila de firma para cada
-- informe de curso ya mandado a firmar — SIN mirar si el documento lo ancla.
-- Ahora se separa por informe:
--   * ancla al nuevo matriculado  → se le pide la firma (como antes) + se le
--     avisa a él.
--   * NO lo ancla                 → NO se crea firma huérfana; se avisa al/los
--     DOCENTE(s) del curso para que actualicen el documento.
--
-- El aviso al docente usa un kind PROPIO (`report_roster_gap`) que NO está en
-- `_notification_kind_emails`, así que es solo-campana (sin correo) y no toca el
-- invariante de 3 lados del predicado kind→email.
DO $mig$
BEGIN
  IF to_regclass('public.course_enrollments') IS NULL THEN
    RAISE NOTICE 'course_enrollments ausente; nada que hacer.';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.tg_enroll_propagate_snapshots()
  RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, extensions AS $fn$
  DECLARE
    _uid uuid := NEW.user_id;
    _cid uuid := NEW.course_id;
    _gr record;
    _requested_by uuid;
    _token text;
    _filas int;
    _estudiante text;
    _curso text;
  BEGIN
    IF _uid IS NULL OR _cid IS NULL THEN
      RETURN NEW;
    END IF;

    BEGIN
      -- ── 1) exam_assignments para exámenes VIGENTES ya rosterizados ──────
      -- Vigente = no en papelera y no vencido. No externos. Ya rosterizado =
      -- tiene alguna asignación. Y aún no asignado a ESTE alumno.
      IF to_regclass('public.exam_assignments') IS NOT NULL
         AND to_regclass('public.exams') IS NOT NULL THEN
        INSERT INTO public.exam_assignments (exam_id, user_id)
        SELECT e.id, _uid
          FROM public.exams e
         WHERE e.course_id = _cid
           AND e.deleted_at IS NULL
           AND COALESCE(e.is_external, false) = false
           AND (e.end_time IS NULL OR e.end_time > now())
           AND EXISTS (SELECT 1 FROM public.exam_assignments ea
                        WHERE ea.exam_id = e.id)
           AND NOT EXISTS (SELECT 1 FROM public.exam_assignments ea2
                            WHERE ea2.exam_id = e.id AND ea2.user_id = _uid);
      END IF;

      -- ── 2) report_signatures para informes ya mandados a firmar ─────────
      -- Solo informes del curso a nivel CURSO (student_id NULL) que YA tienen
      -- firmas pedidas, y que aún no se le pidieron a este alumno. Se decide POR
      -- INFORME según si su HTML ancla al alumno.
      IF to_regclass('public.report_signatures') IS NOT NULL
         AND to_regclass('public.generated_reports') IS NOT NULL THEN
        FOR _gr IN
          SELECT gr.id, gr.html, COALESCE(gr.template_name, 'Informe') AS template_name
            FROM public.generated_reports gr
           WHERE gr.course_id = _cid
             AND gr.student_id IS NULL
             AND EXISTS (SELECT 1 FROM public.report_signatures rs
                          WHERE rs.report_id = gr.id)
             AND NOT EXISTS (SELECT 1 FROM public.report_signatures rs2
                              WHERE rs2.report_id = gr.id AND rs2.user_id = _uid)
        LOOP
          IF public.report_html_has_signer(_gr.html, _uid) THEN
            -- El documento SÍ lo ancla: se le pide la firma como antes.
            SELECT rs0.requested_by INTO _requested_by
              FROM public.report_signatures rs0
             WHERE rs0.report_id = _gr.id
             ORDER BY rs0.requested_at ASC NULLS LAST
             LIMIT 1;
            _token := encode(extensions.gen_random_bytes(16), 'hex');
            INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
            VALUES (_gr.id, _uid, _requested_by, _token)
            ON CONFLICT (report_id, user_id) DO NOTHING;
            GET DIAGNOSTICS _filas = ROW_COUNT;
            IF _filas > 0 THEN
              INSERT INTO public.notifications (user_id, kind, title, body, link)
              VALUES (
                _uid, 'report_signature',
                '✍️ Tienes un documento para firmar',
                _gr.template_name || ' — revísalo y confirma tu aceptación.',
                '/app/student/signatures'
              );
            END IF;
          ELSE
            -- El documento NO lo ancla: no se crea una firma huérfana. Se avisa
            -- al/los docente(s) para que actualicen el documento. Texto sin
            -- jerga técnica (P6): "documento", "estudiante", nombres reales.
            SELECT p.full_name INTO _estudiante FROM public.profiles p WHERE p.id = _uid;
            SELECT c.name INTO _curso FROM public.courses c WHERE c.id = _cid;
            INSERT INTO public.notifications (user_id, kind, title, body, link)
            SELECT ct.user_id, 'report_roster_gap',
                   '📄 Un estudiante nuevo no está en un documento',
                   COALESCE(_estudiante, 'Un estudiante') || ' se matriculó en '
                     || COALESCE(_curso, 'un curso') || ' pero el documento «'
                     || _gr.template_name || '» ya generado no lo incluye. '
                     || 'Actualízalo para poder pedirle la firma.',
                   '/app/teacher/reports'
              FROM public.course_teachers ct
             WHERE ct.course_id = _cid;
          END IF;
        END LOOP;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- La matrícula es más importante que la propagación. Si algo falla, no se
      -- aborta el INSERT de course_enrollments.
      NULL;
    END;

    RETURN NEW;
  END
  $fn$;

  DROP TRIGGER IF EXISTS trg_enroll_propagate_snapshots ON public.course_enrollments;
  CREATE TRIGGER trg_enroll_propagate_snapshots
    AFTER INSERT ON public.course_enrollments
    FOR EACH ROW
    EXECUTE FUNCTION public.tg_enroll_propagate_snapshots();
END $mig$;

-- ── 4 · Agregar matriculados faltantes a un informe ya generado ────────────
-- Comodidad para cerrar el hueco desde la app, sin regenerar (que crearía un id
-- nuevo y dejaría huérfanas las firmas ya recolectadas, atadas al id viejo).
--
-- El cliente rinde un fragmento con la MISMA plantilla (así las columnas calzan)
-- y manda solo las filas de los faltantes. Acá:
--   * se autoriza igual que request_report_signatures / report_set_public;
--   * se valida SERVER-SIDE cada id (matriculado, NO ya anclado, presente en el
--     fragmento) — nunca se confía en lo que calcula el cliente;
--   * se CONCATENA el fragmento (html || _new_html): la operación mínima y
--     auditable, sin reescribir un byte del snapshot → ninguna firma ya puesta
--     (que se empareja por data-firma-uid, no por posición) se altera;
--   * se piden las firmas por el camino de siempre (request_report_signatures),
--     que ahora encuentra las ranuras nuevas en el HTML.
CREATE OR REPLACE FUNCTION public.report_append_students(
  _report_id uuid,
  _new_html text,
  _user_ids uuid[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_course uuid;
  v_html text;
  v_validos uuid[] := ARRAY[]::uuid[];
  v_uidf uuid;
  v_res jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;

  IF _new_html IS NULL OR length(_new_html) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'empty_html');
  END IF;
  -- Tope sano: el fragmento son unas filas de tabla. 200 KB deja lugar de sobra
  -- para un curso entero y frena que se use para inflar el documento.
  IF length(_new_html) > 200000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'html_too_large');
  END IF;

  SELECT gr.course_id, gr.html INTO v_course, v_html
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

  IF public._course_in_papelera(v_course) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'report_not_found');
  END IF;

  -- Cada id debe (1) estar matriculado, (2) NO estar ya anclado en el documento,
  -- y (3) venir de verdad en el fragmento (para no crear una firma sin ranura
  -- donde dibujarse — el bug que esta función existe para no repetir).
  FOREACH v_uidf IN ARRAY COALESCE(_user_ids, ARRAY[]::uuid[])
  LOOP
    IF EXISTS (SELECT 1 FROM public.course_enrollments ce
                WHERE ce.course_id = v_course AND ce.user_id = v_uidf)
       AND NOT public.report_html_has_signer(v_html, v_uidf)
       AND public.report_html_has_signer(_new_html, v_uidf)
    THEN
      v_validos := array_append(v_validos, v_uidf);
    END IF;
  END LOOP;

  IF array_length(v_validos, 1) IS NULL THEN
    -- Nada que agregar: no se toca el documento. 0 en vez de error para que el
    -- cliente lo muestre como "no había faltantes".
    RETURN jsonb_build_object('ok', true, 'appended', 0, 'requested', 0);
  END IF;

  UPDATE public.generated_reports
     SET html = html || _new_html
   WHERE id = _report_id;

  -- Ahora que las ranuras están en el html, se piden las firmas por el camino de
  -- siempre. Corre como el mismo caller autenticado (auth.uid() coincide).
  v_res := public.request_report_signatures(_report_id, v_validos, true);

  RETURN jsonb_build_object(
    'ok', true,
    'appended', array_length(v_validos, 1),
    'requested', COALESCE((v_res->>'requested')::int, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.report_append_students(uuid, text, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_append_students(uuid, text, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.report_append_students(uuid, text, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.report_append_students(uuid, text, uuid[]) IS
  'Agrega filas de matriculados faltantes al HTML de un informe ya generado (append-only) y pide sus firmas. Docente del curso / Admin de la institucion / SuperAdmin.';

NOTIFY pgrst, 'reload schema';
