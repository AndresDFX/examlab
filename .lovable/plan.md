# Plan de implementación

## 1. Agregar "Proyecto" como componente de evaluación del curso

**Migración SQL:**
- `ALTER TABLE courses ADD COLUMN project_weight NUMERIC NOT NULL DEFAULT 0`.

**`src/routes/app.admin.courses.tsx`:**
- Extender tipo `Course` con `project_weight`.
- Cambiar el grid de pesos de 3 → 4 columnas (Exámenes, Talleres, Asistencia, Proyecto).
- Sumar `project_weight` en el cálculo total = 100%.
- Incluirlo en defaults (40/40/10/10) y al duplicar curso.
- Igual en `src/routes/app.teacher.courses.tsx` si tiene formulario de edición (revisar).

## 2. Cortes evaluativos dentro del diálogo de crear/editar curso

**Decisión confirmada:** se gestionan inline en el modal.

**Migración SQL:**
- `ALTER TABLE grade_cuts` agregar sub-pesos por componente:
  - `exam_weight NUMERIC NOT NULL DEFAULT 0`
  - `workshop_weight NUMERIC NOT NULL DEFAULT 0`
  - `attendance_weight NUMERIC NOT NULL DEFAULT 0`
  - `project_weight NUMERIC NOT NULL DEFAULT 0`
- Esto permite que cada corte tenga sus propios % por componente (la suma de los 4 debe dar 100 dentro del corte).

**UI en `app.admin.courses.tsx`:**
- Nueva sección "Cortes evaluativos" dentro del `DialogContent` (después de los pesos globales).
- Tabla compacta con: Nombre, Fecha inicio, Fecha fin, Peso (%), botones expand para ver/editar sub-pesos (4 inputs), botón eliminar, botón "Agregar corte".
- Solo visible cuando se está EDITANDO (no en creación inicial — el `course_id` aún no existe). En creación, mostrar nota "Guarda el curso primero para configurar cortes".
- Indicador visual: suma de pesos de cortes debe ser 100%; suma de sub-pesos por corte = 100%.
- Operaciones CRUD directas a `grade_cuts` con la lógica ya existente (los triggers `enforce_cut_weights_max_100` ya validan).

## 3. Nuevo módulo Proyectos

### 3.1 Base de datos (migración)

```sql
CREATE TABLE public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL,
  cut_id uuid NULL,
  created_by uuid NOT NULL,
  title text NOT NULL,
  description text,
  instructions text,           -- enunciado (puede ser generado por IA)
  project_type text NOT NULL,  -- 'escrito' | 'codigo' | 'diagrama'
  max_files integer DEFAULT 10,
  max_score numeric NOT NULL DEFAULT 100,
  due_date timestamptz,
  start_date timestamptz,
  status text NOT NULL DEFAULT 'draft', -- draft | published
  ai_generated boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.project_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  zip_url text,                -- ruta en bucket
  status text NOT NULL DEFAULT 'pendiente', -- pendiente|entregado|ai_revisado|requiere_revision|calificado
  ai_grade numeric,
  ai_feedback text,
  ai_detected boolean DEFAULT false,    -- IA en el contenido
  ai_detected_score numeric,            -- 0..1
  ai_detected_reasons text,
  final_grade numeric,
  teacher_feedback text,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, user_id)
);
```

**RLS:**
- `projects`: SELECT autenticados; ALL para Docente/Admin (mismo patrón que `workshops`).
- `project_submissions`: el estudiante ve/inserta/actualiza la propia; Docente/Admin todo.

**Storage:** reutilizar bucket `workshop-files` (ya existe, privado) en carpeta `projects/{project_id}/{user_id}.zip`.

### 3.2 Edge functions

**`ai-generate-questions`** — extender con modo `projectStatement`:
- Input: `{ projectStatement: true, topic, projectType, maxFiles, courseLanguage }`.
- Devuelve un enunciado estructurado (objetivo, alcance, entregables, criterios), respetando el tipo y nº máximo de archivos.

**`ai-grade-submission`** — nuevo modo `projectGrading`:
- Input: `{ projectGrading: true, projectId, submissionId, zipPath, projectType, instructions, maxScore, courseLanguage }`.
- Pasos:
  1. Descargar ZIP de Storage con service role.
  2. Descomprimir con `fflate` (compatible con Deno via `https://esm.sh/fflate@0.8.2`).
  3. Filtrar archivos: solo extensiones de texto/código (`.py .js .ts .tsx .jsx .java .c .cpp .cs .go .rb .php .html .css .md .txt .json .yaml .yml .xml .sql .mmd .puml`); ignorar binarios e imágenes; límite total ej. 200 KB de texto y 30 archivos.
  4. Construir contexto: lista de archivos + contenido truncado por archivo.
  5. Llamada a Lovable AI (`google/gemini-2.5-pro` para razonamiento) con tool calling: `score_project` → `{score, feedback, ai_likelihood (0..1), ai_reasons}`.
  6. Persistir en `project_submissions`: `ai_grade`, `ai_feedback`, `ai_detected = ai_likelihood >= 0.6`, `ai_detected_score`, `ai_detected_reasons`, `status = 'requiere_revision'` si detectado, sino `'ai_revisado'`.

