-- ══════════════════════════════════════════════════════════════════════════
-- Las cajas vacías del Acuerdo Pedagógico, y borrar la firma de una persona.
--
-- ── El diagnóstico, campo por campo ───────────────────────────────────────
-- El formato DO-F-021 sale con seis casillas en blanco, y cada una está vacía
-- por un motivo DISTINTO. Medido contra el curso real de la captura:
--
--   Grupo, Semestre         → la variable YA existe (`curso.grupo`,
--                             `curso.semestre`); el curso las tiene en NULL.
--                             Falta el DATO, no la caja: se llenan editando el
--                             curso y el documento las toma solo.
--   Objetivos del Curso     → salen de la ASIGNATURA del plan
--                             (`academic_subjects.objetivos`), y ese curso no
--                             está vinculado a ninguna (`subject_id IS NULL`).
--                             Se arregla vinculándolo, no tocando la plantilla.
--   Nombre del vocero       → el dato EXISTE y no había variable. Esto lo arregla.
--   E-mail del vocero       → idem.
--   Teléfono                → no existía en NINGUNA tabla. Esto crea dónde.
--   Ciudad                  → tampoco existía. Esto crea dónde.
--
-- ── Dónde va el teléfono del vocero, y por qué ahí ────────────────────────
-- En `course_enrollments`, al lado de la marca de vocero (`vocero_marcado_at`,
-- mig 20261880000000). Tres razones:
--   * El formato pide el teléfono DEL VOCERO PARA ESE ACUERDO, no el teléfono
--     personal permanente de una persona. Vivir junto a la marca dice eso.
--   * `profiles` no tiene teléfono y agregárselo abriría la pregunta de quién lo
--     edita y con qué permiso. Acá el docente ya escribe cuando marca al vocero:
--     cero superficie de permisos nueva.
--   * Si un estudiante es vocero en dos cursos, cada acuerdo lleva su propio
--     contacto. Eso no es duplicación accidental: es lo correcto.
--
-- ── Dónde va la ciudad ────────────────────────────────────────────────────
-- En `app_settings`, que es el singleton POR INSTITUCIÓN que ya existe, ya lo
-- provisiona `tg_provision_tenant_defaults` y ya tiene panel de Admin. La ciudad
-- de la sede no cambia por curso ni por documento: se escribe una vez y la usan
-- todos los informes.
--
-- ── Borrar la firma de una persona ────────────────────────────────────────
-- Se BORRA LA FIRMA, no la solicitud: `signed_at`, `signed_hash`,
-- `signed_drawing`, `signed_user_agent` y `signed_via` vuelven a NULL y la fila
-- queda pendiente otra vez, así que la persona puede volver a firmar. Borrar la
-- fila entera dejaría a alguien fuera del documento sin que nadie lo note, y el
-- caso real es el inverso: firmó por error, o firmó el equivocado, y hay que
-- pedirle que lo haga de nuevo.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1 · Teléfono del vocero y ciudad de la institución ────────────────────
DO $mig$
BEGIN
  IF to_regclass('public.course_enrollments') IS NOT NULL THEN
    ALTER TABLE public.course_enrollments
      ADD COLUMN IF NOT EXISTS vocero_telefono TEXT;
    COMMENT ON COLUMN public.course_enrollments.vocero_telefono IS
      'Telefono de contacto del vocero PARA ESTE acuerdo. Lo escribe el docente al marcarlo.';
  ELSE
    RAISE NOTICE 'Sin course_enrollments: se omite el telefono del vocero.';
  END IF;

  IF to_regclass('public.app_settings') IS NOT NULL THEN
    ALTER TABLE public.app_settings
      ADD COLUMN IF NOT EXISTS ciudad TEXT;
    COMMENT ON COLUMN public.app_settings.ciudad IS
      'Ciudad de la sede. La usan los informes; se escribe una vez por institucion.';
  ELSE
    RAISE NOTICE 'Sin app_settings: se omite la ciudad.';
  END IF;
END $mig$;

-- ── 2 · Marcar al vocero, ahora con teléfono ──────────────────────────────
-- Se agrega un argumento OPCIONAL al final para no romper a ningún llamador que
-- siga invocando la firma de dos argumentos. Y NO se toca la autorización: se
-- reusa exactamente la que la función ya tenía.
DO $sv$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'set_course_vocero'
   LIMIT 1;

  IF v_def IS NULL THEN
    RAISE NOTICE 'set_course_vocero no existe: se omite el telefono en el RPC.';
    RETURN;
  END IF;
  RAISE NOTICE 'set_course_vocero existe; el telefono se guarda con su propio RPC.';
END $sv$;

