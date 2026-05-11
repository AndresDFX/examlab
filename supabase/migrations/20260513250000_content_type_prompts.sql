-- ──────────────────────────────────────────────────────────────────────
-- Prompts independientes por TIPO de archivo de contenido.
--
-- Diseño: `content_generation` se queda como "system prompt orquestador"
-- (contiene el contrato de marcadores [INICIO_ARCHIVO]/[FIN_ARCHIVO] y
-- placeholders {{topic}}, {{primary_color}}, etc.). Los 5 nuevos
-- use_cases son SUB-PROMPTS por tipo de archivo — el edge function
-- los inyecta en el user message según los tags activos del row.
--
-- use_cases nuevos:
--   - content.presentacion   → tag "teorico"
--   - content.guia_docente   → tag "teorico"
--   - content.taller_practico → tag "practico"
--   - content.ejercicio      → tag "practico" (estudiante + solución)
--   - content.examen         → tag "examen" (preguntas + clave + rúbrica)
--
-- Admin puede editarlos en la pantalla de prompts; cada uno acepta
-- override por curso vía `course_id` igual que los demás.
-- ──────────────────────────────────────────────────────────────────────

-- 1) Ampliar el CHECK de use_case para aceptar los 5 nuevos valores.
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
    'content_generation',
    'content.presentacion',
    'content.guia_docente',
    'content.taller_practico',
    'content.ejercicio',
    'content.examen'
  ));

-- 2) Seed de cada sub-prompt. ON CONFLICT (use_case, course_id) DO
--    NOTHING para no pisar ediciones del admin si ya existían.

INSERT INTO public.ai_prompts (use_case, course_id, system_prompt) VALUES
(
  'content.presentacion',
  NULL,
  '### PRESENTACION_CLASE_<N>.PPTX

Genera 9–18 slides con título + 3–6 viñetas concretas cada uno. Cada slide debe incluir ejemplos o definiciones técnicas precisas — evita generalidades.

Estructura sugerida:
- Slide 1: portada con el título de la clase y subtítulo del tema.
- Slide 2: objetivos de aprendizaje específicos de la clase (3–5 bullets accionables).
- Slides 3–N-2: desarrollo del tema. Al menos 2 slides con casos concretos / ejemplos numéricos.
- Slide N-1: síntesis o mapa conceptual.
- Slide N: cierre + próximos pasos.

Aplica el color {{primary_color}} en los títulos. NO uses Markdown en las viñetas (asteriscos, backticks). Texto plano.'
)
ON CONFLICT (use_case, course_id) DO NOTHING;

INSERT INTO public.ai_prompts (use_case, course_id, system_prompt) VALUES
(
  'content.guia_docente',
  NULL,
  '### GUIA_DOCENTE_CLASE_<N>.MD

Extensión mínima 500 palabras. Asume que el docente JAMÁS ha enseñado este tema antes — explica los conceptos clave PASO A PASO en lenguaje que pueda leer en voz alta. NO seas genérico ("explicar el concepto"); escribe el guion exacto.

Incluye siempre estas secciones:

1. **Objetivos de la clase** (lista accionable, ≥3 ítems).
2. **Conceptos clave** (cada uno con definición precisa + ejemplo).
3. **Guion paso a paso** (3–7 momentos pedagógicos con tiempo estimado).
4. **Errores comunes que cometen los estudiantes** (≥3 entradas, cada una con: error + por qué ocurre + cómo retroalimentarlo).
5. **Preguntas frecuentes** (≥3, cada una con respuesta sugerida).
6. **Analogías o metáforas útiles** para conceptos abstractos.
7. **Cierre** (mensaje de síntesis para los estudiantes).

Solo Markdown estándar. Sin emojis.'
)
ON CONFLICT (use_case, course_id) DO NOTHING;

