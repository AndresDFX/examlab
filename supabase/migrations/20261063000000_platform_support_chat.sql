-- ──────────────────────────────────────────────────────────────────────
-- Asistente IA de plataforma para el Admin.
--
-- Concepto:
--   El Admin de un tenant puede chatear con una IA que conoce CÓMO se
--   usa y configura ExamLab (usuarios, cursos, evaluaciones, IA, etc.).
--   Es un clon del Tutor IA del estudiante, pero el contexto no es el
--   material de un curso sino la documentación de uso de la plataforma
--   (tabla platform_kb_docs, sembrada desde el manual del administrador).
--
--   UX: un chat ÚNICO persistente por Admin (UNIQUE user_id), igual que
--   el Tutor tiene un chat único por (user_id, course_id).
--
-- Idempotente + defensivo: las tablas nuevas usan CREATE ... IF NOT
-- EXISTS; la extensión del CHECK de ai_prompts va bajo guard to_regclass
-- por si esa tabla no existe en el entorno (patrón Lovable).
-- ──────────────────────────────────────────────────────────────────────

-- ── Tabla: sesión de chat (una por Admin) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.platform_support_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- UNIQUE: un solo chat persistente por usuario (se crea on-demand).
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  -- tenant del Admin — útil para resolver el modelo IA y el prompt
  -- tenant-global. NULLABLE porque un SuperAdmin cross-tenant no tiene
  -- tenant propio.
  tenant_id UUID REFERENCES public.tenants(id),
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Tabla: mensajes ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.platform_support_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.platform_support_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 20000),
  prompt_tokens INT,
  completion_tokens INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_support_messages_session
  ON public.platform_support_messages(session_id, created_at);

-- ── Trigger updated_at (reusa la función global existente) ────────────
DROP TRIGGER IF EXISTS trg_platform_support_sessions_updated_at
  ON public.platform_support_sessions;
CREATE TRIGGER trg_platform_support_sessions_updated_at
  BEFORE UPDATE ON public.platform_support_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── RLS ──────────────────────────────────────────────────────────────
ALTER TABLE public.platform_support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_support_messages ENABLE ROW LEVEL SECURITY;

-- Sessions SELECT: dueño (+ SuperAdmin para las suyas cross-tenant).
-- NO usamos USING(true): scope estricto por user_id → sin leak cross-tenant.
DROP POLICY IF EXISTS "platform_support_sessions_select" ON public.platform_support_sessions;
CREATE POLICY "platform_support_sessions_select"
  ON public.platform_support_sessions FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_super_admin());

-- Sessions INSERT: el propio usuario, y solo si es staff de gestión
-- (Admin del tenant o SuperAdmin). El rol SIEMPRE va combinado con
-- user_id = auth.uid() para no habilitar creación a nombre de otro.
DROP POLICY IF EXISTS "platform_support_sessions_insert" ON public.platform_support_sessions;
CREATE POLICY "platform_support_sessions_insert"
  ON public.platform_support_sessions FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin())
  );

-- Sessions UPDATE/DELETE: solo el dueño (limpiar conversación, etc.).
DROP POLICY IF EXISTS "platform_support_sessions_update" ON public.platform_support_sessions;
CREATE POLICY "platform_support_sessions_update"
  ON public.platform_support_sessions FOR UPDATE TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "platform_support_sessions_delete" ON public.platform_support_sessions;
CREATE POLICY "platform_support_sessions_delete"
  ON public.platform_support_sessions FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- Messages SELECT: mensajes de MIS sesiones (el join ya scope-a por dueño).
DROP POLICY IF EXISTS "platform_support_messages_select" ON public.platform_support_messages;
CREATE POLICY "platform_support_messages_select"
  ON public.platform_support_messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.platform_support_sessions s
      WHERE s.id = platform_support_messages.session_id
        AND s.user_id = auth.uid()
    )
  );

-- Messages: SIN policy de INSERT del cliente. Solo el edge function
-- (service_role) inserta — evita inyección de mensajes "assistant"
-- falsos. Mismo criterio que tutor_chat_messages.

-- ── Extender el CHECK de ai_prompts.use_case ─────────────────────────
-- La lista DEBE incluir TODOS los use_cases vigentes (superset de las
-- migraciones previas: hasta 20260976000000_report_generation_prompt) +
-- 'platform_support'. Si se omite uno, el ADD falla con "violated by
-- some row". Bajo guard to_regclass por si la tabla no existe.
DO $$
BEGIN
  IF to_regclass('public.ai_prompts') IS NULL THEN
    RAISE NOTICE 'skip ai_prompts use_case CHECK: tabla ausente';
    RETURN;
  END IF;
  ALTER TABLE public.ai_prompts DROP CONSTRAINT IF EXISTS ai_prompts_use_case_check;
  BEGIN
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
        'content.examen',
        'tutor_chat',
        'report_generation',
        'platform_support'
      ));
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'ai_prompts_use_case_check no re-aplicado (valor inesperado): %', SQLERRM;
  END;
END $$;

NOTIFY pgrst, 'reload schema';
