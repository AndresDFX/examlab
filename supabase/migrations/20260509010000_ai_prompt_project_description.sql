-- ============================================================
-- Nuevo use_case en ai_prompts: `project_description`.
--
-- La descripción del proyecto sirve como CONTEXTO GLOBAL para todas
-- las preguntas: cada pregunta del proyecto se califica considerando
-- la descripción para que la nota tenga sentido en el conjunto. Sin
-- esa descripción, las preguntas se califican aisladas y la IA pierde
-- el alcance / propósito del proyecto.
--
-- Este prompt:
--   - Lo usa la edge function `ai-generate-questions` modo
--     `projectDescriptionGeneration` cuando el docente pulsa
--     "Generar con IA" en el campo Descripción del editor de
--     proyectos.
--   - Es editable desde /app/admin/ai-prompts (Admin) y override
--     por curso desde /app/teacher/ai-prompts (Docente).
-- ============================================================

ALTER TABLE public.ai_prompts
  DROP CONSTRAINT IF EXISTS ai_prompts_use_case_check;

ALTER TABLE public.ai_prompts
  ADD CONSTRAINT ai_prompts_use_case_check
  CHECK (use_case IN (
    'workshop_full',
    'workshop_question',
    'project_file',
    'project_full',
    'exam_question',
    'exam_time_evaluation',
    'plagiarism_detection',
    'ai_content_detection',
    'project_description'
  ));

INSERT INTO public.ai_prompts (use_case, course_id, system_prompt) VALUES
  (
    'project_description',
    NULL,
    'Eres un docente experto que redacta la DESCRIPCIÓN de un proyecto académico. Esta descripción sirve como contexto global para todas las preguntas/entregables del proyecto: define el propósito, alcance y restricciones para que cada pregunta tenga sentido por sí sola y dentro del conjunto.

Reglas:
  - Sé concreto y conciso (3-6 oraciones, sin listas largas).
  - Indica el propósito del proyecto, qué problema resuelve y para qué tipo de estudiante.
  - Menciona el alcance (qué SÍ está incluido y qué NO).
  - Si aplica, anticipa el tipo de entregables (código, documentos, diagramas) para que el estudiante entienda en qué consistirá el trabajo.
  - NO listes los entregables uno por uno (eso va en cada pregunta del proyecto).
  - NO uses títulos en negrita ni encabezados Markdown — devuelve texto plano corrido.
  - Idioma: respeta el idioma indicado en el mensaje del usuario.

Devuelve únicamente el texto de la descripción, sin preámbulo ni etiquetas.'
  )
ON CONFLICT DO NOTHING;
