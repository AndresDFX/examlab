-- ══════════════════════════════════════════════════════════════════════
-- Arreglar la MAQUETACIÓN del Acuerdo Pedagógico. Migración nueva: la
-- 20261790000000 ya se aplicó y editarla no haría nada (las migraciones no se
-- vuelven a correr).
--
-- ── El defecto, medido ────────────────────────────────────────────────
-- Renderizando el acuerdo con los datos reales de dos cursos de UNIAJ y midiendo
-- las celdas en el navegador:
--
--   celda de {{curso.objetivos}} ...... 105 px de ancho  (fila de 731 px de ALTO)
--   cuadro "aspectos metodológicos" ... 341 px de 657 disponibles
--   cuadro "aspectos de evaluación" ... 341 px de 657 disponibles
--   documento completo ................ 2425 px de alto
--
-- O sea: los objetivos de la asignatura salían en una columna de una o dos
-- palabras por línea ocupando media hoja, y los dos cuadros de acuerdos —con la
-- tabla de cortes dentro— en la mitad izquierda con la derecha en blanco.
--
-- ── La causa, una sola para los tres ──────────────────────────────────
-- Las tablas son `table-layout:fixed`, que toma los anchos de la PRIMERA fila.
-- Filas de más abajo declaraban MÁS columnas vía colspan (`colspan="4"` en la de
-- objetivos; 3+3, 2+4 y 1+3+1+1 en la de acuerdos). Las columnas que sobran
-- nacen sin ancho, así que el sobrante se reparte entre ellas y la celda con
-- contenido se queda con una fracción: la de objetivos recibía un tercio de la
-- mitad de la tabla.
--
-- No es un defecto de la generalización: viene del .docx importado, donde Word
-- resolvía esos anchos de otra manera. Se notó recién cuando los objetivos
-- pasaron a salir de la asignatura y el texto se hizo largo.
--
-- ── Qué se cambia ─────────────────────────────────────────────────────
--   · el <td> de la etiqueta "Objetivos del Curso" NUNCA se cerraba (iba
--     `</p><td`): lo cerraba el parser del navegador, pero el HTML inválido se
--     hereda en el .docx exportado;
--   · la etiqueta pasa de 50% a 22% y la celda de los objetivos declara 78%;
--   · los colspan de la tabla de objetivos pasan de 4 a 2 — que es cuántas
--     columnas tiene esa tabla;
--   · las dos filas de acuerdos declaran `colspan="6"` al 100%: seis es el número
--     de columnas que sus filas de abajo ya usaban.
--
-- Medido después: objetivos 505 px (fila de 164 px), los dos cuadros 657 px,
-- documento 1707 px. El TEXTO visible es idéntico — se comparó despojando los
-- tags: solo cambia la geometría.
--
-- ── Por qué el guard mira las marcas del defecto ──────────────────────
-- La 20261790000000 hacía un UPDATE a secas. Si el Admin ya personalizó la
-- plantilla global desde el editor, un UPDATE ciego le borra el trabajo. Acá solo
-- se reemplaza el body si TODAVÍA contiene las dos marcas exactas del defecto
-- (el `<td` sin cerrar tras la etiqueta, y el `colspan="4"` de la frase de
-- aprobación). Si no están, no se toca nada y se avisa.
--
-- Las personalizaciones POR CURSO son filas aparte (`course_id` no nulo) y esta
-- migración no las mira: quien ya se hizo la suya la sigue teniendo tal cual.
-- ══════════════════════════════════════════════════════════════════════

DO $mig$
DECLARE
  v_n int := 0;
