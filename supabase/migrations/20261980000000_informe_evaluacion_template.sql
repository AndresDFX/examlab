-- ══════════════════════════════════════════════════════════════════════
-- Informe de evaluación — plantilla GLOBAL de plataforma + trazabilidad del
-- foco (de qué examen / taller / proyecto salió cada informe generado).
--
-- ── Qué resuelve ──────────────────────────────────────────────────────
-- El módulo de Informes ya sabía hablar del CONSOLIDADO de un curso (notas por
-- corte, nota final, asistencia), pero no del detalle de UNA evaluación. Un
-- informe de prueba diagnóstica que se le entrega al estudiante necesita
-- justamente eso: qué preguntas contestó, cuánto sacó en cada una y la
-- retroalimentación. Esta migración siembra el formato; el detalle por pregunta
-- lo aporta el contexto de informes del lado de la aplicación.
--
-- ── Por qué es una plantilla GLOBAL ───────────────────────────────────
-- En este esquema una plantilla es de PLATAFORMA (la ven todas las
-- instituciones) cuando cumple `owner_id IS NULL AND course_id IS NULL AND
-- parent_id IS NULL` — el mismo predicado de la policy `report_templates_read`.
-- **`report_templates` NO TIENE `tenant_id`**, y esa ausencia ES el mecanismo de
-- "aplicada a todas las instituciones": no hay columna que filtre. Asumir esa
-- columna tumbó un despliegue este mes; no volver a hacerlo.
-- La personalización por curso ya existe sin tocar el esquema: el docente
-- guarda una copia con `course_id` (y `parent_id` apuntando a esta fila), y ese
-- override gana sobre la global para su curso.
--
-- ── Por qué una migración NUEVA y no un retoque de otra ───────────────
-- Las migraciones se aplican una sola vez. Editar una ya aplicada no cambia
-- nada en la base y encima no se nota (le pasó a la 20261760000000). Cualquier
-- ajuste posterior a este formato va en otro archivo con timestamp mayor.
--
-- ── Idempotente ───────────────────────────────────────────────────────
-- UPDATE de la fila global y, si no existe, INSERT. Re-aplicarla no duplica.
-- El cuerpo vive en UNA sola variable (no copiado en el UPDATE y en el INSERT)
-- para que la ranura de firma aparezca exactamente una vez en este archivo.
-- ══════════════════════════════════════════════════════════════════════

-- ── Parte 1: trazabilidad del foco en los informes generados ──────────
DO $mig$
BEGIN
  IF to_regclass('public.generated_reports') IS NULL THEN
    RAISE NOTICE 'generated_reports ausente — se omite el foco';
    RETURN;
  END IF;

  -- POR QUÉ POLIMÓRFICA Y NO `exam_id`: el mismo par de columnas sirve para
  -- anotar de qué habla un informe sea un examen, un taller, un proyecto y
  -- —más adelante— el corte de un acta o la sesión de una constancia. Con una
  -- FK por tipo, cada informe nuevo pediría otra migración y otra columna
  -- nullable que casi nunca se usa. Precedente en este esquema:
  -- `similarity_pairs(kind, ref_id)` y `generated_reports.student_id`, que
  -- tampoco tiene FK. Sin CHECK a propósito: el conjunto de tipos lo define la
  -- aplicación y agregarle uno no debe requerir tocar la base.
  ALTER TABLE public.generated_reports ADD COLUMN IF NOT EXISTS foco_tipo text;
  ALTER TABLE public.generated_reports ADD COLUMN IF NOT EXISTS foco_id uuid;
END
$mig$;

-- ── Parte 2: siembra de la plantilla global ───────────────────────────
DO $mig$
DECLARE
  v_n      int := 0;
  v_desc   text;
  v_body   text;
  v_head   text;
  v_foot   text;
  v_css    text;