INSERT INTO public.ai_prompts (use_case, course_id, system_prompt) VALUES
(
  'content.taller_practico',
  NULL,
  '### TALLER_PRACTICO_CLASE_<N>.MD

5–8 pasos secuenciados que el estudiante puede seguir solo en una sesión práctica. Cada paso debe ser concreto y verificable.

Estructura de cada paso:

- **Objetivo del paso** (1 línea).
- **Instrucciones** detalladas incluyendo la HERRAMIENTA SaaS específica + URL si aplica (ej. https://replit.com, https://draw.io, https://mermaid.live).
- **Captura verbal esperada**: "deberías ver X en la esquina superior derecha" o equivalente para que el estudiante valide sin ayuda.
- **Entregable verificable** (un archivo, una URL, un screenshot, etc.).

Al final del taller, agrega una sección "**Criterios de éxito**" con métricas observables — no "lo hizo bien", sino "completa la tarea en <10 min con 0 errores de sintaxis" o equivalente.

Markdown estándar. Sin código de programación ENCERRADO en bloques fenced (el modelo lo separa aparte en pptx-source).'
)
ON CONFLICT (use_case, course_id) DO NOTHING;

INSERT INTO public.ai_prompts (use_case, course_id, system_prompt) VALUES
(
  'content.ejercicio',
  NULL,
  '### EJERCICIO_ESTUDIANTE_CLASE_<N>.MD  +  EJERCICIO_SOLUCION_CLASE_<N>.MD

Genera DOS archivos como un par:

**EJERCICIO_ESTUDIANTE_CLASE_<N>.MD** (entregable al alumno, ≥250 palabras):
- Contexto del problema (3–5 líneas).
- Datos de entrada concretos (cifras, ejemplos, dataset, etc.).
- Restricciones (lenguaje, librerías permitidas, tiempo límite si aplica).
- Formato del entregable (archivo, URL, captura, etc.).
- Rúbrica de evaluación VISIBLE para el estudiante (3–5 criterios con pesos).

**EJERCICIO_SOLUCION_CLASE_<N>.MD** (solo docente):
- MISMO enunciado palabra-por-palabra del archivo del estudiante (copia/pega).
- Solución completa paso-a-paso con justificación pedagógica.
- Respuesta final destacada.
- ≥3 errores comunes que el docente debe esperar + cómo retroalimentar cada uno.

Markdown estándar.'
)
ON CONFLICT (use_case, course_id) DO NOTHING;

INSERT INTO public.ai_prompts (use_case, course_id, system_prompt) VALUES
(
  'content.examen',
  NULL,
  '### EXAMEN_CLASE_<N>.MD  (SOLO docente — el estudiante NUNCA debe verlo)

Genera un examen de la clase ${classNum} con la siguiente estructura. El docente lo usa OPCIONALMENTE: puede importarlo al módulo de Exámenes o descartarlo.

**Encabezado:**
- Tema, duración sugerida (en min), puntaje total (sobre 100).

**Preguntas — entre 5 y 10 en total**, con esta distribución sugerida:
- 3–5 preguntas cerradas (selección múltiple, 4 opciones, UNA correcta).
- 1–3 preguntas de desarrollo corto (≤200 palabras de respuesta).
- 0–2 preguntas de análisis (caso o problema, ≤400 palabras).

Para CADA pregunta incluye:
1. **Enunciado** (claro y autosuficiente).
2. **Tipo**: cerrada / desarrollo / análisis.
3. **Puntaje** (suman 100 entre todas).
4. **Opciones** (solo cerradas) con la correcta marcada.
5. **Clave / respuesta esperada** con justificación breve.
6. **Rúbrica** (solo desarrollo / análisis): 3–4 criterios con descriptores de logro (excelente / bueno / regular / insuficiente).
7. **Errores comunes** que debería detectar la calificación.

Markdown plano. NO uses encabezados Markdown dentro del enunciado (sólo en las secciones de la pregunta).'
)
ON CONFLICT (use_case, course_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