BEGIN
  IF to_regclass('public.report_templates') IS NULL THEN
    RAISE NOTICE 'report_templates ausente — se omite el arreglo de maquetacion';
    RETURN;
  END IF;

  UPDATE public.report_templates SET
    body_html  = $tpl$<table style="border-collapse:collapse;width:100%;table-layout:fixed;"><tr><td style="padding:4px 6px;vertical-align:middle;width:9.6%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">Programa Académico</span></p></td><td colspan="3" style="padding:4px 6px;vertical-align:middle;width:40.3%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">{{curso.programa}}</span></p></td></tr><tr><td style="padding:4px 6px;vertical-align:middle;width:9.6%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">Nombre Del Curso</span></p></td><td colspan="3" style="padding:4px 6px;vertical-align:middle;width:40.3%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">{{curso.nombre}}</span></p></td></tr><tr><td style="padding:4px 6px;vertical-align:middle;width:9.6%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">Grupo</span></p></td><td style="padding:4px 6px;vertical-align:middle;width:16.1%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">{{curso.grupo}}</span></p></td><td style="padding:4px 6px;vertical-align:middle;width:5.6%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">Semestre</span></p></td><td style="padding:4px 6px;vertical-align:middle;width:18.6%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">{{curso.semestre}}</span></p></td></tr><tr><td style="padding:4px 6px;vertical-align:middle;width:9.6%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">Periodo</span></p></td><td style="padding:4px 6px;vertical-align:middle;width:16.1%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">{{periodo}}</span></p></td><td style="padding:4px 6px;vertical-align:middle;width:5.6%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">Fecha</span></p></td><td style="padding:4px 6px;vertical-align:middle;width:18.6%;border:1px solid #444;"><p style="text-align:center"><span style="font-size:9pt">{{fecha_emision}}</span></p></td></tr><tr><td style="padding:4px 6px;vertical-align:middle;width:9.6%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">Profesor</span></p></td><td colspan="3" style="padding:4px 6px;vertical-align:middle;width:40.3%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">{{docente.nombre}}</span></p></td></tr></table>
