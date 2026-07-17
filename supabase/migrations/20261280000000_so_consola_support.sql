-- ──────────────────────────────────────────────────────────────────────
-- Soporte para preguntas tipo `so_consola` (Consola de servidor / shell Linux).
--
-- Nuevo tipo de pregunta para los cursos de Administración de Sistemas
-- Operativos de Servidor: el alumno ejecuta comandos de shell (pwd, ls, mkdir,
-- chmod, chown, useradd, groupadd, usermod, apt, systemctl, df, du, ps, kill,
-- crontab, tar, journalctl…) en una CONSOLA sobre un sistema Linux VIRTUAL
-- (intérprete propio en TS, client-side); la calificación es DETERMINISTA por
-- aserciones (módulo src/modules/serverconsole — análogo de src/modules/network).
--
-- El escenario (sistema inicial + aserciones) vive en `*.options.server`
-- (JSONB existente); la respuesta del alumno (sistema final + historial) se
-- serializa a JSON en la columna de respuesta existente. NO se agregan columnas.
--
-- Migración ADITIVA: solo amplía los CHECK de `type` con `so_consola`,
-- preservando el set vigente de cada tabla. Defensiva por tabla (to_regclass) —
-- mismo patrón que 20261080000000 (red_consola) / 20261081000000 (red_gui).
-- ──────────────────────────────────────────────────────────────────────

-- questions (exámenes) — NO tiene codigo_zip
DO $$
BEGIN
  IF to_regclass('public.questions') IS NOT NULL THEN
    ALTER TABLE public.questions DROP CONSTRAINT IF EXISTS questions_type_check;
    ALTER TABLE public.questions ADD CONSTRAINT questions_type_check
      CHECK (type IN ('abierta','cerrada','cerrada_multi','codigo','diagrama','java_gui','python_gui','red_consola','red_gui','so_consola'));
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
      CHECK (type IN ('abierta','cerrada','cerrada_multi','codigo','diagrama','java_gui','python_gui','codigo_zip','red_consola','red_gui','so_consola'));
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
      CHECK (type IN ('abierta','cerrada','cerrada_multi','codigo','diagrama','java_gui','python_gui','codigo_zip','red_consola','red_gui','so_consola'));
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
      CHECK (type IN ('cerrada','cerrada_multi','codigo','codigo_zip','abierta','diagrama','java_gui','python_gui','red_consola','red_gui','so_consola'));
  ELSE
    RAISE NOTICE 'Tabla public.question_bank no existe — se omite el ALTER. Si la creas luego, agrega so_consola al CHECK.';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
