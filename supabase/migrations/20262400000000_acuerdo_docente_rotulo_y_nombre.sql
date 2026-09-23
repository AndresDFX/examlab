-- ═══════════════════════════════════════════════════════════════════════
-- El Acuerdo dice «Docente», y los ya firmados llevan el nombre completo
-- ═══════════════════════════════════════════════════════════════════════
-- Dos cosas pedidas sobre el mismo documento, con alcances distintos a
-- propósito.
--
-- ── 1) El rótulo: «Profesor» → «Docente». Solo hacia adelante ─────────
-- Dentro de la MISMA plantilla convivían «Profesor» (una vez, el rótulo de la
-- cabecera) y «Docente» (cuatro veces, incluido «El Docente / Tutor» del bloque
-- de firmas). Y en toda la plataforma hay 188 textos visibles con «docente» y
-- ninguno con «profesor» como rótulo: viene del `.docx` original. Se cambia en
-- la PLANTILLA, así que aplica a los Acuerdos que se generen de ahora en
-- adelante y no toca ningún documento ya firmado.
--
-- ── 2) El nombre del docente en los YA generados ─────────────────────
-- `generated_reports` guarda el HTML como instantánea, así que los siete
-- Acuerdos de septiembre siguen diciendo «Andres Castaño», que es el nombre que
-- el perfil tenía ese día. Hoy dice «Julian Andres Castaño Espinosa».
--
-- Esto SÍ toca documentos firmados, y por eso el alcance es mínimo: se reemplaza
-- únicamente el texto de la celda del docente, identificada por su marcado —no
-- un `replace` del nombre en todo el HTML—. Importa: en esos mismos documentos
-- hay ESTUDIANTES apellidados Castaño, y un reemplazo global les cambiaría el
-- nombre a ellos.
--
-- Lo que esto cuesta, y está aceptado: `signed_hash` es el sha256 del HTML al
-- firmar. Las firmas existentes NO se invalidan —nada recalcula ese hash contra
-- el HTML actual; el único consumidor es `hashDivergente`, que compara los
-- hashes ENTRE firmas— pero quien firme DESPUÉS de esto va a firmar una versión
-- distinta de la que firmaron los anteriores, y la plataforma va a marcar ese
-- Acuerdo como «firmas sobre versiones distintas». Es el mecanismo funcionando:
-- el documento efectivamente cambió.
--
-- Deliberadamente NO se re-calculan los hashes viejos para tapar ese aviso. Eso
-- borraría la única evidencia de que el documento se editó después de firmado,
-- que es justo lo que la columna existe para preservar. En cambio queda el
-- rastro en `audit_logs`, con el nombre viejo y el nuevo por informe.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1) La plantilla ───────────────────────────────────────────────────
DO $mig$
DECLARE
  v_n int := 0;
BEGIN
  IF to_regclass('public.report_templates') IS NULL THEN
    RAISE NOTICE 'skip: report_templates no existe';
    RETURN;
  END IF;

  UPDATE public.report_templates
     SET body_html = replace(
           body_html,
           '<span style="font-size:9pt">Profesor</span>',
           '<span style="font-size:9pt">Docente</span>'
         ),
         updated_at = now()
   WHERE body_html LIKE '%<span style="font-size:9pt">Profesor</span>%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'Acuerdo: rotulo Profesor->Docente en % plantilla(s)', v_n;
END
$mig$;

-- ── 2) El nombre en los informes ya generados ─────────────────────────
DO $mig$
DECLARE
  -- La celda del docente, tal como queda RENDERIZADA: el rótulo, el cierre de su
  -- celda, la celda siguiente y, dentro, el nombre. Se captura el marcado de
  -- alrededor en \1 y \2 para reponerlo intacto.
  --
  -- Acepta los dos rótulos a propósito: el bloque de arriba ya pudo dejar
  -- «Docente» en la plantilla, pero los informes VIEJOS —que son los que acá se
  -- corrigen— siguen diciendo «Profesor». Sin las dos alternativas, esta parte
  -- no encontraría nada el día que alguien regenere.
  c_patron CONSTANT text :=
    '(>(?:Profesor|Docente)</span></p></td><td[^>]*><p[^>]*><span[^>]*>)([^<]*)(</span>)';
  r         record;
  v_actual  text;
  v_en_doc  text;
  v_cambiados int := 0;
  v_saltados  int := 0;
BEGIN
  IF to_regclass('public.generated_reports') IS NULL
     OR to_regclass('public.course_teachers') IS NULL
     OR to_regclass('public.profiles') IS NULL THEN
    RAISE NOTICE 'skip: falta alguna tabla';
    RETURN;
  END IF;

  FOR r IN
    SELECT g.id, g.html, g.course_id, g.course_name, g.template_name
      FROM public.generated_reports g
     WHERE g.html ~ c_patron
  LOOP
    -- El docente del curso: el PRIMERO asignado. Mismo criterio que
    -- `report-context.ts`, que ordena por `created_at` justamente para que un
    -- curso con dos docentes no salga a nombre de uno u otro según el día.
    SELECT p.full_name
      INTO v_actual
      FROM public.course_teachers ct
      JOIN public.profiles p ON p.id = ct.user_id
     WHERE ct.course_id = r.course_id
     ORDER BY ct.created_at
     LIMIT 1;

    v_en_doc := (regexp_match(r.html, c_patron))[2];

    CONTINUE WHEN v_actual IS NULL OR btrim(v_actual) = '';
    CONTINUE WHEN v_en_doc IS NULL OR v_en_doc = v_actual;

    -- El nombre se inserta como TEXTO dentro del HTML: si trajera `<`, `>`, `&`
    -- o comillas habría que escaparlo, y un escape mal hecho rompe el documento.
    -- Se salta y se avisa, en vez de arriesgar.
    IF v_actual ~ '[<>&"\\]' THEN
      v_saltados := v_saltados + 1;
      RAISE WARNING 'Acuerdo %: el nombre "%" tiene caracteres que habria que escapar; se deja como estaba',
        r.id, v_actual;
      CONTINUE;
    END IF;

    UPDATE public.generated_reports
       SET html = regexp_replace(html, c_patron, '\1' || v_actual || '\3')
     WHERE id = r.id;

    IF to_regclass('public.audit_logs') IS NOT NULL THEN
      INSERT INTO public.audit_logs (
        action, category, severity, entity_type, entity_id, entity_name,
        course_id, course_name, metadata
      ) VALUES (
        'report.teacher_name_corrected', 'reports', 'warning',
        'generated_report', r.id, r.template_name,
        r.course_id, r.course_name,
        jsonb_build_object(
          'nombre_anterior', v_en_doc,
          'nombre_nuevo', v_actual,
          'motivo', 'El perfil del docente cambio despues de generar el documento',
          'nota', 'El HTML firmado fue editado: quien firme despues lo hara sobre otra version y hashDivergente lo marcara'
        )
      );
    END IF;

    v_cambiados := v_cambiados + 1;
  END LOOP;

  RAISE NOTICE 'Acuerdo: nombre del docente corregido en % informe(s) generado(s), % saltado(s)',
    v_cambiados, v_saltados;
END
$mig$;
