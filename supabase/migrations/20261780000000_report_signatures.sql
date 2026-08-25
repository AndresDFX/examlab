-- ══════════════════════════════════════════════════════════════════════
-- Enviar un informe a firmar, y que el estudiante lo firme.
--
-- Caso de uso: el Acuerdo Pedagógico. El docente lo genera y, en vez de
-- imprimirlo para que circule con una lapicera, lo manda a firmar a uno o a
-- varios estudiantes del curso. Cada firma queda con QUIÉN firmó y CUÁNDO.
--
-- ── Qué se firma: un documento CONGELADO ──────────────────────────────
-- Se firma un `generated_reports`, no una plantilla. Esa tabla ya guarda el
-- HTML compuesto (`html`), o sea el documento tal como se vio al generarse. Es
-- la única forma de que la firma signifique algo: si se firmara la plantilla, el
-- docente podría editarla después y el estudiante quedaría atado a un texto que
-- nunca leyó.
--
-- ── Modelo de escritura: SOLO por RPC ─────────────────────────────────
-- `report_signatures` NO tiene policy de INSERT ni de UPDATE, a propósito. Con
-- una policy owner-writable, un estudiante podría POSTear su propia firma por
-- REST —con la fecha que quisiera, o la de un compañero— sin haber abierto nada.
-- Es la misma clase de vulnerabilidad que el repo ya evita en
-- `content_file_progress` y `workshop_submission_video_views`: la fila se
-- escribe únicamente por `sign_report`, que toma la identidad de `auth.uid()` y
-- NO acepta un `_user_id` como parámetro. La firma no se puede delegar ni
-- falsear desde el cliente.
--
-- ── Lo que esto NO es ─────────────────────────────────────────────────
-- NO es una firma digital ni una firma electrónica avanzada: no hay
-- certificado, ni clave privada del firmante, ni sello de tiempo de un tercero.
-- Es un registro de aceptación autenticado: consta que la persona dueña de esa
-- cuenta, estando en sesión, aceptó un documento identificado por su hash, y en
-- qué momento. Alcanza para un acuerdo pedagógico; NO alcanza para nada que
-- necesite valor probatorio ante un tercero, y por eso la UI dice "Firmar" pero
-- ningún texto la llama "firma digital".
--
-- ── El hash ───────────────────────────────────────────────────────────
-- Se guarda el SHA-256 del HTML firmado. Sirve para una cosa concreta: detectar
-- que el documento cambió después de firmarse. Precedente en el repo:
-- `course_actas.integrity_hash` y `certificates.payload_hash`.
--
-- Limitación conocida y deliberada: `generated_reports` se puede BORRAR desde la
-- UI del docente (policy `generated_reports_delete`). Un informe firmado se
-- puede eliminar entero, y con él sus firmas por CASCADE. No se cambia acá
-- porque bloquear el borrado de informes es una decisión de producto más amplia
-- que este cambio; queda anotado.
-- ══════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $mig$
BEGIN
  IF to_regclass('public.generated_reports') IS NULL THEN
    RAISE NOTICE 'generated_reports ausente — se omiten las firmas de informes';
    RETURN;
  END IF;

  IF to_regclass('public.report_signatures') IS NULL THEN
    CREATE TABLE public.report_signatures (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      report_id uuid NOT NULL REFERENCES public.generated_reports(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      -- Quién pidió la firma y cuándo. `requested_by` es el docente.
      requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
      requested_at timestamptz NOT NULL DEFAULT now(),
      -- NULL mientras está pendiente. Es el estado, no una columna aparte: un
      -- `status` redundante se desincroniza de la fecha en la primera corrección.
      signed_at timestamptz,
      -- SHA-256 del HTML que se firmó. Sirve para detectar que el documento
      -- cambió después.
      signed_hash text,
      -- Contexto de la firma, para responder un reclamo ("yo no firmé eso").
      signed_ip text,
      signed_user_agent text,
      created_at timestamptz NOT NULL DEFAULT now(),
      -- Una sola solicitud por (informe, persona).
      CONSTRAINT uq_report_signatures UNIQUE (report_id, user_id)
    );
  END IF;

  CREATE INDEX IF NOT EXISTS idx_report_signatures_user
    ON public.report_signatures(user_id) WHERE signed_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_report_signatures_report
    ON public.report_signatures(report_id);

  EXECUTE 'ALTER TABLE public.report_signatures ENABLE ROW LEVEL SECURITY';
END $mig$;

-- ── Lectura ───────────────────────────────────────────────────────────
-- El firmante ve LO SUYO. El docente del curso y el Admin de la institución ven
-- las del informe. Nadie más.
DROP POLICY IF EXISTS report_signatures_select ON public.report_signatures;
CREATE POLICY report_signatures_select ON public.report_signatures
  FOR SELECT USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1
        FROM public.generated_reports gr
        JOIN public.courses c ON c.id = gr.course_id
       WHERE gr.id = public.report_signatures.report_id
         AND (
           EXISTS (SELECT 1 FROM public.course_teachers ct
                    WHERE ct.course_id = c.id AND ct.user_id = auth.uid())
           OR public.is_admin_of_course_tenant(c.id)
         )
    )
  );

-- NO hay policy de INSERT ni de UPDATE: ver el encabezado. Todo pasa por RPC.