BEGIN
  IF to_regclass('public.report_templates') IS NULL THEN
    RAISE NOTICE 'report_templates ausente — se omite la plantilla de evaluación';
    RETURN;
  END IF;

  v_desc := 'Informe de una evaluación (examen, taller o proyecto) para entregarle al estudiante: puntaje, nota, detalle pregunta por pregunta con su retroalimentación, comparación con el grupo y ranura de firma. La evaluación se elige al generar, así que el mismo formato sirve para cualquier actividad y cualquier institución.';

  -- ENCABEZADO. El logo va SIEMPRE dentro del condicional: hay instituciones
  -- con el logo sin configurar, y una etiqueta de imagen con la dirección vacía
  -- pinta el ícono de imagen rota en Word y en la impresión.
  v_head := $head$<table style="border-collapse:collapse;width:100%;table-layout:fixed;"><tr><td style="width:26%;padding:2px 6px;vertical-align:middle;">{{#if institucion.logo}}<img src="{{institucion.logo}}" style="width:150px;max-width:100%;height:auto;" alt="" />{{/if}}</td><td style="width:48%;padding:2px 6px;vertical-align:middle;"><p style="text-align:center"><span style="font-size:14pt;font-family:'Arial'"><strong>INFORME DE EVALUACIÓN</strong></span></p><p style="text-align:center"><span style="font-size:10pt;font-family:'Arial'">{{evaluacion.titulo}}</span></p></td><td style="width:26%;padding:2px 6px;vertical-align:middle;"><p style="text-align:right"><span style="font-size:8pt;font-family:'Arial'">{{institucion.nombre}}</span></p><p style="text-align:right"><span style="font-size:8pt;font-family:'Arial'">{{fecha_emision}}</span></p></td></tr></table>$head$;

  v_foot := $foot$<p style="text-align:center"><span style="font-size:8pt">{{institucion.nombre}} · {{curso.nombre}} · {{fecha_emision}}</span></p>$foot$;

  -- Los estilos van EN LÍNEA en el cuerpo porque el documento se descarga como
  -- Word y se imprime, y ahí no llega ninguna hoja de estilos. Esta hoja solo
  -- mejora la vista previa en pantalla.
  v_css := $css$h2 { font-size: 12pt; margin: 14pt 0 4pt; font-family: Arial, sans-serif; }
p { margin: 3pt 0; font-family: Arial, sans-serif; }
table { border-collapse: collapse; width: 100%; table-layout: fixed; }
td { vertical-align: top; }
$css$;

  -- CUERPO. Ocho bloques, en el orden en que el estudiante los necesita leer:
  -- de qué actividad hablamos, quién es, cómo le fue, el detalle, dónde está
  -- respecto del grupo, qué reforzar, el resumen y la firma.
  --
  -- Reglas que el cuerpo respeta y que conviene no romper al editarlo:
  --  · Solo usa variables que el contexto de informes publica para este
  --    formato. Una variable que no resuelve NO da error: sale vacía en
  --    silencio, así que un nombre inventado no se nota hasta que alguien lee
  --    el papel.
  --  · NO incluye el criterio de corrección de las preguntas (la rúbrica).
  --    Existe como variable, pero es la clave de respuestas: no va en un
  --    documento que se le entrega al estudiante.
  --  · La firma se emite como RANURA en blanco, no como una firma resuelta. El
  --    documento generado es el que se firma, y al generarlo todavía no hay
  --    ninguna firma; las firmas se dibujan al mostrarlo.
  --  · El renglón para firmar a mano usa la clase `examlab-renglon`. NO debe
  --    llamarse con nada que contenga `examlab-firma`: la aplicación decide si
  --    un documento se puede enviar a firmar buscando esa clase como texto, y
  --    ofrecería firmar un papel sin una sola ranura firmable.
  v_body := $body$<h2>Datos de la actividad</h2>
<table style="border-collapse:collapse;width:100%;table-layout:fixed;"><tr><td style="padding:4px 6px;border:1px solid #444;width:20%;background-color:#f0f0f0;"><span style="font-size:9pt">Actividad</span></td><td style="padding:4px 6px;border:1px solid #444;width:38%;"><span style="font-size:9pt"><strong>{{evaluacion.titulo}}</strong></span></td><td style="padding:4px 6px;border:1px solid #444;width:16%;background-color:#f0f0f0;"><span style="font-size:9pt">Tipo</span></td><td style="padding:4px 6px;border:1px solid #444;width:26%;"><span style="font-size:9pt">{{evaluacion.tipo}}</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;background-color:#f0f0f0;"><span style="font-size:9pt">Curso</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">{{curso.nombre}}</span></td><td style="padding:4px 6px;border:1px solid #444;background-color:#f0f0f0;"><span style="font-size:9pt">Código</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">{{curso.codigo}}</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;background-color:#f0f0f0;"><span style="font-size:9pt">Grupo</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">{{curso.grupo}}</span></td><td style="padding:4px 6px;border:1px solid #444;background-color:#f0f0f0;"><span style="font-size:9pt">Periodo</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">{{periodo}}</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;background-color:#f0f0f0;"><span style="font-size:9pt">Docente</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">{{docente.nombre}}</span></td><td style="padding:4px 6px;border:1px solid #444;background-color:#f0f0f0;"><span style="font-size:9pt">Fecha de entrega</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">{{evaluacion.fecha_entrega}}</span></td></tr></table>
<h2>Estudiante</h2>
<table style="border-collapse:collapse;width:100%;table-layout:fixed;"><tr><td style="padding:4px 6px;border:1px solid #444;width:20%;background-color:#f0f0f0;"><span style="font-size:9pt">Nombre</span></td><td style="padding:4px 6px;border:1px solid #444;width:38%;"><span style="font-size:9pt">{{estudiante.nombre}}</span></td><td style="padding:4px 6px;border:1px solid #444;width:16%;background-color:#f0f0f0;"><span style="font-size:9pt">Código</span></td><td style="padding:4px 6px;border:1px solid #444;width:26%;"><span style="font-size:9pt">{{estudiante.codigo}}</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;background-color:#f0f0f0;"><span style="font-size:9pt">Programa</span></td><td colspan="3" style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">{{estudiante.programa}}</span></td></tr></table>
<h2>Resultado</h2>
<table style="border-collapse:collapse;width:100%;table-layout:fixed;"><tr><td style="padding:4px 6px;border:1px solid #444;width:34%;background-color:#f0f0f0;"><span style="font-size:9pt">Puntaje obtenido</span></td><td style="padding:4px 6px;border:1px solid #444;width:66%;"><span style="font-size:9pt"><strong>{{evaluacion.puntaje_obtenido}}</strong> de {{evaluacion.puntaje_total}} puntos</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;background-color:#f0f0f0;"><span style="font-size:9pt">Nota</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"><strong>{{evaluacion.nota}}</strong> de {{escala_max}}</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;background-color:#f0f0f0;"><span style="font-size:9pt">Preguntas respondidas</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">{{evaluacion.respondidas}}</span></td></tr><tr><td colspan="2" style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">{{evaluacion.aporte_nota_final}}</span></td></tr></table>
<h2>Detalle pregunta por pregunta</h2>
<table style="border-collapse:collapse;width:100%;table-layout:fixed;"><tr><td style="padding:3px 5px;border:1px solid #444;width:5%;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:8pt"><strong>N°</strong></span></p></td><td style="padding:3px 5px;border:1px solid #444;width:27%;background-color:#d9d9d9;"><span style="font-size:8pt"><strong>Pregunta</strong></span></td><td style="padding:3px 5px;border:1px solid #444;width:18%;background-color:#d9d9d9;"><span style="font-size:8pt"><strong>Tu respuesta</strong></span></td><td style="padding:3px 5px;border:1px solid #444;width:18%;background-color:#d9d9d9;"><span style="font-size:8pt"><strong>Respuesta esperada</strong></span></td><td style="padding:3px 5px;border:1px solid #444;width:8%;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:8pt"><strong>Puntaje</strong></span></p></td><td style="padding:3px 5px;border:1px solid #444;width:9%;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:8pt"><strong>Resultado</strong></span></p></td><td style="padding:3px 5px;border:1px solid #444;width:15%;background-color:#d9d9d9;"><span style="font-size:8pt"><strong>Retroalimentación</strong></span></td></tr>{{#each evaluacion.preguntas}}<tr><td style="padding:3px 5px;border:1px solid #444;"><p style="text-align:center"><span style="font-size:8pt">{{numero}}</span></p></td><td style="padding:3px 5px;border:1px solid #444;"><span style="font-size:8pt;white-space:pre-line">{{enunciado}}</span></td><td style="padding:3px 5px;border:1px solid #444;"><span style="font-size:8pt;white-space:pre-line">{{respuesta}}</span></td><td style="padding:3px 5px;border:1px solid #444;"><span style="font-size:8pt;white-space:pre-line">{{respuesta_correcta}}</span></td><td style="padding:3px 5px;border:1px solid #444;"><p style="text-align:center"><span style="font-size:8pt">{{obtenido}} / {{puntos}}</span></p></td><td style="padding:3px 5px;border:1px solid #444;"><p style="text-align:center"><span style="font-size:8pt">{{resultado}}</span></p></td><td style="padding:3px 5px;border:1px solid #444;"><span style="font-size:8pt;white-space:pre-line">{{retroalimentacion}}</span></td></tr>{{/each}}</table>
<h2>Cómo le fue al grupo</h2>
<p><span style="font-size:9pt">Promedio del curso en esta actividad: <strong>{{evaluacion.grupo.promedio_curso}}</strong> de {{escala_max}}. La última columna dice qué parte del curso resolvió bien cada pregunta, para ubicar tu resultado sin comparar nombres.</span></p>
<table style="border-collapse:collapse;width:100%;table-layout:fixed;"><tr><td style="padding:3px 5px;border:1px solid #444;width:8%;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:8pt"><strong>N°</strong></span></p></td><td style="padding:3px 5px;border:1px solid #444;width:52%;background-color:#d9d9d9;"><span style="font-size:8pt"><strong>Pregunta</strong></span></td><td style="padding:3px 5px;border:1px solid #444;width:20%;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:8pt"><strong>Tu resultado</strong></span></p></td><td style="padding:3px 5px;border:1px solid #444;width:20%;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:8pt"><strong>El curso</strong></span></p></td></tr>{{#each evaluacion.preguntas}}<tr><td style="padding:3px 5px;border:1px solid #444;"><p style="text-align:center"><span style="font-size:8pt">{{numero}}</span></p></td><td style="padding:3px 5px;border:1px solid #444;"><span style="font-size:8pt;white-space:pre-line">{{enunciado}}</span></td><td style="padding:3px 5px;border:1px solid #444;"><p style="text-align:center"><span style="font-size:8pt">{{resultado}}</span></p></td><td style="padding:3px 5px;border:1px solid #444;"><p style="text-align:center"><span style="font-size:8pt">{{porcentaje_curso}}</span></p></td></tr>{{/each}}</table>
{{#if evaluacion.preguntas_a_reforzar}}<h2>Qué conviene reforzar</h2>
<p><span style="font-size:9pt">Estas son las preguntas donde quedó algo por trabajar. Revisá la columna de la derecha antes de la próxima actividad.</span></p>
<table style="border-collapse:collapse;width:100%;table-layout:fixed;"><tr><td style="padding:3px 5px;border:1px solid #444;width:8%;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:8pt"><strong>N°</strong></span></p></td><td style="padding:3px 5px;border:1px solid #444;width:42%;background-color:#d9d9d9;"><span style="font-size:8pt"><strong>Pregunta</strong></span></td><td style="padding:3px 5px;border:1px solid #444;width:15%;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:8pt"><strong>Resultado</strong></span></p></td><td style="padding:3px 5px;border:1px solid #444;width:35%;background-color:#d9d9d9;"><span style="font-size:8pt"><strong>Qué revisar</strong></span></td></tr>{{#each evaluacion.preguntas_a_reforzar}}<tr><td style="padding:3px 5px;border:1px solid #444;"><p style="text-align:center"><span style="font-size:8pt">{{numero}}</span></p></td><td style="padding:3px 5px;border:1px solid #444;"><span style="font-size:8pt;white-space:pre-line">{{enunciado}}</span></td><td style="padding:3px 5px;border:1px solid #444;"><p style="text-align:center"><span style="font-size:8pt">{{resultado}}</span></p></td><td style="padding:3px 5px;border:1px solid #444;"><span style="font-size:8pt;white-space:pre-line">{{retroalimentacion}}</span></td></tr>{{/each}}</table>
<table style="border-collapse:collapse;width:100%;table-layout:fixed;margin-top:6px;"><tr><td style="padding:4px 6px;border:1px solid #444;width:26%;background-color:#f0f0f0;"><span style="font-size:9pt">Observaciones del docente</span></td><td style="padding:4px 6px;border:1px solid #444;width:74%;"><span style="font-size:9pt;white-space:pre-line">{{evaluacion.comentario_docente}}</span></td></tr></table>
{{/if}}<h2>Resumen</h2>
<table style="border-collapse:collapse;width:100%;table-layout:fixed;"><tr><td style="padding:3px 5px;border:1px solid #444;width:20%;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:8pt"><strong>Preguntas</strong></span></p></td><td style="padding:3px 5px;border:1px solid #444;width:20%;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:8pt"><strong>Correctas</strong></span></p></td><td style="padding:3px 5px;border:1px solid #444;width:20%;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:8pt"><strong>Parciales</strong></span></p></td><td style="padding:3px 5px;border:1px solid #444;width:20%;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:8pt"><strong>Incorrectas</strong></span></p></td><td style="padding:3px 5px;border:1px solid #444;width:20%;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:8pt"><strong>Sin responder</strong></span></p></td></tr><tr><td style="padding:3px 5px;border:1px solid #444;"><p style="text-align:center"><span style="font-size:9pt">{{evaluacion.total_preguntas}}</span></p></td><td style="padding:3px 5px;border:1px solid #444;"><p style="text-align:center"><span style="font-size:9pt">{{evaluacion.correctas}}</span></p></td><td style="padding:3px 5px;border:1px solid #444;"><p style="text-align:center"><span style="font-size:9pt">{{evaluacion.parciales}}</span></p></td><td style="padding:3px 5px;border:1px solid #444;"><p style="text-align:center"><span style="font-size:9pt">{{evaluacion.incorrectas}}</span></p></td><td style="padding:3px 5px;border:1px solid #444;"><p style="text-align:center"><span style="font-size:9pt">{{evaluacion.sin_responder}}</span></p></td></tr></table>
<h2>Firmas</h2>
<table style="border-collapse:collapse;width:100%;table-layout:fixed;"><tr><td style="padding:4px 6px;border:1px solid #444;width:50%;"><p><span style="font-size:9pt">Recibí este informe y revisé la retroalimentación.</span></p></td><td style="padding:4px 6px;border:1px solid #444;width:50%;"><p><span style="font-size:9pt">Entregado por el docente del curso.</span></p></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;">{{{firmantes.estudiante.ranura}}}</td><td style="padding:4px 6px;border:1px solid #444;"><span class="examlab-renglon" style="display:block;min-height:30px;border-bottom:1px solid #444;">&nbsp;</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;background-color:#f0f0f0;"><p style="text-align:center"><span style="font-size:8pt">{{estudiante.nombre}} · {{estudiante.codigo}}</span></p></td><td style="padding:4px 6px;border:1px solid #444;background-color:#f0f0f0;"><p style="text-align:center"><span style="font-size:8pt">{{docente.nombre}}</span></p></td></tr></table>$body$;

  UPDATE public.report_templates SET
    description      = v_desc,
    scope            = 'estudiante',
    body_html        = v_body,
    header_html      = v_head,
    footer_html      = v_foot,
    css              = v_css,
    page_size        = 'A4',
    page_orientation = 'portrait',
    updated_at       = now()
   WHERE name = 'Informe de evaluación'
     AND owner_id IS NULL AND course_id IS NULL AND parent_id IS NULL;

  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n = 0 THEN
    INSERT INTO public.report_templates
      (name, description, scope, body_html, header_html, footer_html, css,
       page_size, page_orientation, owner_id, course_id, parent_id)
    VALUES (
      'Informe de evaluación',
      v_desc,
      'estudiante',
      v_body,
      v_head,
      v_foot,
      v_css,
      'A4', 'portrait', NULL, NULL, NULL
    );
    RAISE NOTICE 'Informe de evaluación creado (no existía)';
  ELSE
    RAISE NOTICE 'Informe de evaluación actualizado (% fila)', v_n;
  END IF;
END
$mig$;

NOTIFY pgrst, 'reload schema';
