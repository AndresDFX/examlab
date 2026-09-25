-- ══════════════════════════════════════════════════════════════════════
-- El teléfono es de la PERSONA, no de la matrícula.
--
-- Hasta ahora el único teléfono que el Acuerdo Pedagógico sabía leer era
-- `course_enrollments.vocero_telefono` (mig 20262000000000): un dato por
-- MATRÍCULA. Eso tiene dos costos que se ven en producción:
--
--   • Quien es vocero en dos cursos tiene que darlo dos veces, y puede
--     quedar distinto en cada uno. Hoy pasa: la misma persona es vocera de
--     Programación II y de Seminario de Sistemas.
--   • El dato muere con la matrícula. Si el curso se recrea, se pide otra vez.
--
-- Por eso el teléfono pasa a `profiles.telefono` y `vocero_telefono` queda
-- como ANULACIÓN por curso: si alguien da un número distinto para un curso
-- puntual, ese gana. El lector del Acuerdo resuelve
-- `vocero_telefono ?? profiles.telefono`, así que lo ya cargado sigue
-- mandando y no hay que migrar nada ni re-generar ningún documento.
--
-- NO se protege con el guard de auto-escalación (20261035000000): el
-- teléfono es un dato de contacto propio, de la misma clase que `codigo` y
-- `documento`, que ese trigger ya deja editar al dueño a propósito.
-- ══════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    ALTER TABLE public.profiles
      ADD COLUMN IF NOT EXISTS telefono TEXT;

    -- Tope defensivo: es una casilla de un documento oficial, no un campo
    -- libre. Sin cota, un pegado accidental desmaqueta la tabla del Acuerdo.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'chk_profiles_telefono_largo'
    ) THEN
      ALTER TABLE public.profiles
        ADD CONSTRAINT chk_profiles_telefono_largo
        CHECK (telefono IS NULL OR char_length(telefono) <= 40);
    END IF;
  END IF;
END $$;

COMMENT ON COLUMN public.profiles.telefono IS
  'Teléfono de contacto de la persona. El Acuerdo Pedagógico lo usa para el vocero, '
  'con course_enrollments.vocero_telefono como anulación por curso.';
