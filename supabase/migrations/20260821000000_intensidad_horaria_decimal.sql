-- ──────────────────────────────────────────────────────────────────────
-- Fix: `academic_subjects.intensidad_horaria` permite decimales.
--
-- Bug reportado: "invalid input syntax for type smallint: 4.5" al crear
-- una asignatura con intensidad horaria 4.5.
--
-- Causa: la migración 20260617000000 declaró la columna como SMALLINT,
-- que solo acepta enteros. Pero el caso real (medias horas semanales:
-- 4.5, 1.5) es común en programas que usan bloques de 30/45 min.
--
-- Fix: ALTER al tipo NUMERIC(4,2) — hasta 99.99 horas, 2 decimales.
-- Cubre desde 0.5 a 60.0 con paso 0.25/0.5/1.0 sin perder precisión.
-- El CHECK constraint sigue válido (rango 0–60).
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.academic_subjects') IS NULL THEN
    RAISE NOTICE 'academic_subjects no existe — se omite';
    RETURN;
  END IF;

  -- Drop el CHECK antes del ALTER TYPE (PostgreSQL no recalcula
  -- constraints automáticamente; sin drop puede fallar el ALTER).
  ALTER TABLE public.academic_subjects
    DROP CONSTRAINT IF EXISTS chk_academic_subjects_intensidad;

  -- ALTER TYPE smallint → numeric(4,2). USING castea los valores
  -- existentes preservándolos exactos (sin pérdida — int → numeric es
  -- lossless).
  ALTER TABLE public.academic_subjects
    ALTER COLUMN intensidad_horaria TYPE NUMERIC(4, 2)
      USING intensidad_horaria::NUMERIC(4, 2);

  -- Re-añadir el CHECK con el mismo rango.
  ALTER TABLE public.academic_subjects
    ADD CONSTRAINT chk_academic_subjects_intensidad
    CHECK (
      intensidad_horaria IS NULL
      OR (intensidad_horaria >= 0 AND intensidad_horaria <= 60)
    );

  COMMENT ON COLUMN public.academic_subjects.intensidad_horaria IS
    'Horas semanales que dicta la asignatura. Permite decimales (ej. 4.5, 1.5) para bloques de 30/45 min. Rango 0–60.';
END $$;
