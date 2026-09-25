-- ══════════════════════════════════════════════════════════════════════
-- Agregar estudiantes a un Acuerdo, DENTRO de su listado.
--
-- `report_append_students` (20262230000000) hace `SET html = html || _new_html`
-- y el cliente le manda las filas envueltas en una tabla nueva titulada
-- «Estudiantes matriculados con posterioridad». El acta queda partida: 33
-- estudiantes en una tabla y uno en otra, debajo del bloque de firmas, con la
-- numeración arrancando de nuevo en 1. Para quien la lee —una coordinación, una
-- auditoría— eso no es una aclaración útil: es un documento que parece
-- incompleto.
--
-- Esta función recibe el HTML YA COMPUESTO por el cliente, que sabe dónde va el
-- listado (`insertar-filas.ts`, con sus pruebas). Buscar la tabla desde
-- PL/pgSQL habría significado escribir ese mismo recorrido de etiquetas dos
-- veces, en dos lenguajes, sobre HTML que viene de un `.docx` y anida tablas —
-- la clase de invariante duplicada que este proyecto ya pagó caro.
--
-- Lo que el servidor NO delega, porque es lo que protege el documento:
--
--   · La autorización (docente DEL curso o Admin de su institución) y el
--     rechazo si el curso está en la papelera. Igual que la anterior.
--   · Que cada persona que se agrega tenga de verdad su casilla en las filas
--     nuevas — si no, se le crea una solicitud de firma que no puede cumplir.
--   · **Que no se pierda NADIE.** Como acá el cliente manda el documento
--     entero y no un fragmento a concatenar, un error suyo podría borrar
--     firmantes. Se verifica que toda persona con una solicitud de firma ya
--     existente siga teniendo su casilla en el HTML nuevo. La versión anterior
--     no necesitaba esta comprobación porque concatenar no puede perder nada;
--     insertar sí, y por eso se agrega.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.report_add_students_inline(
  _report_id uuid,
  _full_html text,
  _new_rows  text,
  _user_ids  uuid[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_course  uuid;
  v_validos uuid[] := '{}';
  v_uidf    uuid;
  v_perdido uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;
  IF _full_html IS NULL OR length(_full_html) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'empty_html');
  END IF;
  IF length(_full_html) > 4000000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'html_too_large');
  END IF;

  SELECT gr.course_id INTO v_course FROM public.generated_reports gr WHERE gr.id = _report_id;
  IF v_course IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF NOT (
    EXISTS (SELECT 1 FROM public.course_teachers ct
             WHERE ct.course_id = v_course AND ct.user_id = v_uid)
    OR public.is_admin_of_course_tenant(v_course)
    OR public.is_super_admin()
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  IF public._course_in_papelera(v_course) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'course_in_trash');
  END IF;

  -- Nadie se pierde: quien ya tenía solicitud debe seguir teniendo su casilla.
  SELECT rs.user_id INTO v_perdido
    FROM public.report_signatures rs
   WHERE rs.report_id = _report_id
     AND NOT public.report_html_has_signer(_full_html, rs.user_id)
   LIMIT 1;
  IF v_perdido IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'would_drop_signer');
  END IF;

  -- Solo matriculados del curso Y con casilla en las filas nuevas.
  FOREACH v_uidf IN ARRAY COALESCE(_user_ids, '{}')
  LOOP
    IF EXISTS (SELECT 1 FROM public.course_enrollments ce
                WHERE ce.course_id = v_course AND ce.user_id = v_uidf)
       AND public.report_html_has_signer(_new_rows, v_uidf)
    THEN
      v_validos := array_append(v_validos, v_uidf);
    END IF;
  END LOOP;

  IF array_length(v_validos, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_valid_users');
  END IF;

  UPDATE public.generated_reports SET html = _full_html WHERE id = _report_id;

  INSERT INTO public.report_signatures (report_id, user_id, requested_by, requested_at)
  SELECT _report_id, u, v_uid, now() FROM unnest(v_validos) AS u
  ON CONFLICT (report_id, user_id) DO NOTHING;

  RETURN jsonb_build_object('ok', true, 'appended', array_length(v_validos, 1));
END
$$;

REVOKE ALL ON FUNCTION public.report_add_students_inline(uuid, text, text, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_add_students_inline(uuid, text, text, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.report_add_students_inline(uuid, text, text, uuid[]) TO authenticated;
