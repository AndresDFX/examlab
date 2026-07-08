-- ──────────────────────────────────────────────────────────────────────
-- Soporte para preguntas tipo `red_gui` (Red — GUI de topología).
--
-- Paralelo a `red_consola` (mig 20261080000000): mismo motor de red y misma
-- calificación determinista por aserciones (src/modules/network + copia Deno
-- en _shared/network). La diferencia es la UI del alumno: en vez de una
-- consola IOS, un EDITOR DE TOPOLOGÍA (hostnames, direccionamiento, enlaces)
-- que se serializa al MISMO modelo `Topology`. El escenario vive igual en
-- `*.options.network`; la respuesta en `*_submission(_answers).answer_text/content`.
--
-- Migración ADITIVA: amplía los CHECK de `type`. Defensiva por tabla
-- (to_regclass), mismo patrón que 20260813000000 / 20261080000000.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.questions') IS NOT NULL THEN
    ALTER TABLE public.questions DROP CONSTRAINT IF EXISTS questions_type_check;
    ALTER TABLE public.questions ADD CONSTRAINT questions_type_check
      CHECK (type IN ('abierta','cerrada','cerrada_multi','codigo','diagrama','java_gui','python_gui','red_consola','red_gui'));
  ELSE
    RAISE NOTICE 'Tabla public.questions no existe — se omite el ALTER';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.workshop_questions') IS NOT NULL THEN
    ALTER TABLE public.workshop_questions DROP CONSTRAINT IF EXISTS workshop_questions_type_check;
    ALTER TABLE public.workshop_questions ADD CONSTRAINT workshop_questions_type_check
      CHECK (type IN ('abierta','cerrada','cerrada_multi','codigo','diagrama','java_gui','python_gui','codigo_zip','red_consola','red_gui'));
  ELSE
    RAISE NOTICE 'Tabla public.workshop_questions no existe — se omite el ALTER';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.project_files') IS NOT NULL THEN
    ALTER TABLE public.project_files DROP CONSTRAINT IF EXISTS project_files_type_check;
    ALTER TABLE public.project_files ADD CONSTRAINT project_files_type_check
      CHECK (type IN ('abierta','cerrada','cerrada_multi','codigo','diagrama','java_gui','python_gui','codigo_zip','red_consola','red_gui'));
  ELSE
    RAISE NOTICE 'Tabla public.project_files no existe — se omite el ALTER';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.question_bank') IS NOT NULL THEN
    ALTER TABLE public.question_bank DROP CONSTRAINT IF EXISTS question_bank_type_check;
    ALTER TABLE public.question_bank ADD CONSTRAINT question_bank_type_check
      CHECK (type IN ('cerrada','cerrada_multi','codigo','codigo_zip','abierta','diagrama','java_gui','python_gui','red_consola','red_gui'));
  ELSE
    RAISE NOTICE 'Tabla public.question_bank no existe — se omite el ALTER. Si la creas, agrega red_gui al CHECK.';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