-- El teléfono se guarda aparte en vez de reescribir `set_course_vocero`: esa
-- función ya tiene su autorización probada y su propio contrato, y reemplazarla
-- entera para sumarle un campo es la clase de cambio que rompe lo que ya andaba.
CREATE OR REPLACE FUNCTION public.set_course_vocero_telefono(
  _course_id uuid,
  _user_id uuid,
  _telefono text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ok  boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;

  -- Misma autorización que el resto de las acciones del docente sobre su curso:
  -- docente del curso, Admin de la institución de ese curso, o SuperAdmin (esto
  -- último ya viene dentro de `is_admin_of_course_tenant`). Una rama
  -- `has_role('Admin')` suelta sería un leak cross-tenant.
  SELECT EXISTS (
    SELECT 1 FROM public.courses c
     WHERE c.id = _course_id
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

  UPDATE public.course_enrollments
     SET vocero_telefono = NULLIF(btrim(COALESCE(_telefono, '')), '')
   WHERE course_id = _course_id AND user_id = _user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_enrolled');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.set_course_vocero_telefono(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_course_vocero_telefono(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_course_vocero_telefono(uuid, uuid, text) TO authenticated;

-- ── 3 · Borrar la firma de una persona ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.teacher_clear_report_signature(
  _report_id uuid,
  _user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_curso uuid;
  v_ok    boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;

  SELECT gr.course_id INTO v_curso
    FROM public.generated_reports gr WHERE gr.id = _report_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.courses c
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

  -- La SOLICITUD sobrevive; lo que se borra es la firma. Idempotente: borrar una
  -- que ya estaba pendiente no es un error.
  UPDATE public.report_signatures
     SET signed_at         = NULL,
         signed_hash       = NULL,
         signed_drawing    = NULL,
         signed_user_agent = NULL,
         signed_via        = NULL
   WHERE report_id = _report_id AND user_id = _user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_requested');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_clear_report_signature(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_clear_report_signature(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_clear_report_signature(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.teacher_clear_report_signature(uuid, uuid) IS
  'Borra la FIRMA de una persona en un informe y deja la solicitud pendiente para que pueda firmar de nuevo. Docente del curso / Admin de la institucion / SuperAdmin.';

-- ── 4 · Las cajas de la plantilla global, conectadas ──────────────────────
-- Reemplazo puntual, no re-siembra del cuerpo entero: esta plantilla viene de
-- varias migraciones sucesivas (texto, generalización, maquetación, ranuras de
-- firma) y volver a escribirla completa pisaría lo que aquellas corrigieron.
--
-- Global = `owner_id IS NULL AND course_id IS NULL`. `report_templates` NO tiene
-- `tenant_id`; asumirlo tumbó un despliegue este mes.
DO $tpl$
DECLARE
  v_n integer := 0;
  v_celda text;
BEGIN
  IF to_regclass('public.report_templates') IS NULL THEN
    RAISE NOTICE 'Sin report_templates: nada que actualizar.';
    RETURN;
  END IF;

  -- Cada casilla en blanco del bloque del vocero es el MISMO html
  -- (`<span style="font-size:9pt">&nbsp;</span>` dentro de su celda), así que no
  -- se puede reemplazar por texto: hay que ir por la etiqueta que la precede.
  -- Se hace con `regexp_replace` sobre el par (rótulo, celda siguiente).
  UPDATE public.report_templates
     SET body_html = regexp_replace(
           body_html,
           '(Nombre del vocero</span></p></td>.*?<span style="font-size:9pt">)&nbsp;',
           '\1{{curso.vocero.nombre}}',
           'g'
         )
   WHERE name = 'Acuerdo Pedagógico'
     AND owner_id IS NULL AND course_id IS NULL
     AND position('{{curso.vocero.nombre}}' in body_html) = 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'Vocero: % fila(s).', v_n;

  UPDATE public.report_templates
     SET body_html = regexp_replace(
           body_html,
           '(Teléfono</span></p></td>.*?<span style="font-size:9pt">)&nbsp;',
           '\1{{curso.vocero.telefono}}',
           'g'
         )
   WHERE name = 'Acuerdo Pedagógico'
     AND owner_id IS NULL AND course_id IS NULL
     AND position('{{curso.vocero.telefono}}' in body_html) = 0;

  UPDATE public.report_templates
     SET body_html = regexp_replace(
           body_html,
           '(E–mail</span></p></td>.*?<span style="font-size:9pt">)&nbsp;',
           '\1{{curso.vocero.email}}',
           'g'
         )
   WHERE name = 'Acuerdo Pedagógico'
     AND owner_id IS NULL AND course_id IS NULL
     AND position('{{curso.vocero.email}}' in body_html) = 0;

  UPDATE public.report_templates
     SET body_html = regexp_replace(
           body_html,
           '(Ciudad</span></p></td>.*?<span style="font-size:9pt">)&nbsp;',
           '\1{{institucion.ciudad}}',
           'g'
         )
   WHERE name = 'Acuerdo Pedagógico'
     AND owner_id IS NULL AND course_id IS NULL
     AND position('{{institucion.ciudad}}' in body_html) = 0;

  SELECT substring(body_html from '\{\{curso\.vocero\.nombre\}\}') INTO v_celda
    FROM public.report_templates
   WHERE name = 'Acuerdo Pedagógico' AND owner_id IS NULL AND course_id IS NULL
   LIMIT 1;
  IF v_celda IS NULL THEN
    -- Que no haya coincidido NO se traga en silencio: si la maquetación cambió,
    -- alguien tiene que enterarse en el log del despliegue en vez de descubrirlo
    -- cuando el documento sale con la casilla vacía otra vez.
    RAISE NOTICE 'ATENCION: no se pudo insertar la variable del vocero; revisar la maquetacion de la plantilla.';
  END IF;
END $tpl$;

NOTIFY pgrst, 'reload schema';
