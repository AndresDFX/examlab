-- ──────────────────────────────────────────────────────────────────────
-- ai_generation_queue: cola separada para GENERACIÓN de contenido con IA
--
-- Diferente de `ai_grading_queue` (que es para CALIFICAR entregas). La
-- generación crea preguntas/contenidos nuevos a partir de un prompt
-- del docente — no aplica `field_grade`/`field_feedback` de la otra
-- cola.
--
-- Caso de uso: el docente está en modo IA async sin código de IA
-- inmediata activo. Antes la generación se bloqueaba ("activa código
-- para continuar"). Ahora puede ENCOLAR el job para procesarlo cuando
-- tenga código, o que un admin lo corra por él.
--
-- Lifecycle:
--   pending → processing → done (éxito)
--                       → failed (error con retry posible)
--                       → cancelled (docente o admin la canceló)
--
-- Procesamiento: el docente con código IA activo (o un Admin) entra al
-- panel de Cola IA, ve sus jobs `pending`, y clickea "Procesar ahora".
-- La UI llama directamente a `ai-generate-questions` con el `body`
-- guardado y al éxito marca el job como `done`.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ai_generation_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tipo de generación: 'workshop_questions' | 'exam_questions' |
  -- 'project_files' | 'content_generation'. Determina qué edge function
  -- procesa el job. Empezamos solo con workshop_questions.
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 50),
  -- Edge function que procesa este job. Permite tener N kinds de
  -- generación servidas por edges distintas si hace falta.
  invoke_target TEXT NOT NULL DEFAULT 'ai-generate-questions',
  -- Cuerpo a pasarle a la edge — incluye topics, type, count, examId,
  -- targetTable, language, courseLanguage, etc.
  body JSONB NOT NULL,
  -- Origen: workshop_id / exam_id / project_id / content_id. Permite
  -- mostrar al docente "esta cola es para el taller X".
  source_table TEXT NOT NULL,
  source_id UUID NOT NULL,
  course_id UUID REFERENCES public.courses(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed', 'cancelled')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  -- Resultado: número de items insertados (preguntas creadas, archivos
  -- generados, etc.). Útil para el toast "Se generaron N preguntas".
  inserted_count INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_gen_queue_status ON public.ai_generation_queue(status);
CREATE INDEX IF NOT EXISTS idx_ai_gen_queue_creator ON public.ai_generation_queue(created_by);
CREATE INDEX IF NOT EXISTS idx_ai_gen_queue_course ON public.ai_generation_queue(course_id);

-- RLS
ALTER TABLE public.ai_generation_queue ENABLE ROW LEVEL SECURITY;

-- SELECT: creator + Admin/SA + docente del curso (si está asociada).
DROP POLICY IF EXISTS ai_gen_queue_select ON public.ai_generation_queue;
CREATE POLICY ai_gen_queue_select
  ON public.ai_generation_queue FOR SELECT TO authenticated
  USING (
    created_by = auth.uid()
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
    OR public.is_super_admin()
    OR (
      course_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.course_teachers ct
         WHERE ct.course_id = ai_generation_queue.course_id AND ct.user_id = auth.uid()
      )
    )
  );

-- INSERT: el caller debe ser quien encola (created_by = auth.uid()).
-- Esto evita que un usuario encole jobs a nombre de otro.
DROP POLICY IF EXISTS ai_gen_queue_insert ON public.ai_generation_queue;
CREATE POLICY ai_gen_queue_insert
  ON public.ai_generation_queue FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

-- UPDATE: creator + Admin/SA. El docente del curso (no creator) NO
-- puede cancelar/procesar — sería inesperado. El creator sí, y el
-- admin como soporte.
DROP POLICY IF EXISTS ai_gen_queue_update ON public.ai_generation_queue;
CREATE POLICY ai_gen_queue_update
  ON public.ai_generation_queue FOR UPDATE TO authenticated
  USING (
    created_by = auth.uid()
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS ai_gen_queue_delete ON public.ai_generation_queue;
CREATE POLICY ai_gen_queue_delete
  ON public.ai_generation_queue FOR DELETE TO authenticated
  USING (
    created_by = auth.uid()
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
    OR public.is_super_admin()
  );

NOTIFY pgrst, 'reload schema';
