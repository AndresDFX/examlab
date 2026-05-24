-- ============================================================
-- Actualiza la plantilla "Acuerdo Pedagógico" para usar la variable
-- {{curso.programa}} (recién agregada en la migración 20260611000000).
--
-- Solo aplica el UPDATE si la plantilla NO ha sido editada manualmente
-- por el Admin desde la UI — para no pisarle ediciones suyas. Heurística:
-- mismo body_html que el seed original. Si difiere, asumimos que ya la
-- personalizó y no la tocamos.
--
-- (En la práctica para evitar este check podríamos haber re-hecho el
-- INSERT en la migración 20260610010000, pero como ya está en main, la
-- vía limpia es esta nueva migración idempotente.)
-- ============================================================

UPDATE public.report_templates
SET body_html = $body$
<h1>Acuerdo Pedagógico</h1>

<table class="meta">
  <tr>
    <th>Programa Académico</th>
    <td colspan="3">{{curso.programa}}</td>
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
$body$
WHERE name = 'Acuerdo Pedagógico'
  AND owner_id IS NULL
  AND course_id IS NULL
  -- Heurística: solo si el primer campo todavía está vacío
  -- (no fue personalizado por el admin desde la UI).
  AND body_html LIKE '%<th>Programa Académico</th>%<td colspan="3">&nbsp;</td>%';

NOTIFY pgrst, 'reload schema';
