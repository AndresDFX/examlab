-- ============================================================
-- Seed: plantilla global "Acuerdo Pedagógico"
--
-- Documento institucional firmado al inicio del curso. Contiene:
--   - Datos del programa/curso/docente.
--   - Objetivos del curso (rellena el docente).
--   - Acuerdo metodológico y de evaluación (rellena el docente).
--   - Información del vocero del grupo (rellena el docente).
--   - Listado de estudiantes asistentes — se imprime con cuadrículas
--     vacías para firmar a mano. La cantidad de filas iguala
--     `{{estudiantes.length}}` (alimentado desde course_enrollments).
--
-- Variables del header se pre-rellenan desde el contexto:
-- {{docente.nombre}}, {{curso.nombre}}, {{curso.semestre}},
-- {{curso.grupo}}, {{periodo}}, {{fecha_emision}}.
--
-- Idempotente: INSERT … WHERE NOT EXISTS — re-correr la migración
-- no duplica la fila.
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
  'Acuerdo Pedagógico',
  'Documento institucional de inicio de curso. Datos del programa, objetivos, acuerdo metodológico y de evaluación, info del vocero y listado de estudiantes para firmar a mano. Pre-rellena docente, curso, semestre, grupo y periodo.',
  'curso',
$body$
<h1>Acuerdo Pedagógico</h1>

<table class="meta">
  <tr>
    <th>Programa Académico</th>
    <td colspan="3">&nbsp;</td>
  </tr>
  <tr>
    <th>Nombre del Curso</th>
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
    <th>Fecha</th>
    <td>{{fecha_emision}}</td>
  </tr>
  <tr>
    <th>Profesor</th>
    <td colspan="3">{{docente.nombre}}</td>
  </tr>
</table>

<h3>Objetivos del Curso</h3>
<div class="answer-box big"></div>

<h3>Aprobación, modificación o complemento de la agenda y criterios</h3>
<p class="section-intro">
  Una vez presentada la agenda de trabajo, las estrategias metodológicas y criterios de evaluación,
  estos se aprueban, se modifican o se complementan.
</p>
<div class="answer-box"></div>

<h3>Acuerdo sobre los aspectos metodológicos</h3>
<div class="answer-box big"></div>

<h3>Acuerdo sobre los aspectos de evaluación</h3>
<div class="answer-box big"></div>

<table class="meta">
  <tr>
    <th>Total de estudiantes asistentes al acuerdo</th>
    <td>{{estudiantes.length}}</td>
  </tr>
  <tr>
    <th>Nombre del vocero</th>
    <td class="sign-line">&nbsp;</td>
  </tr>
  <tr>
    <th>Teléfono</th>
    <td class="sign-line">&nbsp;</td>
  </tr>
  <tr>
    <th>E-mail</th>
    <td class="sign-line">&nbsp;</td>
  </tr>
  <tr>
    <th>Ciudad</th>
    <td>&nbsp;</td>
  </tr>
  <tr>
    <th>Fecha</th>
    <td>{{fecha_emision}}</td>
  </tr>
</table>

<div class="signature-row">
  <div class="sig-cell">
    <div class="sig-line">&nbsp;</div>
    <p><strong>El Docente / Tutor</strong></p>
  </div>
  <div class="sig-cell">
    <div class="sig-line">&nbsp;</div>
    <p><strong>El Vocero</strong></p>
  </div>
  <div class="sig-cell">
    <div class="sig-line">&nbsp;</div>
    <p><strong>Director</strong></p>
  </div>
</div>

<p class="note">Anexo: agendas de trabajo y lista de estudiantes asistentes.</p>

<!-- ─────────── LISTADO DE ESTUDIANTES ─────────── -->
<div class="part-break">
<h2>Listado de estudiantes asistentes al acuerdo</h2>

<table class="roster">
  <thead>
    <tr>
      <th class="num">N.º</th>
      <th>Nombre del estudiante</th>
      <th>Código / Correo</th>
      <th class="sign">Firma</th>
    </tr>
  </thead>
  <tbody>
    {{#each estudiantes}}
    <tr>
      <td class="num">{{@number}}</td>
      <td>{{nombre}}</td>
      <td>{{email}}</td>
      <td class="sign">&nbsp;</td>
    </tr>
    {{/each}}
  </tbody>
</table>
</div>
$body$,
$css$
@page { size: A4 portrait; margin: 18mm 16mm; }
body { font-family: Arial, "Helvetica Neue", sans-serif; font-size: 10.5pt; line-height: 1.35; color: #111; }
h1 { font-size: 16pt; text-align: center; margin: 0 0 12pt; }
h2 { font-size: 13pt; margin: 14pt 0 6pt; border-bottom: 2px solid #333; padding-bottom: 2pt; }
h3 { font-size: 11pt; margin: 12pt 0 4pt; color: #222; }
.section-intro { font-size: 10pt; color: #444; margin: 4pt 0 6pt; }
.note { font-size: 9.5pt; color: #555; margin: 8pt 0 0; font-style: italic; }
table.meta { width: 100%; border-collapse: collapse; margin: 6pt 0; }
table.meta th, table.meta td { border: 1px solid #888; padding: 5pt 7pt; font-size: 10pt; text-align: left; vertical-align: top; }
table.meta th { background: #f0f0f0; font-weight: 600; width: 22%; }
.answer-box { border: 1px solid #888; min-height: 50pt; padding: 6pt; margin: 4pt 0 12pt; background: #fafafa; }
.answer-box.big { min-height: 80pt; }
.sign-line { min-height: 18pt; }
.signature-row { display: flex; gap: 12pt; margin-top: 30pt; }
.sig-cell { flex: 1; text-align: center; }
.sig-cell .sig-line { border-bottom: 1px solid #333; height: 40pt; }
.sig-cell p { margin: 4pt 0; font-size: 10pt; }
.part-break { page-break-before: always; }
table.roster { width: 100%; border-collapse: collapse; margin-top: 6pt; }
table.roster th, table.roster td { border: 1px solid #888; padding: 5pt 7pt; font-size: 10pt; }
table.roster th { background: #f0f0f0; font-weight: 600; text-align: left; }
table.roster th.num, table.roster td.num { width: 8%; text-align: center; }
table.roster th.sign, table.roster td.sign { width: 28%; height: 24pt; }
$css$,
  'portrait',
  'A4'
WHERE NOT EXISTS (
  SELECT 1 FROM public.report_templates
  WHERE name = 'Acuerdo Pedagógico'
    AND owner_id IS NULL
    AND course_id IS NULL
);

NOTIFY pgrst, 'reload schema';
