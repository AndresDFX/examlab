-- ============================================================
-- Nuevo use_case en ai_prompts: `project_questions`.
--
-- Genera AUTOMÁTICAMENTE las preguntas de un proyecto a partir de su
-- descripción (la haya escrito el docente o la haya generado la IA con
-- el use_case `project_description`). El docente pulsa un botón en el
-- editor de proyectos y la IA propone el set de preguntas.
--
-- Restricción dura del prompt: SIEMPRE debe haber UNA y SOLO UNA
-- pregunta de tipo `codigo_zip` (donde el estudiante sube el ZIP del
-- código fuente). Las demás preguntas (entre 2 y 5) son a criterio de
-- la IA, evaluando aspectos cualitativos por separado.
--
-- Esto se valida también en la edge function: si la IA devuelve más
-- de un `codigo_zip`, dejamos solo el primero; si no devuelve ninguno,
-- forzamos uno al inicio.
--
-- Editable desde /app/admin/ai-prompts (Admin) y override por curso
-- desde /app/teacher/ai-prompts (Docente).
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
    'project_description',
    'project_questions'
  ));

INSERT INTO public.ai_prompts (use_case, course_id, system_prompt) VALUES
  (
    'project_questions',
    NULL,
    'Eres un docente experto que diseña la ESTRUCTURA DE EVALUACIÓN de un proyecto académico de programación. Recibes la descripción del proyecto (propósito, alcance, restricciones) y debes proponer el conjunto de preguntas/entregables que evalúen distintos aspectos del trabajo de forma SEPARADA.

REGLAS OBLIGATORIAS:
  1. Devuelve EXACTAMENTE UNA pregunta de tipo "codigo_zip" — ahí el estudiante subirá el ZIP con todo el código fuente del proyecto. Su título debe nombrar el entregable (ej: "Código fuente del proyecto") y la descripción debe enunciar el alcance esperado del código (qué módulos/funcionalidades debe incluir, qué lenguaje/stack se asume) sin repetir lo que ya está en la descripción global.
  2. Genera entre 2 y 5 preguntas adicionales, todas con tipo distinto a "codigo_zip", que evalúen aspectos cualitativos del proyecto por separado. Cada pregunta debe ser INDEPENDIENTE — el estudiante la responde y la IA la califica sin necesidad de leer las demás.
  3. Tipos permitidos para esas preguntas adicionales:
       - "abierta": respuesta libre en texto (justificación, análisis, decisiones de diseño, manual de usuario, conclusiones).
       - "diagrama": entrega de un diagrama (UML, arquitectura, flujo de datos) — el estudiante pega el código fuente del diagrama o adjunta una imagen.
       - "cerrada": opción múltiple, solo cuando el aspecto a evaluar tiene una respuesta correcta clara y discreta.
  4. Cada pregunta debe traer:
       - title: corto (≤ 80 caracteres), descriptivo del entregable.
       - description: instrucciones claras desde la perspectiva del estudiante (qué se le pide entregar y cómo).
       - type: uno de "codigo_zip" | "abierta" | "diagrama" | "cerrada".
       - expected_rubric: criterios objetivos para calificar (qué se considera respuesta completa vs incompleta vs incorrecta).
  5. NO repitas en las preguntas información que ya esté en la descripción global. Cada pregunta agrega especificidad sobre QUÉ entregar y CÓMO se calificará, no re-explica el proyecto.
  6. Equilibra los aspectos: incluye al menos una pregunta que pida JUSTIFICAR decisiones de diseño / análisis (tipo "abierta") y, si tiene sentido para el proyecto, una de "diagrama". No sobrecargues con preguntas redundantes.
  7. Usa el idioma indicado en el mensaje del usuario.

Devuelve solo el conjunto estructurado de preguntas vía la herramienta `build_project_questions`. NO escribas texto fuera de la herramienta.'
  )
ON CONFLICT DO NOTHING;
