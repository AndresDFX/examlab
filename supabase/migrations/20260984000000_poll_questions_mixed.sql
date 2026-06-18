-- ════════════════════════════════════════════════════════════════════
-- Encuestas MIXTAS: tablas de preguntas + respuestas (v1: abierta + cerrada).
--
-- Espejo del patrón `workshop_questions` (una tabla con `type` CHECK + `options`
-- JSONB polimórfico). Hijas de `polls`; solo aplican cuando `poll_type='mixed'`.
-- El modelo plano legacy (poll_options/poll_responses/kahoot_*) NO se toca —
-- cero migración de datos.
--
-- v1: tipos `abierta` (texto libre) y `cerrada` (opción única). `cerrada_multi`,
-- quiz (correct_index) y realtime de payload de respuestas se difieren a v2.
--
-- RLS: reusa los helpers SECURITY DEFINER existentes (_poll_has_member,
-- _poll_anchor_teacher, _poll_linked_teacher, _poll_admin_in_tenant) AÑADIENDO
-- guard de papelera (deleted_at) — los helpers NO filtran soft-delete. Las
-- respuestas solo se escriben vía RPC (write directo denegado).
-- ════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.polls') IS NULL THEN
    RAISE NOTICE 'skip poll_questions: tabla polls ausente en este entorno';
    RETURN;
  END IF;

  -- ── Tabla: poll_questions ──────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS public.poll_questions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    poll_id     UUID NOT NULL REFERENCES public.polls(id) ON DELETE CASCADE,
    position    INT NOT NULL DEFAULT 0,
    type        TEXT NOT NULL CHECK (type IN ('abierta', 'cerrada')),
    text        TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
    -- cerrada → {"choices": ["A","B",...]} (≥2); abierta → NULL.
    -- SIN correct_index: las choices son seleccionables por el alumno (no es
    -- un quiz; no exponemos respuesta correcta como sí hace kahoot).
    options     JSONB,
    required    BOOLEAN NOT NULL DEFAULT TRUE,
    max_chars   INT CHECK (max_chars IS NULL OR max_chars BETWEEN 1 AND 10000),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_poll_questions_poll ON public.poll_questions(poll_id);

  -- ── Tabla: poll_question_responses ─────────────────────────────────
  CREATE TABLE IF NOT EXISTS public.poll_question_responses (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    poll_id       UUID NOT NULL REFERENCES public.polls(id) ON DELETE CASCADE,
    question_id   UUID NOT NULL REFERENCES public.poll_questions(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    answer_text   TEXT,       -- abierta
    selected_index INT,       -- cerrada
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (question_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pqr_poll ON public.poll_question_responses(poll_id);
  CREATE INDEX IF NOT EXISTS idx_pqr_question ON public.poll_question_responses(question_id);
  CREATE INDEX IF NOT EXISTS idx_pqr_user ON public.poll_question_responses(user_id);

  -- NOTA v1: NO `REPLICA IDENTITY FULL` ni publicación a supabase_realtime.
  -- Con FULL el payload de INSERT incluiría `answer_text` y se difundiría por
  -- el canal (filtro a nivel tabla, NO RLS) → leak de respuestas abiertas a
  -- otros alumnos. El front refetchea vía el canal existente de polls.

  ALTER TABLE public.poll_questions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.poll_question_responses ENABLE ROW LEVEL SECURITY;
END $$;

-- ── RLS: poll_questions ───────────────────────────────────────────────
-- SELECT: miembro del curso (cualquiera linkeado) o admin del tenant; nunca si
-- la poll está en papelera. WRITE: docente ancla o admin del tenant.
DO $$
BEGIN
  IF to_regclass('public.poll_questions') IS NULL THEN RETURN; END IF;

  DROP POLICY IF EXISTS poll_questions_select ON public.poll_questions;
  CREATE POLICY poll_questions_select
    ON public.poll_questions FOR SELECT TO authenticated
    USING (
      (public._poll_has_member(poll_id, auth.uid())
       OR public._poll_admin_in_tenant(poll_id, auth.uid()))
      AND NOT EXISTS (
        SELECT 1 FROM public.polls p WHERE p.id = poll_id AND p.deleted_at IS NOT NULL
      )
    );

  DROP POLICY IF EXISTS poll_questions_write ON public.poll_questions;
  CREATE POLICY poll_questions_write
    ON public.poll_questions FOR ALL TO authenticated
    USING (
      public._poll_anchor_teacher(poll_id, auth.uid())
      OR public._poll_admin_in_tenant(poll_id, auth.uid())
    )
    WITH CHECK (
      public._poll_anchor_teacher(poll_id, auth.uid())
      OR public._poll_admin_in_tenant(poll_id, auth.uid())
    );
END $$;

-- ── RLS: poll_question_responses ──────────────────────────────────────
-- SELECT: el propio alumno, el docente linkeado, o admin del tenant; nunca si
-- la poll está en papelera. WRITE directo DENEGADO — solo vía RPC SECURITY
-- DEFINER (submit/clear), para enforzar open + allow_change_response + rango.
DO $$
BEGIN
  IF to_regclass('public.poll_question_responses') IS NULL THEN RETURN; END IF;

  DROP POLICY IF EXISTS pqr_select ON public.poll_question_responses;
  CREATE POLICY pqr_select
    ON public.poll_question_responses FOR SELECT TO authenticated
    USING (
      (user_id = auth.uid()
       OR public._poll_linked_teacher(poll_id, auth.uid())
       OR public._poll_admin_in_tenant(poll_id, auth.uid()))
      AND NOT EXISTS (
        SELECT 1 FROM public.polls p WHERE p.id = poll_id AND p.deleted_at IS NOT NULL
      )
    );

  -- INSERT/UPDATE/DELETE directos denegados (solo RPC).
  DROP POLICY IF EXISTS pqr_no_direct_insert ON public.poll_question_responses;
  CREATE POLICY pqr_no_direct_insert
    ON public.poll_question_responses FOR INSERT TO authenticated
    WITH CHECK (FALSE);
  DROP POLICY IF EXISTS pqr_no_direct_update ON public.poll_question_responses;
  CREATE POLICY pqr_no_direct_update
    ON public.poll_question_responses FOR UPDATE TO authenticated
    USING (FALSE);
  DROP POLICY IF EXISTS pqr_no_direct_delete ON public.poll_question_responses;
  CREATE POLICY pqr_no_direct_delete
    ON public.poll_question_responses FOR DELETE TO authenticated
    USING (FALSE);
END $$;

NOTIFY pgrst, 'reload schema';
