-- Migration: submissions.extra_seconds
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS extra_seconds INTEGER NOT NULL DEFAULT 0;

-- Migration: ai_prompts exam_time_evaluation use_case
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

-- Migration: student delete own submissions in window
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workshop_submission_answers_submission_id_fkey'
  ) THEN
    DELETE FROM public.workshop_submission_answers wsa
    WHERE NOT EXISTS (
      SELECT 1 FROM public.workshop_submissions ws WHERE ws.id = wsa.submission_id
    );
    ALTER TABLE public.workshop_submission_answers
      ADD CONSTRAINT workshop_submission_answers_submission_id_fkey
      FOREIGN KEY (submission_id)
      REFERENCES public.workshop_submissions(id)
      ON DELETE CASCADE;
  END IF;
END $$;

DROP POLICY IF EXISTS "Students delete own workshop submissions in window"
  ON public.workshop_submissions;
CREATE POLICY "Students delete own workshop submissions in window"
  ON public.workshop_submissions FOR DELETE TO authenticated
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.workshops w
      WHERE w.id = workshop_submissions.workshop_id
        AND w.status = 'published'
        AND (w.due_date IS NULL OR w.due_date > now())
        AND (w.start_date IS NULL OR w.start_date <= now())
    )
  );

DROP POLICY IF EXISTS "Students delete own project submissions in window"
  ON public.project_submissions;
CREATE POLICY "Students delete own project submissions in window"
  ON public.project_submissions FOR DELETE TO authenticated
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_submissions.project_id
        AND p.status = 'published'
        AND (p.due_date IS NULL OR p.due_date > now())
        AND (p.start_date IS NULL OR p.start_date <= now())
    )
  );