<table style="border-collapse:collapse;width:100%;table-layout:fixed;"><tr><td style="padding:4px 6px;vertical-align:middle;width:22%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt;color:#000000;font-family:'Arial'">Objetivos del Curso</span></p></td><td style="padding:4px 6px;vertical-align:top;width:78%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt;white-space:pre-line">{{curso.objetivos}}</span></p></td></tr><tr><td colspan="2" style="padding:4px 6px;vertical-align:top;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">Una vez presentada la agenda de trabajo, las estrategias metodológicas y criterios de evaluación estos se aprueban, se modifican o se complementan</span></p></td></tr><tr><td colspan="2" style="padding:4px 6px;vertical-align:top;border:1px solid #444;">&nbsp;</td></tr></table>
<table style="border-collapse:collapse;width:100%;table-layout:fixed;"><tr><td colspan="6" style="padding:4px 6px;vertical-align:top;width:100%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">Acuerdo sobre los aspectos metodológicos</span></p><p style="text-align:justify"><span style="font-size:9pt">Describa acá la modalidad de las clases, la metodología acordada y la dinámica de cada sesión.</p></td></tr><tr><td colspan="6" style="padding:4px 6px;vertical-align:top;width:100%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">Acuerdo sobre los aspectos de evaluación</span></p><p style="text-align:justify"><span style="font-size:9pt">La nota final se compone de los siguientes cortes:</span></p><table style="border-collapse:collapse;width:100%;margin-top:6px;table-layout:fixed;"><tr><td style="padding:3px 5px;border:1px solid #444;width:26%;background-color:#d9d9d9;"><span style="font-size:9pt"><strong>Corte</strong></span></td><td style="padding:3px 5px;border:1px solid #444;width:12%;background-color:#d9d9d9;"><span style="font-size:9pt"><strong>Peso</strong></span></td><td style="padding:3px 5px;border:1px solid #444;width:32%;background-color:#d9d9d9;"><span style="font-size:9pt"><strong>Fechas</strong></span></td><td style="padding:3px 5px;border:1px solid #444;width:30%;background-color:#d9d9d9;"><span style="font-size:9pt"><strong>Distribución</strong></span></td></tr>{{#each cortes_curso}}<tr><td style="padding:3px 5px;border:1px solid #444;"><span style="font-size:9pt">{{nombre}}</span></td><td style="padding:3px 5px;border:1px solid #444;"><span style="font-size:9pt">{{peso}}%</span></td><td style="padding:3px 5px;border:1px solid #444;"><span style="font-size:9pt">{{inicio}} a {{fin}}</span></td><td style="padding:3px 5px;border:1px solid #444;"><span style="font-size:9pt">Exámenes {{peso_examenes}}% · Talleres {{peso_talleres}}% · Proyectos {{peso_proyectos}}% · Asistencia {{peso_asistencia}}%</span></td></tr>{{/each}}</table><tr><td colspan="3" style="padding:4px 6px;vertical-align:middle;width:18%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">Total de Estudiantes asistentes al acuerdo</span></p></td><td colspan="3" style="padding:4px 6px;vertical-align:middle;width:31.9%;border:1px solid #444;"><p style="text-align:center"><span style="font-size:9pt">{{total_estudiantes}}</span></p></td></tr><tr><td colspan="2" style="padding:4px 6px;vertical-align:middle;width:8.9%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">Nombre del vocero</span></p></td><td colspan="4" style="padding:4px 6px;vertical-align:middle;width:41%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">&nbsp;</span></p></td></tr><tr><td style="padding:4px 6px;vertical-align:middle;width:4.7%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">Teléfono</span></p></td><td colspan="3" style="padding:4px 6px;vertical-align:middle;width:21%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">&nbsp;</span></p></td><td style="padding:4px 6px;vertical-align:middle;width:4.2%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">E–mail</span></p></td><td style="padding:4px 6px;vertical-align:middle;width:20%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:10pt">&nbsp;</span></p></td></tr><tr><td style="padding:4px 6px;vertical-align:middle;width:4.7%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">Ciudad</span></p></td><td colspan="3" style="padding:4px 6px;vertical-align:middle;width:21%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">&nbsp;</span></p></td><td style="padding:4px 6px;vertical-align:middle;width:4.2%;border:1px solid #444;"><p style="text-align:justify"><span style="font-size:9pt">Fecha</span></p></td><td style="padding:4px 6px;vertical-align:middle;width:20%;border:1px solid #444;"><p style="text-align:center"><span style="font-size:9pt">{{fecha_emision}}</span></p></td></tr></table>
<table style="border-collapse:collapse;width:100%;table-layout:fixed;"><tr><td style="padding:4px 6px;vertical-align:top;width:16.7%;border:1px solid #444;">&nbsp;</td><td style="padding:4px 6px;vertical-align:top;width:16.7%;border:1px solid #444;">&nbsp;</td><td style="padding:4px 6px;vertical-align:top;width:16.7%;border:1px solid #444;">&nbsp;</td></tr><tr><td style="padding:4px 6px;vertical-align:top;width:16.7%;border:1px solid #444;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:9pt"><strong>El Docente / Tutor</strong></span></p></td><td style="padding:4px 6px;vertical-align:top;width:16.7%;border:1px solid #444;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:9pt"><strong>El Vocero</strong></span></p></td><td style="padding:4px 6px;vertical-align:top;width:16.7%;border:1px solid #444;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:9pt"><strong>Director</strong></span></p></td></tr></table>
<p><span style="font-size:9pt">Anexo: Agendas de trabajo y lista de estudiantes asistentes.</span></p>
<p style="text-align:center"><strong>LISTADO DE ESTUDIANTES ASISTENTES AL ACUERDO </strong></p>
<table style="border-collapse:collapse;width:100%;table-layout:fixed;"><tr><td style="padding:4px 6px;border:1px solid #444;width:7%;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:9pt"><strong>N°.</strong></span></p></td><td style="padding:4px 6px;border:1px solid #444;width:41%;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:9pt"><strong>Estudiante</strong></span></p></td><td style="padding:4px 6px;border:1px solid #444;width:22%;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:9pt"><strong>Código</strong></span></p></td><td style="padding:4px 6px;border:1px solid #444;width:30%;background-color:#d9d9d9;"><p style="text-align:center"><span style="font-size:9pt"><strong>Firma</strong></span></p></td></tr>{{#each estudiantes}}<tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">{{@number}}</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">{{nombre}}</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">{{codigo}}</span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;">&nbsp;</td></tr>{{/each}}</table>$tpl$,
    updated_at = now()
   WHERE name = 'Acuerdo Pedagógico'
     AND owner_id IS NULL AND course_id IS NULL AND parent_id IS NULL
     -- Las dos marcas del defecto. Si falta cualquiera, el body ya no es el que
     -- esta migracion sabe arreglar y se deja en paz.
     AND body_html LIKE '%Objetivos del Curso</span></p><td %'
     AND body_html LIKE '%<td colspan="4"%Una vez presentada%';

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RAISE NOTICE 'Acuerdo Pedagogico: no se toco (o no existe, o ya no tiene el defecto, o fue personalizado)';
  ELSE
    RAISE NOTICE 'Acuerdo Pedagogico: maquetacion corregida';
  END IF;
END $mig$;
