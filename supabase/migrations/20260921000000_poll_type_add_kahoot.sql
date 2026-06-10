-- ════════════════════════════════════════════════════════════════════
-- Agrega el valor 'kahoot' al enum public.poll_type.
--
-- IMPORTANTE: `ALTER TYPE ... ADD VALUE` debe ir en su PROPIA migración
-- (su propia transacción). Postgres no permite USAR un valor de enum
-- recién agregado en la misma transacción que lo crea ("unsafe use of
-- new value of enum type"). Las tablas/RPCs que comparan poll_type =
-- 'kahoot' viven en 20260921000100_kahoot_game.sql (migración siguiente).
--
-- Defensivo: solo agrega si el tipo existe y el valor aún no está.
-- ════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'poll_type' AND typnamespace = 'public'::regnamespace) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'poll_type' AND e.enumlabel = 'kahoot'
    ) THEN
      ALTER TYPE public.poll_type ADD VALUE 'kahoot';
    END IF;
  END IF;
END $$;
