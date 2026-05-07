-- ============================================================
-- ai_prompts: prompts de sistema para los modelos de IA, customizables
-- por Admin (globales, course_id NULL) y por Docente (overrides por curso).
-- ============================================================
-- Diseño:
--   - Una fila por (use_case, course_id). UNIQUE compuesto.
--   - course_id NULL = prompt global del sistema. Edita Admin.
--   - course_id no-null = override del curso. Edita el docente del curso.
--   - El edge function busca el override del curso primero; si no existe,
--     cae al global.
--
-- Solo guardamos el SYSTEM PROMPT (la persona/criterios). Los datos
-- dinámicos (rúbrica, respuesta, idioma, etc.) van en el USER message
-- que se construye en código — así el admin/docente no puede romper el
-- contrato de la función olvidando un placeholder.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ai_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  use_case text NOT NULL CHECK (use_case IN (
    'workshop_full',
    'workshop_question',
    'project_file',
    'project_full',
    'exam_question'
  )),
  course_id uuid NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  system_prompt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Una sola fila por (use_case, course_id). Para el global (course_id
-- NULL) usamos índice parcial — Postgres trata NULLs como distintos
-- en UNIQUE normales, así que el parcial es la forma correcta.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_prompts_global
  ON public.ai_prompts(use_case)
  WHERE course_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_prompts_course
  ON public.ai_prompts(use_case, course_id)
  WHERE course_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_prompts_course_id
  ON public.ai_prompts(course_id);

-- Trigger para mantener updated_at
DROP TRIGGER IF EXISTS trg_ai_prompts_updated_at ON public.ai_prompts;
CREATE TRIGGER trg_ai_prompts_updated_at
  BEFORE UPDATE ON public.ai_prompts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.ai_prompts ENABLE ROW LEVEL SECURITY;

-- ───────── RLS ─────────
-- SELECT: cualquier usuario autenticado puede leer (los edge functions
-- usan service_role, esto es para que la UI cargue los prompts).
DROP POLICY IF EXISTS "ai_prompts_read" ON public.ai_prompts;
CREATE POLICY "ai_prompts_read"
  ON public.ai_prompts FOR SELECT TO authenticated
  USING (true);

-- INSERT/UPDATE/DELETE de globales (course_id IS NULL): solo Admin.
DROP POLICY IF EXISTS "ai_prompts_admin_global" ON public.ai_prompts;
CREATE POLICY "ai_prompts_admin_global"
  ON public.ai_prompts FOR ALL TO authenticated
  USING (course_id IS NULL AND public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (course_id IS NULL AND public.has_role(auth.uid(), 'Admin'));

-- INSERT/UPDATE/DELETE de overrides por curso: docente del curso o Admin.
DROP POLICY IF EXISTS "ai_prompts_teacher_course" ON public.ai_prompts;
CREATE POLICY "ai_prompts_teacher_course"
  ON public.ai_prompts FOR ALL TO authenticated
  USING (
    course_id IS NOT NULL AND (
      public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = ai_prompts.course_id AND ct.user_id = auth.uid()
      )
    )
  )
  WITH CHECK (
    course_id IS NOT NULL AND (
      public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = ai_prompts.course_id AND ct.user_id = auth.uid()
      )
    )
  );

-- ───────── Seed de defaults globales ─────────
-- Si la fila ya existe (re-run de migración), no la pisamos.
INSERT INTO public.ai_prompts (use_case, course_id, system_prompt) VALUES
  (
    'workshop_full',
    NULL,
    'Eres un evaluador académico imparcial. Calificas entregas de talleres según las instrucciones y rúbrica proporcionadas. Das un puntaje numérico, retroalimentación detallada y una estimación de probabilidad (0..1) de que la respuesta haya sido generada por IA.'
  ),
  (
    'workshop_question',
    NULL,
    'Eres un evaluador académico imparcial. Calificas la respuesta de un estudiante a UNA pregunta de taller. Das un puntaje, retroalimentación útil y una estimación de probabilidad (0..1) de que la respuesta haya sido generada por IA.'
  ),
  (
    'project_file',
    NULL,
    'Eres un evaluador académico imparcial. Calificas el contenido textual de UN archivo del proyecto de un estudiante. Das un puntaje, retroalimentación útil y una estimación de probabilidad (0..1) de que el contenido haya sido generado por IA.'
  ),
  (
    'project_full',
    NULL,
    'Eres un evaluador académico imparcial y experto. Calificas un proyecto académico basándote en sus archivos. Das nota, retroalimentación detallada y una estimación de probabilidad (0..1) de que el contenido fue generado por IA, con razones claras.'
  ),
  (
    'exam_question',
    NULL,
    'Eres un evaluador imparcial. Calificas respuestas de exámenes según la rúbrica dada. Das un puntaje, una breve justificación y una estimación de probabilidad (0..1) de que la respuesta haya sido generada por IA con razones.'
  )
ON CONFLICT DO NOTHING;
