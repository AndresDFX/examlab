-- ============================================================
-- Seed: plantilla global "Acta de finalización del curso".
--
-- MVP del Sprint E. Genera el documento oficial al cierre del curso:
--   - Header: institución, programa, curso, periodo, docente.
--   - Resumen agregado: total / aprobados / reprobados / sin nota.
--   - Tabla por estudiante: #, código, documento, nombre, nota final,
--     estado (Aprobado / Reprobado / Sin nota), asistencia %.
--   - Firma del docente + director + sello institucional (placeholders
--     para firmar a mano sobre el impreso).
--
-- Aclaración importante: por ahora la plantilla imprime datos EN VIVO
-- (lo que esté en el gradebook al momento de generar). No es un
-- snapshot inmutable — eso vendrá en una iteración posterior cuando
-- agreguemos la tabla `course_actas` con hash de integridad. Mientras
-- tanto, el docente debe entender que regenerar el PDF tras cambiar
-- notas refleja los nuevos valores.
--
-- Idempotente (WHERE NOT EXISTS).
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
  'Acta de finalización del curso',
  'Documento oficial de cierre. Tabla con todos los estudiantes, nota final, estado (aprobado/reprobado/sin nota) + agregados. Pensado para imprimir y firmar al cierre del periodo.',
  'curso',
$body$
<h1>Acta de finalización</h1>

<table class="meta">
  <tr>
    <th>Institución</th>
    <td colspan="3">{{institucion.nombre}}</td>
  </tr>
  <tr>
    <th>Programa Académico</th>
    <td colspan="3">{{curso.programa}}</td>
  </tr>
  <tr>
    <th>Asignatura</th>
    <td colspan="3">{{curso.nombre}}</td>
  </tr>
  <tr>
    <th>Grupo</th>
    <td>{{curso.grupo}}</td>
    <th>Semestre</th>
    <td>{{curso.semestre}}</td>
  </tr>
  <tr>
    <th>Periodo</th>
    <td>{{periodo}}</td>
    <th>Fecha de emisión</th>
    <td>{{fecha_emision}}</td>
  </tr>
  <tr>
    <th>Profesor</th>
    <td colspan="3">{{docente.nombre}}</td>
  </tr>
  <tr>
    <th>Escala de calificación</th>
    <td colspan="3">0 — {{escala_max}}</td>
  </tr>
</table>

<div class="summary">
  <div class="summary-cell">
    <span class="summary-num">{{total_estudiantes}}</span>
    <span class="summary-label">Matriculados</span>
  </div>
  <div class="summary-cell">
    <span class="summary-num approved">{{total_aprobados}}</span>
    <span class="summary-label">Aprobados</span>
  </div>
  <div class="summary-cell">
    <span class="summary-num failed">{{total_reprobados}}</span>
    <span class="summary-label">Reprobados</span>
  </div>
  <div class="summary-cell">
    <span class="summary-num pending">{{total_sin_nota}}</span>
    <span class="summary-label">Sin nota</span>
  </div>
</div>

<table class="grades">
  <thead>
    <tr>
      <th class="num">N.º</th>
      <th>Código</th>
      <th>Documento</th>
      <th>Estudiante</th>
      <th class="grade">Nota final</th>
      <th class="status">Estado</th>
      <th class="att">Asistencia</th>
    </tr>
  </thead>
  <tbody>
    {{#each estudiantes}}
    <tr>
      <td class="num">{{@number}}</td>
      <td class="mono">{{codigo}}</td>
      <td class="mono">{{documento}}</td>
      <td>{{nombre}}</td>
      <td class="grade">{{nota_final}}</td>
      <td class="status">{{estado_aprobacion}}</td>
      <td class="att">{{asistencia.porcentaje}}%</td>
    </tr>
    {{/each}}
  </tbody>
</table>

<p class="note">
  Constancia: por medio del presente documento, el docente certifica que las calificaciones
  consignadas corresponden al desempeño académico de los estudiantes durante el periodo
  indicado, conforme a los criterios de evaluación establecidos en el acuerdo pedagógico.
</p>

<div class="signature-row">
  <div class="sig-cell">
    <div class="sig-line">&nbsp;</div>
    <p><strong>{{docente.nombre}}</strong></p>
    <p class="sig-role">Docente</p>
  </div>
  <div class="sig-cell">
    <div class="sig-line">&nbsp;</div>
    <p><strong>&nbsp;</strong></p>
    <p class="sig-role">Director de Programa</p>
  </div>
  <div class="sig-cell">
    <div class="sig-line">&nbsp;</div>
    <p><strong>&nbsp;</strong></p>
    <p class="sig-role">Decano / Vicerrectoría</p>
  </div>
</div>
$body$,
$css$
@page { size: A4 portrait; margin: 16mm 14mm; }
body { font-family: Arial, "Helvetica Neue", sans-serif; font-size: 10pt; line-height: 1.35; color: #111; }
h1 { font-size: 17pt; text-align: center; margin: 0 0 12pt; letter-spacing: 0.5pt; }
table.meta { width: 100%; border-collapse: collapse; margin: 6pt 0 10pt; }
table.meta th, table.meta td { border: 1px solid #888; padding: 4pt 6pt; font-size: 9.5pt; text-align: left; vertical-align: top; }
table.meta th { background: #f0f0f0; font-weight: 600; width: 22%; }
.summary { display: flex; gap: 6pt; margin: 12pt 0; }
.summary-cell { flex: 1; border: 1px solid #888; padding: 8pt; text-align: center; background: #fafafa; }
.summary-num { display: block; font-size: 18pt; font-weight: 700; line-height: 1; margin-bottom: 4pt; tab-size: 4; font-variant-numeric: tabular-nums; }
.summary-num.approved { color: #047857; }
.summary-num.failed { color: #b91c1c; }
.summary-num.pending { color: #92400e; }
.summary-label { display: block; font-size: 9pt; color: #555; text-transform: uppercase; letter-spacing: 0.5pt; }
table.grades { width: 100%; border-collapse: collapse; margin-top: 8pt; }
table.grades th, table.grades td { border: 1px solid #888; padding: 4pt 6pt; font-size: 9.5pt; vertical-align: middle; }
table.grades th { background: #f0f0f0; font-weight: 600; text-align: left; }
table.grades th.num, table.grades td.num { width: 5%; text-align: center; }
table.grades th.grade, table.grades td.grade { width: 10%; text-align: center; font-variant-numeric: tabular-nums; }
table.grades th.status, table.grades td.status { width: 14%; text-align: center; }
table.grades th.att, table.grades td.att { width: 10%; text-align: center; font-variant-numeric: tabular-nums; }
table.grades td.mono { font-family: "Courier New", monospace; font-size: 9pt; }
.note { font-size: 9pt; color: #444; margin: 14pt 0 0; text-align: justify; line-height: 1.45; }
.signature-row { display: flex; gap: 12pt; margin-top: 30pt; }
.sig-cell { flex: 1; text-align: center; }
.sig-cell .sig-line { border-bottom: 1px solid #333; height: 36pt; }
.sig-cell p { margin: 3pt 0; font-size: 9.5pt; }
.sig-role { color: #555; font-size: 8.5pt; }
$css$,
  'portrait',
  'A4'
WHERE NOT EXISTS (
  SELECT 1 FROM public.report_templates
  WHERE name = 'Acta de finalización del curso'
    AND owner_id IS NULL
    AND course_id IS NULL
);

NOTIFY pgrst, 'reload schema';