**Detección de IA en TODOS los módulos (talleres + exámenes + proyectos):**
- Extender el tool schema de los modos existentes (`workshopGrading`, `workshopQuestionGrading`, exámenes) para devolver además `ai_likelihood` y `ai_reasons`.
- Persistir en las tablas correspondientes (agregar columnas `ai_detected`, `ai_detected_score`, `ai_detected_reasons` vía migración a `workshop_submissions`, `workshop_submission_answers`, `submissions`).
- Cuando `ai_likelihood >= 0.6` → marcar `status = 'requiere_revision'` y notificar al docente. Decisión confirmada: NO bloquear nota, requerir revisión manual.

### 3.3 Rutas frontend

- **`src/routes/app.teacher.projects.tsx`** — listado tipo "exams.index" con: crear/editar/publicar/eliminar, selector de corte, botón "Generar enunciado con IA" (modal con tema/tipo/maxFiles), botón "Ver entregas".
- **`src/routes/app.teacher.projects.$projectId.tsx`** — detalle: lista de entregas por estudiante, descarga del ZIP, botón "Calificar con IA" → llama edge function, muestra badge si `ai_detected`, permite editar nota final y feedback.
- **`src/routes/app.student.projects.tsx`** — listado de proyectos publicados con estado y due date.
- **`src/routes/app.student.project.$projectId.tsx`** — detalle: enunciado + dropzone para subir ZIP (validar `.zip` y tamaño), ver feedback IA tras calificación.
- Agregar entradas en `AppLayout.tsx` (nav) e `i18n` (`nav.projects`, `nav.studentProjects` + claves de UI). Icono: `FolderKanban` o `Package`.

### 3.4 Integración con cortes y consolidado

- En crear/editar proyecto: selector "Corte" filtrado por curso (igual patrón que workshops/exams).
- `grade_cut_items` ya soporta `item_type='project'`; mantener compatibilidad. El consolidado de notas (futuro) suma proyectos con su peso del corte.

## 4. Detección de IA — flujo común

- Nuevo helper en edge functions `detectAILikelihood(text, courseLanguage)` reutilizable o como segunda llamada al modelo con un prompt específico ("estima probabilidad 0..1 de que este texto fuera generado por IA, con razones breves") usando `google/gemini-2.5-flash`.
- Para exámenes: aplicar al calificar respuesta abierta. Para talleres clásicos y por preguntas: ya hay grading; añadir el campo. Para proyectos: análisis del conjunto de archivos.
- UI: badge ámbar "Posible IA (XX%)" en las vistas del docente (gradebook, monitor de talleres y proyectos). Tooltip con razones.

## 5. Documentación y QA

- **`EXAMLAB-CONTEXT.md`**: agregar Fase 7 documentando: 4º componente "Proyecto", cortes con sub-pesos, módulo Proyectos completo, política de detección de IA ("marcar + requerir revisión").
- **`docs/PLAN-PRUEBAS-QA.md`**: nueva sección §25 con casos para: validación 4 pesos = 100, CRUD de cortes inline, generación de enunciado de proyecto, subida y descompresión de ZIP, calificación IA de proyecto código vs escrito vs diagrama, detección de IA en talleres/exámenes/proyectos, transición de estado a `requiere_revision`.

## 6. Restricciones respetadas
- No se modifican paleta, tipografía ni layouts existentes fuera de los formularios necesarios.
- Reutilizo componentes shadcn ya presentes (`Dialog`, `Select`, `Card`, `Badge`).
- Reutilizo `bucket workshop-files`, `grade_cuts`, `grade_cut_items`, edge functions existentes.
- Sin refactors fuera de alcance.

## Orden de ejecución
1. Migraciones (courses.project_weight, grade_cuts sub-pesos, projects, project_submissions, columnas ai_detected en submissions/workshop_submissions/workshop_submission_answers).
2. UI de pesos (4 columnas) + cortes inline en admin/courses.
3. Edge functions: extender `ai-generate-questions` (projectStatement) y `ai-grade-submission` (projectGrading + ai_likelihood en todos los modos).
4. Rutas Teacher/Student de Projects + entradas en `AppLayout` e i18n.
5. Badges de "Posible IA" en vistas existentes (gradebook, taller).
6. Actualizar `EXAMLAB-CONTEXT.md` y `docs/PLAN-PRUEBAS-QA.md`.
7. `npx tsc --noEmit` para verificar.
