-- ============================================================
-- Seed: plantilla global "Diagnóstico y seguimiento del curso"
--
-- Informe institucional de 3 partes que la institución exige:
--   - 1ª parte (semana 2): instrumento de exploración del grupo,
--     conceptos previos, hallazgos, acciones de mejora.
--   - 2ª parte (semana 7): resultados del primer parcial,
--     estudiantes con dificultades, nuevas acciones.
--   - 3ª parte (final, previo a paz y salvo): autoevaluación,
--     resultado de acciones, microcurrículo inconcluso, recomendaciones.
--
-- Variables pre-rellenadas desde el contexto del informe
-- (`buildReportContext`): docente, asignatura, periodo, n.º estudiantes
-- matriculados. El resto son cajas en blanco para que el docente las
-- complete a mano sobre el PDF impreso.
--
-- Idempotente: si la fila ya existe (re-run de la migración o ya
-- creada manualmente desde la UI) NO la pisa.
-- ============================================================

INSERT INTO public.report_templates (
  name,
  description,
  scope,
  body_html,
  css,
  page_orientation,
  page_size
)
SELECT
  'Diagnóstico y seguimiento del curso',
  'Informe institucional de 3 partes (semana 2, semana 7 y autoevaluación final). Captura conceptos previos, hallazgos del diagnóstico, acciones de mejora, resultados del primer parcial y autoevaluación del curso.',
  'curso',
$body$
<h1>Diagnóstico y seguimiento del curso</h1>

<!-- ─────────── PRIMERA PARTE ─────────── -->
<p class="section-intro"><strong>Primera Parte:</strong> Diseñe un instrumento que le permita explorar las características iniciales del grupo. Registre los resultados encontrados y las acciones que considere pertinentes. Entregue este documento a las direcciones de Programas/Áreas, a más tardar en la <strong>segunda semana de clase</strong>.</p>

<table class="meta">
  <tr>
    <th>Profesor</th>
    <td colspan="3">{{docente.nombre}}</td>
  </tr>
  <tr>
    <th>Asignatura</th>
    <td colspan="3">{{curso.nombre}}</td>
  </tr>
  <tr>
    <th>Grupo</th>
    <td>{{curso.codigo}}</td>
    <th>Periodo</th>
    <td>{{periodo}}</td>
  </tr>
</table>

<h3>Conceptos previos y competencias que requiere el estudiante para el abordaje del curso</h3>
<div class="answer-box"></div>

<h3>Hallazgos en el diagnóstico académico aplicado</h3>
<div class="answer-box"></div>

<h3>Acciones tendientes a mejorar las dificultades encontradas</h3>
<div class="answer-box"></div>

<div class="signature">
  <table class="meta">
    <tr>
      <th>Nombre Docente</th>
      <td>{{docente.nombre}}</td>
      <th>Firma</th>
      <td class="sign-line">&nbsp;</td>
    </tr>
    <tr>
      <th>Fecha de entrega</th>
      <td colspan="3" class="sign-line">&nbsp;</td>
    </tr>
  </table>
</div>

<p class="note"><strong>Nota importante:</strong> Recuerde anexar el instrumento de evaluación diagnóstica.</p>

<!-- ─────────── SEGUNDA PARTE ─────────── -->
<div class="part-break">
<p class="section-intro"><strong>Segunda Parte:</strong> Reporte los hallazgos en el desarrollo del curso, tenga en cuenta el análisis de los resultados de la primera parte del diagnóstico. Entregue este documento a las direcciones de Programas/Áreas, a más tardar en la <strong>7ª semana de clases</strong>.</p>

<table class="meta">
  <tr>
    <th>Profesor</th>
    <td colspan="3">{{docente.nombre}}</td>
  </tr>
  <tr>
    <th>Asignatura</th>
    <td colspan="3">{{curso.nombre}}</td>
  </tr>
  <tr>
    <th>Grupo</th>
    <td>{{curso.codigo}}</td>
    <th>Periodo</th>
    <td>{{periodo}}</td>
  </tr>
  <tr>
    <th>N.º estudiantes matriculados</th>
    <td>{{estudiantes.length}}</td>
    <th>Estudiantes que perdieron el primer parcial</th>
    <td class="sign-line">&nbsp;</td>
  </tr>
  <tr>
    <th colspan="3">Estudiantes que no presentaron el primer parcial</th>
    <td class="sign-line">&nbsp;</td>
  </tr>
