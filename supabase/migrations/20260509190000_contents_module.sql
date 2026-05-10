-- ──────────────────────────────────────────────────────────────────────
-- Módulo "Contenidos": generación de material académico con IA.
-- Crea PPT (estructura JSON que el cliente convierte a .pptx con
-- pptxgenjs al descargar) y guías docente en .md. Solo Docentes pueden
-- generar; Admin configura marca + prompt + ve todos los generados.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1. Tabla de configuración de marca (singleton row) ────────────────
CREATE TABLE IF NOT EXISTS public.content_brand_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  university_name TEXT NOT NULL DEFAULT '',
  logo_url TEXT,
  primary_color TEXT NOT NULL DEFAULT '#1e40af',
  secondary_color TEXT NOT NULL DEFAULT '#64748b',
  -- author_default es el nombre que aparecerá en la portada por defecto
  -- cuando el docente no especifique uno propio.
  author_default TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID
);

-- Garantiza una y solo una fila — patrón "singleton" (idéntico al que
-- usa ai_model_settings en este proyecto).
CREATE UNIQUE INDEX IF NOT EXISTS content_brand_config_singleton
  ON public.content_brand_config ((true));

INSERT INTO public.content_brand_config (university_name, primary_color, secondary_color)
VALUES ('', '#1e40af', '#64748b')
ON CONFLICT DO NOTHING;

-- ── 2. Enums + tabla de generaciones ──────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.content_mode AS ENUM ('curso_completo', 'material_individual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.content_status AS ENUM ('queued', 'processing', 'done', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.generated_contents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- teacher_id apunta al usuario que solicitó la generación. Es el dueño.
  teacher_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- course_id opcional: el docente puede generar material independiente
  -- de un curso específico (caso típico de prep general).
  course_id UUID REFERENCES public.courses(id) ON DELETE SET NULL,
  mode public.content_mode NOT NULL,
  topic TEXT NOT NULL,
  -- Solo aplica cuando mode='curso_completo'. NULL para 'material_individual'.
  n_classes INT,
  language TEXT NOT NULL DEFAULT 'es',
  -- Override opcional al author_default de la marca. Se persiste para
  -- que regeneraciones futuras del mismo curso mantengan el atributo.
  author TEXT,
  status public.content_status NOT NULL DEFAULT 'queued',
  -- files es un array de {name, path, kind}. `kind` ∈ {'pptx-source', 'md'}.
  -- Las pptx-source se guardan como texto crudo del bloque
  -- [INICIO_ARCHIVO: PRESENTACION.PPTX]…[FIN_ARCHIVO: …]; el cliente las
  -- transforma a .pptx vía pptxgenjs en el momento de descarga.
  files JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  -- raw_output: salida cruda de la IA antes del parseo. Útil para
  -- debugging y para futuras re-renderizaciones.
  raw_output TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT n_classes_only_for_curso_completo CHECK (
    (mode = 'curso_completo' AND n_classes IS NOT NULL AND n_classes > 0)
    OR (mode = 'material_individual' AND n_classes IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS generated_contents_teacher_idx
  ON public.generated_contents(teacher_id);
CREATE INDEX IF NOT EXISTS generated_contents_status_idx
  ON public.generated_contents(status);
CREATE INDEX IF NOT EXISTS generated_contents_course_idx
  ON public.generated_contents(course_id);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS generated_contents_touch ON public.generated_contents;
CREATE TRIGGER generated_contents_touch
  BEFORE UPDATE ON public.generated_contents
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 3. RLS ────────────────────────────────────────────────────────────
ALTER TABLE public.content_brand_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generated_contents ENABLE ROW LEVEL SECURITY;

-- Marca: cualquiera autenticado puede LEER (la usa el cliente para
-- renderizar logo/colores en la portada). Solo Admin escribe.
DROP POLICY IF EXISTS brand_read ON public.content_brand_config;
CREATE POLICY brand_read ON public.content_brand_config
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS brand_admin_write ON public.content_brand_config;
CREATE POLICY brand_admin_write ON public.content_brand_config
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'Admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'Admin')
  );

-- Generaciones: el docente ve y administra las suyas. Admin ve todo.
DROP POLICY IF EXISTS generated_contents_owner ON public.generated_contents;
CREATE POLICY generated_contents_owner ON public.generated_contents
  FOR ALL TO authenticated
  USING (
    teacher_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'Admin')
  )
  WITH CHECK (
    teacher_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'Admin')
  );

-- ── 4. Storage bucket + policies ──────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('generated-contents', 'generated-contents', false, 50 * 1024 * 1024)
ON CONFLICT (id) DO NOTHING;

-- Layout: <teacher_id>/<content_id>/<filename>. La política se ata al
-- primer segmento del path → solo el dueño (o Admin) puede leer/escribir.
DROP POLICY IF EXISTS gc_read ON storage.objects;
CREATE POLICY gc_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'generated-contents' AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'Admin')
    )
  );

DROP POLICY IF EXISTS gc_write ON storage.objects;
CREATE POLICY gc_write ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'generated-contents' AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'Admin')
    )
  );

DROP POLICY IF EXISTS gc_update ON storage.objects;
CREATE POLICY gc_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'generated-contents' AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'Admin')
    )
  );

DROP POLICY IF EXISTS gc_delete ON storage.objects;
CREATE POLICY gc_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'generated-contents' AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'Admin')
    )
  );

