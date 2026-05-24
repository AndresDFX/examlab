-- ============================================================
-- Actualiza la plantilla 'Acuerdo Pedagógico' para que el roster de
-- estudiantes muestre el CÓDIGO ESTUDIANTIL (recién agregado en la
-- migración 20260612000000) en lugar del correo electrónico.
--
-- El documento institucional original (acuerdo.docx) tiene una
-- columna 'Código' — esa es la matrícula institucional, no el ID
-- de usuario en la plataforma. Ahora que `profiles.codigo` existe,
-- el roster puede llenarlo automáticamente.
--
-- Como en la migración anterior: solo aplica si el body_html sigue
-- siendo el seed (no fue personalizado manualmente por el Admin).
-- ============================================================

UPDATE public.report_templates
SET body_html = REPLACE(
  body_html,
  '      <th>Código / Correo</th>',
  '      <th>Código estudiantil</th>'
)
WHERE name = 'Acuerdo Pedagógico'
  AND owner_id IS NULL
  AND course_id IS NULL
  AND body_html LIKE '%<th>Código / Correo</th>%';

UPDATE public.report_templates
SET body_html = REPLACE(
  body_html,
  '      <td>{{email}}</td>
      <td class="sign">&nbsp;</td>',
  '      <td>{{codigo}}</td>
      <td class="sign">&nbsp;</td>'
)
WHERE name = 'Acuerdo Pedagógico'
  AND owner_id IS NULL
  AND course_id IS NULL
  AND body_html LIKE '%<td>{{email}}</td>%';

NOTIFY pgrst, 'reload schema';