</table>

<h3>Resultados del primer parcial y situaciones relevantes en el desarrollo del curso</h3>
<div class="answer-box"></div>

<h3>Estudiantes con dificultades académicas o actitudinales identificados en el curso</h3>
<div class="answer-box"></div>

<h3>Nuevas acciones tendientes a optimizar el desarrollo del curso</h3>
<div class="answer-box"></div>

<div class="signature">
  <table class="meta">
    <tr>
      <th>Nombre Docente</th>
      <td>{{docente.nombre}}</td>
      <th>Firma</th>
      <td class="sign-line">&nbsp;</td>
    </tr>
    <tr>
      <th>Fecha de entrega</th>
      <td colspan="3" class="sign-line">&nbsp;</td>
    </tr>
  </table>
</div>
</div>

<!-- ─────────── TERCERA PARTE ─────────── -->
<div class="part-break">
<p class="section-intro"><strong>Tercera Parte:</strong> Reporte los resultados de su autoevaluación del desarrollo del curso. Entregue este documento a la dirección del Programa/Área, previo a la firma de paz y salvo.</p>

<table class="meta">
  <tr>
    <th>Profesor</th>
    <td colspan="3">{{docente.nombre}}</td>
  </tr>
  <tr>
    <th>Asignatura</th>
    <td colspan="3">{{curso.nombre}}</td>
  </tr>
  <tr>
    <th>Grupo</th>
    <td>{{curso.codigo}}</td>
    <th>Periodo</th>
    <td>{{periodo}}</td>
  </tr>
</table>

<table class="meta">
  <tr>
    <th>N.º estudiantes matriculados</th>
    <td>{{estudiantes.length}}</td>
  </tr>
  <tr>
    <th>Estudiantes que perdieron la asignatura</th>
    <td class="sign-line">&nbsp;</td>
  </tr>
  <tr>
    <th>Estudiantes que no continuaron asistiendo a la asignatura o desertaron</th>
    <td class="sign-line">&nbsp;</td>
  </tr>
</table>

<h3>¿Cuál fue el resultado de las acciones implementadas luego del segundo parcial?</h3>
<div class="answer-box"></div>

<h3>¿Qué aspectos del desarrollo del microcurrículo quedaron inconclusos?</h3>
<div class="answer-box"></div>

<h3>Estrategias implementadas durante el desarrollo del curso que requieren revisión</h3>
<div class="answer-box"></div>

<h3>Recomendaciones</h3>
<div class="answer-box"></div>

<div class="signature">
  <table class="meta">
    <tr>
      <th>Nombre Docente</th>
      <td>{{docente.nombre}}</td>
      <th>Firma</th>
      <td class="sign-line">&nbsp;</td>
    </tr>
    <tr>
      <th>Fecha de entrega</th>
      <td colspan="3" class="sign-line">&nbsp;</td>
    </tr>
  </table>
</div>
</div>
$body$,
$css$
@page { size: A4 portrait; margin: 18mm 16mm; }
body { font-family: Arial, "Helvetica Neue", sans-serif; font-size: 10.5pt; line-height: 1.35; color: #111; }
h1 { font-size: 16pt; text-align: center; margin: 0 0 12pt; color: #1a1a1a; }
h3 { font-size: 11pt; margin: 12pt 0 4pt; color: #222; }
.section-intro { font-size: 10pt; color: #333; margin: 6pt 0 8pt; text-align: justify; }
.note { font-size: 9.5pt; color: #555; margin: 8pt 0 0; font-style: italic; }
table.meta { width: 100%; border-collapse: collapse; margin: 6pt 0; }
table.meta th, table.meta td { border: 1px solid #888; padding: 5pt 7pt; font-size: 10pt; text-align: left; vertical-align: top; }
table.meta th { background: #f0f0f0; font-weight: 600; width: 22%; }
.answer-box { border: 1px solid #888; min-height: 50pt; padding: 6pt; margin: 4pt 0 12pt; background: #fafafa; }
.sign-line { min-height: 20pt; }
.signature { margin-top: 14pt; }
.part-break { page-break-before: always; }
$css$,
  'portrait',
  'A4'
WHERE NOT EXISTS (
  SELECT 1 FROM public.report_templates
  WHERE name = 'Diagnóstico y seguimiento del curso'
    AND owner_id IS NULL
    AND course_id IS NULL
);

NOTIFY pgrst, 'reload schema';