-- El docente puede retirar una solicitud que TODAVÍA no se firmó. Una firma
-- puesta no se borra: sería reescribir la historia del documento.
DROP POLICY IF EXISTS report_signatures_delete_pending ON public.report_signatures;
CREATE POLICY report_signatures_delete_pending ON public.report_signatures
  FOR DELETE USING (
    signed_at IS NULL
    AND EXISTS (
      SELECT 1
        FROM public.generated_reports gr
        JOIN public.courses c ON c.id = gr.course_id
       WHERE gr.id = public.report_signatures.report_id
         AND (
           EXISTS (SELECT 1 FROM public.course_teachers ct
                    WHERE ct.course_id = c.id AND ct.user_id = auth.uid())
           OR public.is_admin_of_course_tenant(c.id)
         )
    )
  );

-- ── El docente pide la firma a uno o a VARIOS ─────────────────────────
CREATE OR REPLACE FUNCTION public.request_report_signatures(
  _report_id uuid,
  _user_ids uuid[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_course uuid;
  v_titulo text;
  v_pedidas int := 0;
  v_omitidas int := 0;
  v_uid_estudiante uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;

  SELECT gr.course_id, COALESCE(gr.template_name, 'Informe')
    INTO v_course, v_titulo
    FROM public.generated_reports gr
   WHERE gr.id = _report_id;
  IF v_course IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'report_not_found');
  END IF;

  -- Solo el docente DEL CURSO o el Admin de su institución. `has_role` a secas
  -- no alcanza: los roles son globales y dejaría pedir firmas en un curso ajeno.
  IF NOT (
    EXISTS (SELECT 1 FROM public.course_teachers ct
             WHERE ct.course_id = v_course AND ct.user_id = v_uid)
    OR public.is_admin_of_course_tenant(v_course)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  FOREACH v_uid_estudiante IN ARRAY COALESCE(_user_ids, ARRAY[]::uuid[])
  LOOP
    -- Solo a quien está MATRICULADO en el curso del informe. Sin esto, el
    -- docente podría pedirle la firma a cualquier usuario de la plataforma.
    IF NOT EXISTS (
      SELECT 1 FROM public.course_enrollments ce
       WHERE ce.course_id = v_course AND ce.user_id = v_uid_estudiante
    ) THEN
      v_omitidas := v_omitidas + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.report_signatures (report_id, user_id, requested_by)
    VALUES (_report_id, v_uid_estudiante, v_uid)
    ON CONFLICT (report_id, user_id) DO NOTHING;

    IF FOUND THEN
      v_pedidas := v_pedidas + 1;
      -- Aviso al estudiante. `kind='report_signature'` para que el pipeline de
      -- notificaciones lo trate como cualquier otro.
      INSERT INTO public.notifications (user_id, kind, title, body, link)
      VALUES (
        v_uid_estudiante,
        'report_signature',
        '✍️ Tienes un documento para firmar',
        v_titulo || ' — revísalo y confirma tu aceptación.',
        '/app/student/signatures'
      );
    ELSE
      v_omitidas := v_omitidas + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'requested', v_pedidas, 'skipped', v_omitidas);
END;
$$;

REVOKE ALL ON FUNCTION public.request_report_signatures(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_report_signatures(uuid, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.request_report_signatures(uuid, uuid[]) TO authenticated;

-- ── El estudiante firma ───────────────────────────────────────────────
-- La identidad NO es un parámetro: sale de `auth.uid()`. Por eso nadie puede
-- firmar por otro, ni por REST directo.
-- `search_path` incluye `extensions` y `digest` va con prefijo: en Supabase
-- moderno pgcrypto vive en ese schema, y una SECURITY DEFINER con
-- `SET search_path = public` falla con "function digest does not exist". El
-- proyecto ya tropezó con esto (mig 20260507100100, "pgcrypto_fix") — no se
-- vuelve a tropezar.
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
    -- No se distingue "no te lo pidieron" de "no existe": no hay por qué
    -- confirmarle a nadie qué informes existen.
    RETURN jsonb_build_object('ok', false, 'error', 'not_requested');
  END IF;

  IF v_fila.signed_at IS NOT NULL THEN
    -- Idempotente: volver a pulsar Firmar no cambia la fecha original.
    RETURN jsonb_build_object('ok', true, 'already', true, 'signed_at', v_fila.signed_at);
  END IF;

  SELECT gr.html INTO v_html FROM public.generated_reports gr WHERE gr.id = _report_id;

  UPDATE public.report_signatures
     SET signed_at = now(),
         signed_hash = encode(extensions.digest(COALESCE(v_html, ''), 'sha256'), 'hex'),
         signed_user_agent = left(COALESCE(_user_agent, ''), 400)
   WHERE report_id = _report_id AND user_id = v_uid;

  RETURN jsonb_build_object('ok', true, 'signed_at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.sign_report(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sign_report(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.sign_report(uuid, text) TO authenticated;

-- ── El estudiante necesita LEER el documento que le piden firmar ──────
-- `generated_reports` no tiene rama de alumno en su policy de SELECT (es una
-- tabla del docente), así que sin esto el estudiante vería "tienes algo para
-- firmar" y no podría abrirlo. Se expone SOLO el informe que le pidieron.
CREATE OR REPLACE FUNCTION public.get_report_to_sign(_report_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_r record;
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
  RETURN jsonb_build_object(
    'ok', true,
    'html', v_r.html,
    'template_name', v_r.template_name,
    'course_name', v_r.course_name,
    'signed_at', v_r.signed_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_report_to_sign(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_report_to_sign(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_report_to_sign(uuid) TO authenticated;

COMMENT ON TABLE public.report_signatures IS
  'Aceptacion autenticada de un informe generado. Sin policy de INSERT/UPDATE: se escribe solo por sign_report(), que toma la identidad de auth.uid(). NO es una firma digital.';
