-- ──────────────────────────────────────────────────────────────────────
-- Tutor IA personalizado por curso.
--
-- Concepto:
--   Cada estudiante puede chatear con una IA que conoce el contexto de
--   su curso (descripción + temas + material generado). El docente puede
--   personalizar el system prompt del tutor para ese curso vía
--   ai_prompts (use_case='tutor_chat').
--
--   Filosofía: el tutor GUÍA pero no resuelve. Si el estudiante pide la
--   solución exacta de un ejercicio, la IA explica el método sin dar la
--   respuesta final. Esto se establece en el system prompt global default
--   que insertamos abajo.
-- ──────────────────────────────────────────────────────────────────────

-- ── Tabla: sesiones de chat ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tutor_chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  title TEXT,
  -- Activa = ultima conversación que el estudiante tuvo abierta.
  -- Útil para el UI "continuar donde quedé".
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tutor_chat_sessions_user
  ON public.tutor_chat_sessions(user_id, course_id, updated_at DESC);

DROP TRIGGER IF EXISTS trg_tutor_chat_sessions_updated_at ON public.tutor_chat_sessions;
CREATE TRIGGER trg_tutor_chat_sessions_updated_at
  BEFORE UPDATE ON public.tutor_chat_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── Tabla: mensajes ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tutor_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.tutor_chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
  prompt_tokens INT,
  completion_tokens INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tutor_chat_messages_session
  ON public.tutor_chat_messages(session_id, created_at);

-- ── RLS ──────────────────────────────────────────────────────────────

ALTER TABLE public.tutor_chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tutor_chat_messages ENABLE ROW LEVEL SECURITY;

-- Sessions: dueño + docentes del curso (oversight) + admin
DROP POLICY IF EXISTS "tutor_sessions_select" ON public.tutor_chat_sessions;
CREATE POLICY "tutor_sessions_select"
  ON public.tutor_chat_sessions FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers
      WHERE course_id = tutor_chat_sessions.course_id AND user_id = auth.uid()
    )
  );

-- Sessions INSERT: el estudiante matriculado, para sí mismo
DROP POLICY IF EXISTS "tutor_sessions_insert" ON public.tutor_chat_sessions;
CREATE POLICY "tutor_sessions_insert"
  ON public.tutor_chat_sessions FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.course_enrollments
      WHERE course_id = tutor_chat_sessions.course_id AND user_id = auth.uid()
    )
  );

-- Sessions UPDATE/DELETE: dueño o admin
DROP POLICY IF EXISTS "tutor_sessions_update" ON public.tutor_chat_sessions;
CREATE POLICY "tutor_sessions_update"
  ON public.tutor_chat_sessions FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'Admin'));

DROP POLICY IF EXISTS "tutor_sessions_delete" ON public.tutor_chat_sessions;
CREATE POLICY "tutor_sessions_delete"
  ON public.tutor_chat_sessions FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'Admin'));

-- Messages: misma lógica vía join al session
DROP POLICY IF EXISTS "tutor_messages_select" ON public.tutor_chat_messages;
CREATE POLICY "tutor_messages_select"
  ON public.tutor_chat_messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.tutor_chat_sessions s
      WHERE s.id = tutor_chat_messages.session_id
        AND (
          s.user_id = auth.uid()
          OR public.has_role(auth.uid(), 'Admin')
          OR EXISTS (
            SELECT 1 FROM public.course_teachers
            WHERE course_id = s.course_id AND user_id = auth.uid()
          )
        )
    )
  );

-- Messages INSERT: NO directo del cliente. Solo edge function (service role).
-- Esto evita inyección de mensajes "assistant" falsos.

-- ── Prompt default para use_case 'tutor_chat' ───────────────────────

INSERT INTO public.ai_prompts (use_case, course_id, system_prompt)
SELECT
  'tutor_chat',
  NULL,
  $$Eres un tutor académico especializado en el curso "{{course_name}}".

REGLAS ESTRICTAS:
- Tu rol es GUIAR al estudiante a entender, no resolverle los ejercicios.
- Si pide la solución exacta a un ejercicio, explica el método y los pasos
  pero NO escribas la respuesta final. Promueve que él la construya.
- Si pregunta sobre temas NO relacionados al curso, redirígelo gentilmente
  al material del curso.
- Responde en español neutro, claro y conciso. Usa Markdown para listas y
  código. Evita respuestas largas innecesarias.

CONTEXTO DEL CURSO:
{{course_description}}

TEMAS Y MATERIAL DISPONIBLE:
{{course_content_topics}}

Si el estudiante hace una pregunta clara y específica del curso, responde
directamente. Si la pregunta es vaga ("¿me ayudas con la tarea?"), pide
contexto: ¿qué tema?, ¿qué ya intentó?, ¿qué exactamente no entiende?$$
WHERE NOT EXISTS (
  SELECT 1 FROM public.ai_prompts
  WHERE use_case = 'tutor_chat' AND course_id IS NULL
);

NOTIFY pgrst, 'reload schema';
