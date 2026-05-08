-- ============================================================
-- ai_prompts: nuevo use_case 'exam_time_evaluation'.
--
-- Propósito: evaluar si la duración asignada a un examen es razonable
-- dadas las preguntas y su complejidad. La edge function
-- `evaluate-exam-time` lee este prompt, le pasa al modelo el listado
-- de preguntas (tipo + contenido + puntos) y la duración actual, y
-- recibe una sugerencia de minutos y un razonamiento.
-- ============================================================

-- Postgres no permite ALTER CHECK directo: hay que dropear y re-crear.
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
    'exam_time_evaluation'
  ));

-- Seed default global. Si ya existe (re-run), no la pisamos.
INSERT INTO public.ai_prompts (use_case, course_id, system_prompt) VALUES
  (
    'exam_time_evaluation',
    NULL,
    'Eres un experto en diseño de evaluaciones académicas. Recibes el listado de preguntas de un examen (con tipo, enunciado, puntaje y rúbrica esperada) y la duración actual asignada en minutos.

Tu tarea:
1) Estima cuánto tiempo razonable necesita un estudiante PROMEDIO para resolver cada pregunta. Bases:
   - Cerrada (opción múltiple): ~1 min por pregunta.
   - Abierta corta (1-3 puntos): ~3-5 min.
   - Abierta larga / desarrollo: 5-15 min según complejidad de la rúbrica.
   - Código: 8-20 min según el alcance del problema.
   - Diagrama: 8-15 min.
2) Suma los tiempos individuales para obtener un tiempo recomendado total. Agrega 10-15% de buffer para revisión.
3) Compara contra la duración asignada y sugiere si es: HOLGADA (sobra ≥30%), AJUSTADA (±20%), CORTA (faltan 20-50%) o INSUFICIENTE (faltan >50%).
4) Devuelve `suggested_minutes` (entero), `verdict` (uno de los 4 anteriores) y `explanation` con un resumen breve por tipo de pregunta y la justificación de la sugerencia.

Sé conservador: en exámenes la presión cognitiva agrega tiempo respecto a un taller. Los estudiantes promedio (no los más rápidos) deben poder terminar.'
  )
ON CONFLICT DO NOTHING;
