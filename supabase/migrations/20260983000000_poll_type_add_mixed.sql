-- ════════════════════════════════════════════════════════════════════
-- Agrega el valor 'mixed' al enum public.poll_type.
--
-- Encuestas con MIX de tipos de pregunta (abierta + cerrada), espejo del
-- patrón de talleres/exámenes. El modelo plano legacy (single/multiple/slot/
-- kahoot) coexiste intacto — `poll_type='mixed'` bifurca a las tablas nuevas
-- `poll_questions` / `poll_question_responses` (mig 20260984000000).
--
-- IMPORTANTE: `ALTER TYPE ... ADD VALUE` debe ir SOLO en su migración (su
-- propia transacción) — Postgres no permite USAR el valor recién agregado en
-- la misma tx. Las tablas/RPCs que comparan poll_type='mixed' viven en las
-- migraciones siguientes. Mismo patrón que 20260921000000 (kahoot).
--
-- Defensivo: solo agrega si el tipo existe y el valor aún no está.
-- ════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'poll_type' AND typnamespace = 'public'::regnamespace) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'poll_type' AND e.enumlabel = 'mixed'
    ) THEN
      ALTER TYPE public.poll_type ADD VALUE 'mixed';
    END IF;
  END IF;
END $$;