-- ── 5. Prompt de IA por defecto ───────────────────────────────────────
-- Extiende el CHECK de use_case para aceptar 'content_generation'.
-- Las migraciones previas lo recrean cada vez que añaden un valor
-- nuevo (mismo patrón usado en 20260508130000, 20260508160000, etc.).
ALTER TABLE public.ai_prompts
  DROP CONSTRAINT IF EXISTS ai_prompts_use_case_check;

ALTER TABLE public.ai_prompts
  ADD CONSTRAINT ai_prompts_use_case_check CHECK (use_case IN (
    'workshop_full',
    'workshop_question',
    'project_file',
    'project_full',
    'exam_question',
    'exam_time_evaluation',
    'plagiarism_detection',
    'ai_content_detection',
    'project_description',
    'project_questions',
    'content_generation'
  ));

-- Se inserta como global (course_id IS NULL). Admin puede editarlo en
-- la página /app/admin/contenidos-config; los docentes no tienen
-- override por curso para este use_case (solo el global aplica).
INSERT INTO public.ai_prompts (use_case, course_id, system_prompt)
SELECT
  'content_generation',
  NULL,
  'content_generation',
  NULL,
  $PROMPT$Eres un Arquitecto de Contenido Educativo. Tu objetivo es generar estructuras de datos pedagógicas y precisas para cualquier disciplina académica, las cuales la plataforma utilizará para crear archivos descargables (.pptx y .md).

### 1. CONFIGURACIÓN DE MARCA (PARÁMETROS VISUALES)
- Institución: {{university_name}}
- Logo: ![Logo]({{logo_url}})
- Colores: Primario {{primary_color}} | Secundario {{secondary_color}}

### 2. MODOS DE GENERACIÓN
Debes identificar el modo de operación solicitado:

#### MODO A: CURSO COMPLETO
- Parámetros: Tema: {{topic}} | Cantidad de Clases: {{n_classes}}
- Requisito: Generar una estructura de currículo completa.
- Archivo Intro (.pptx): Portada con logo, Objetivos del curso, Justificación y Cronograma de las {{n_classes}} clases.
- Archivos por Clase: Para cada clase, generar la estructura de diapositivas y su respectiva Guía del Docente.

#### MODO B: MATERIAL INDIVIDUAL
- Parámetros: Tema Específico: {{topic}}
- Requisito: Generar el material detallado para una sola sesión.

### 3. FILOSOFÍA DE HERRAMIENTAS: CERO INSTALACIONES (CLOUD/SaaS)
Es una directriz pedagógica estricta priorizar la accesibilidad. En todos los ejemplos, talleres o actividades prácticas, debes sugerir exclusivamente herramientas en la nube accesibles desde un navegador web, evitando que el estudiante deba instalar software local.
- Si el tema es ofimática/redacción: Prioriza Google Docs/Sheets/Slides sobre Microsoft Office de escritorio.
- Si el tema es diseño/arte: Sugiere Figma web, Canva, Photopea.
- Si el tema es tecnología/programación: Sugiere Replit, CodeSandbox, Google Colab.
- Si el tema es negocios/matemáticas: Sugiere calculadoras web (Desmos), Miro o Trello.

### 4. ESPECIFICACIÓN DE ARCHIVOS DESCARGABLES (OUTPUT ESTRUCTURADO)
Para que el sistema procese tu respuesta y genere los archivos, debes seguir este orden estricto:

---
[INICIO_ARCHIVO: PRESENTACION.PPTX]
- Slide 1 (Portada): Logo, Nombre del Tema/Curso, Institución, Autor.
- Slide 2 (Objetivos): Definir 3 objetivos de aprendizaje claros.
- Slide [3-N]: Desarrollo del tema con títulos y viñetas concisas (máx. 40 palabras por slide). Aplica el color {{primary_color}} en títulos.
[FIN_ARCHIVO: PRESENTACION.PPTX]

---
[INICIO_ARCHIVO: GUIA_DOCENTE.MD]
# Guía del Docente: {{topic}}
## Estilo y Colores: {{primary_color}}
### Paso a Paso de la Clase:
1. **Introducción y Rompehielos (10 min):** [Dinámica para iniciar]
2. **Desarrollo Teórico (40 min):** [Explicación detallada de las diapositivas]
3. **Taller Práctico Sin Instalaciones (40 min):** [Paso a paso usando una herramienta SaaS en el navegador]
4. **Cierre:** [Preguntas de validación o debate final]
[FIN_ARCHIVO: GUIA_DOCENTE.MD]

---

### 5. CONSISTENCIA RAG (CONTEXTO HISTÓRICO)
Usa los siguientes documentos previos para mimetizar el tono, el nivel de profundidad, las metodologías de evaluación y la estructura de tiempos que la institución o el profesor prefieren:

<rag_context>
{{rag_context_documents}}
</rag_context>

### 6. REGLAS CRÍTICAS
1. No incluyas saludos, confirmaciones ni comentarios fuera de las etiquetas `[INICIO_ARCHIVO]` y `[FIN_ARCHIVO]`.
2. Si el modo es "Curso Completo", genera primero el archivo de Introducción y luego el desglose consecutivo de las sesiones.
3. Asegúrate de que el lenguaje se adapte al nivel de la audiencia objetivo y a la naturaleza del tema (sea humanidades, ciencias o artes).$PROMPT$
WHERE NOT EXISTS (
  SELECT 1 FROM public.ai_prompts
  WHERE use_case = 'content_generation' AND course_id IS NULL
);
