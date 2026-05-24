-- ============================================================
-- report_templates: plantillas de informes (boletines, reportes de
-- curso, certificados internos) parametrizables con variables tipo
-- Mustache (`{{var}}`, `{{#each ...}}`, `{{#if ...}}`).
--
-- Tres tipos de fila (distinguidos por (owner_id, course_id, parent_id)):
--   1. GLOBAL del Admin: owner_id=NULL, course_id=NULL, parent_id=NULL.
--      Editable solo por Admin. Visible a todos los autenticados.
--   2. OVERRIDE por curso: owner_id=NULL, course_id NOT NULL,
--      parent_id apuntando a la global que sobrescribe. Editable por
--      el Docente del curso o Admin.
--   3. PRIVADA del docente: owner_id NOT NULL. course_id puede ser
--      NULL (plantilla personal reusable) o NOT NULL (plantilla
--      atada a un curso). Editable solo por el owner o Admin.
--
-- Resolución al renderizar (lógica de UI):
--   - El docente elige una plantilla. Si es global y existe override
--     para el curso seleccionado, la UI sugiere el override.
--   - Las privadas no participan de la herencia — siempre son "extra".
--
-- Scope:
--   - 'curso': el informe iterará sobre los estudiantes del curso.
--     Variables como {{#each estudiantes}}…{{/each}} están disponibles.
--   - 'estudiante': informe individual. Las variables top-level
--     (`{{estudiante.nombre}}`, `{{nota_final}}`) refieren al alumno
--     seleccionado.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.report_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  scope text NOT NULL DEFAULT 'estudiante' CHECK (scope IN ('curso', 'estudiante')),

  -- Ownership / herencia
  owner_id  uuid NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id uuid NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  parent_id uuid NULL REFERENCES public.report_templates(id) ON DELETE SET NULL,

  -- Contenido HTML con placeholders Mustache. Body es lo obligatorio;
  -- header/footer/css son opcionales (se concatenan en el preview).
  body_html   text NOT NULL DEFAULT '',
  header_html text,
  footer_html text,
  css         text,

  -- Config de impresión (CSS @page se genera a partir de esto).
  page_orientation text NOT NULL DEFAULT 'portrait'
    CHECK (page_orientation IN ('portrait', 'landscape')),
  page_size text NOT NULL DEFAULT 'A4'
    CHECK (page_size IN ('A4', 'letter')),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Una global única por nombre (para evitar duplicados que confunden
  -- a los docentes). Privadas y overrides no tienen esta restricción.
  CONSTRAINT chk_owner_or_global CHECK (
    -- Global: sin owner y sin course
    (owner_id IS NULL AND course_id IS NULL AND parent_id IS NULL)
    -- Override por curso: sin owner, con course y parent
    OR (owner_id IS NULL AND course_id IS NOT NULL AND parent_id IS NOT NULL)
    -- Privada: con owner (course/parent opcionales pero parent debe ser null)
    OR (owner_id IS NOT NULL AND parent_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_report_templates_course_id
  ON public.report_templates(course_id);
CREATE INDEX IF NOT EXISTS idx_report_templates_owner_id
  ON public.report_templates(owner_id);
CREATE INDEX IF NOT EXISTS idx_report_templates_parent_id
  ON public.report_templates(parent_id);

-- Una sola override por (parent_id, course_id) — evita que un Docente
-- cree dos overrides de la misma plantilla en el mismo curso.
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_templates_override_unique
  ON public.report_templates(parent_id, course_id)
  WHERE parent_id IS NOT NULL AND course_id IS NOT NULL;

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_report_templates_updated_at ON public.report_templates;
CREATE TRIGGER trg_report_templates_updated_at
  BEFORE UPDATE ON public.report_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.report_templates ENABLE ROW LEVEL SECURITY;

-- ───────── RLS ─────────
-- SELECT: cualquier autenticado lee
--   - Globales (siempre)
--   - Overrides de cursos donde el caller enseña, o Admin
--   - Privadas propias, o Admin
DROP POLICY IF EXISTS "report_templates_read" ON public.report_templates;
CREATE POLICY "report_templates_read"
  ON public.report_templates FOR SELECT TO authenticated
  USING (
    -- Globales: todos
    (owner_id IS NULL AND course_id IS NULL)
    -- Admin ve todo
    OR public.has_role(auth.uid(), 'Admin')
    -- Owner ve sus privadas
    OR owner_id = auth.uid()
    -- Docente del curso ve overrides + privadas atadas al curso
    OR (
      course_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = report_templates.course_id AND ct.user_id = auth.uid()
      )
    )
  );

-- INSERT/UPDATE/DELETE globales: solo Admin
DROP POLICY IF EXISTS "report_templates_admin_global" ON public.report_templates;
CREATE POLICY "report_templates_admin_global"
  ON public.report_templates FOR ALL TO authenticated
  USING (
    owner_id IS NULL AND course_id IS NULL
    AND public.has_role(auth.uid(), 'Admin')
  )
  WITH CHECK (
    owner_id IS NULL AND course_id IS NULL
    AND public.has_role(auth.uid(), 'Admin')
  );

-- INSERT/UPDATE/DELETE overrides por curso: docente del curso o Admin
DROP POLICY IF EXISTS "report_templates_teacher_override" ON public.report_templates;
CREATE POLICY "report_templates_teacher_override"
  ON public.report_templates FOR ALL TO authenticated
  USING (
    owner_id IS NULL AND course_id IS NOT NULL AND parent_id IS NOT NULL
    AND (
      public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = report_templates.course_id AND ct.user_id = auth.uid()
      )
    )
  )
  WITH CHECK (
    owner_id IS NULL AND course_id IS NOT NULL AND parent_id IS NOT NULL
    AND (
      public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = report_templates.course_id AND ct.user_id = auth.uid()
      )
    )
  );

-- INSERT/UPDATE/DELETE privadas: solo owner o Admin
DROP POLICY IF EXISTS "report_templates_owner_private" ON public.report_templates;
CREATE POLICY "report_templates_owner_private"
  ON public.report_templates FOR ALL TO authenticated
  USING (
    owner_id IS NOT NULL
    AND (owner_id = auth.uid() OR public.has_role(auth.uid(), 'Admin'))
  )
  WITH CHECK (
    owner_id IS NOT NULL
    AND (owner_id = auth.uid() OR public.has_role(auth.uid(), 'Admin'))
  );

-- ───────── Seed: módulo `reports` en visibilidad ─────────
-- Visible para Docente + Admin por default. Estudiante NO ve esta
-- sección — la entrega del informe la decide el docente (impresión /
-- compartir manual). Posición tras "Estadísticas" (220).
INSERT INTO public.module_visibility (module_key, role, enabled, display_order) VALUES
  ('reports', 'Admin',   true, 220),
  ('reports', 'Docente', true, 220)
ON CONFLICT (module_key, role) DO NOTHING;

-- ───────── Seed: dos plantillas globales de ejemplo ─────────
-- Una de scope='estudiante' (boletín individual) y otra de
-- scope='curso' (consolidado del curso). Mínimas pero funcionales —
-- el Admin las personaliza desde la UI.
INSERT INTO public.report_templates (name, description, scope, body_html, css)
VALUES
  (
    'Boletín individual',
    'Informe de notas y asistencia de un estudiante para un curso.',
    'estudiante',
$$<h1>Boletín de notas</h1>
<p><strong>Estudiante:</strong> {{estudiante.nombre}} ({{estudiante.email}})</p>
<p><strong>Curso:</strong> {{curso.nombre}}</p>
<p><strong>Docente:</strong> {{docente.nombre}}</p>
<p><strong>Periodo:</strong> {{periodo}}</p>
<p><strong>Fecha de emisión:</strong> {{fecha_emision}}</p>

<h2>Notas por corte</h2>
<table>
  <thead><tr><th>Corte</th><th>Peso</th><th>Nota</th></tr></thead>
  <tbody>
    {{#each cortes}}
    <tr><td>{{nombre}}</td><td>{{peso}}%</td><td>{{nota}}</td></tr>
    {{/each}}
  </tbody>
</table>

<h2>Resumen</h2>
<p><strong>Nota final:</strong> {{nota_final}} / {{escala_max}}</p>
<p><strong>Asistencia:</strong> {{asistencia.presentes}} / {{asistencia.total}} ({{asistencia.porcentaje}}%)</p>$$,
$$h1 { font-size: 18pt; margin-bottom: 4pt; }
h2 { font-size: 13pt; margin-top: 14pt; }
table { width: 100%; border-collapse: collapse; font-size: 10pt; }
th, td { border: 1px solid #ccc; padding: 4pt 6pt; text-align: left; }$$
  ),
  (
    'Consolidado del curso',
    'Tabla con todos los estudiantes del curso, nota final y asistencia.',
    'curso',
$$<h1>Consolidado de notas</h1>
<p><strong>Curso:</strong> {{curso.nombre}}</p>
<p><strong>Docente:</strong> {{docente.nombre}}</p>
<p><strong>Periodo:</strong> {{periodo}} · <strong>Emitido:</strong> {{fecha_emision}}</p>

<table>
  <thead>
    <tr>
      <th>Estudiante</th>
      <th>Correo</th>
      <th>Nota final</th>
      <th>Asistencia</th>
    </tr>
  </thead>
  <tbody>
    {{#each estudiantes}}
    <tr>
      <td>{{nombre}}</td>
      <td>{{email}}</td>
      <td>{{nota_final}} / {{escala_max}}</td>
      <td>{{asistencia.porcentaje}}%</td>
    </tr>
    {{/each}}
  </tbody>
</table>$$,
$$h1 { font-size: 18pt; margin-bottom: 4pt; }
table { width: 100%; border-collapse: collapse; font-size: 10pt; margin-top: 12pt; }
th, td { border: 1px solid #ccc; padding: 4pt 6pt; text-align: left; }
th { background: #f4f4f4; }$$
  )
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
