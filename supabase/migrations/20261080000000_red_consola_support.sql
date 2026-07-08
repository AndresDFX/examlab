-- ──────────────────────────────────────────────────────────────────────
-- Soporte para preguntas tipo `red_consola` (Red — consola tipo Cisco IOS).
--
-- Nuevo tipo de pregunta: el alumno configura un dispositivo desde una
-- consola IOS (intérprete propio en TS, client-side) sobre una topología
-- definida por el docente; la calificación es DETERMINISTA por aserciones
-- (módulo src/modules/network — ver docs/research/network-question-integrations.md).
--
-- El escenario (topología + target + aserciones) vive en `*.options.network`
-- (JSONB existente); la respuesta del alumno (topología final + historial)
-- se serializa a JSON en `*_submission_answers.answer_text` (columna text
-- existente). NO se agregan columnas.
--
-- Migración ADITIVA: solo amplía los CHECK de `type`. Defensiva por tabla
-- (to_regclass) — mismo patrón que 20260813000000 (python_gui): si alguna
-- tabla no existe en el entorno, se omite su ALTER en vez de abortar.
-- ──────────────────────────────────────────────────────────────────────

-- questions (exámenes)
DO $$
BEGIN
  IF to_regclass('public.questions') IS NOT NULL THEN
    ALTER TABLE public.questions DROP CONSTRAINT IF EXISTS questions_type_check;
    ALTER TABLE public.questions ADD CONSTRAINT questions_type_check
      CHECK (type IN ('abierta','cerrada','cerrada_multi','codigo','diagrama','java_gui','python_gui','red_consola'));
  ELSE
    RAISE NOTICE 'Tabla public.questions no existe — se omite el ALTER';
  END IF;
END $$;

-- workshop_questions (talleres)
DO $$
BEGIN
  IF to_regclass('public.workshop_questions') IS NOT NULL THEN
    ALTER TABLE public.workshop_questions DROP CONSTRAINT IF EXISTS workshop_questions_type_check;
    ALTER TABLE public.workshop_questions ADD CONSTRAINT workshop_questions_type_check
      CHECK (type IN ('abierta','cerrada','cerrada_multi','codigo','diagrama','java_gui','python_gui','codigo_zip','red_consola'));
  ELSE
    RAISE NOTICE 'Tabla public.workshop_questions no existe — se omite el ALTER';
  END IF;
END $$;

-- project_files (proyectos)
DO $$
BEGIN
  IF to_regclass('public.project_files') IS NOT NULL THEN
    ALTER TABLE public.project_files DROP CONSTRAINT IF EXISTS project_files_type_check;
    ALTER TABLE public.project_files ADD CONSTRAINT project_files_type_check
      CHECK (type IN ('abierta','cerrada','cerrada_multi','codigo','diagrama','java_gui','python_gui','codigo_zip','red_consola'));
  ELSE
    RAISE NOTICE 'Tabla public.project_files no existe — se omite el ALTER';
  END IF;
END $$;

-- question_bank (banco reutilizable)
DO $$
BEGIN
  IF to_regclass('public.question_bank') IS NOT NULL THEN
    ALTER TABLE public.question_bank DROP CONSTRAINT IF EXISTS question_bank_type_check;
    ALTER TABLE public.question_bank ADD CONSTRAINT question_bank_type_check
      CHECK (type IN ('cerrada','cerrada_multi','codigo','codigo_zip','abierta','diagrama','java_gui','python_gui','red_consola'));
  ELSE
    RAISE NOTICE 'Tabla public.question_bank no existe — se omite el ALTER. Si en el futuro la creas, agrega red_consola al CHECK manualmente.';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
