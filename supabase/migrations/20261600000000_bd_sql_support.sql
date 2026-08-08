-- ──────────────────────────────────────────────────────────────────────
-- Soporte para preguntas tipo `bd_sql` (Base de datos — PostgreSQL real).
--
-- Nuevo tipo de pregunta para los cursos de Bases de Datos: el alumno escribe
-- SQL y lo ejecuta contra un **PostgreSQL REAL** que corre en su propio
-- navegador (PGlite compilado a WASM, cargado por CDN — ver
-- src/modules/database/pglite-loader.ts). No hay servidor de base de datos ni
-- contenedor: la base es EFÍMERA y vive en la pestaña del estudiante.
--
-- Por qué un tipo nuevo y no `codigo` con language='sql': el tipo `codigo` va al
-- runner de Judge0/Lambda, que ejecuta un proceso y devuelve stdout. SQL necesita
-- un motor con estado (esquema + datos sembrados por el docente) y devuelve
-- CONJUNTOS DE FILAS, no texto. Es el mismo criterio por el que `so_consola`
-- (Linux en el navegador vía v86) es un tipo aparte y no un `language` del runner.
--
-- Dónde vive cada cosa, SIN columnas nuevas (mismo criterio que so_consola/red_*):
--   · Esquema + datos de partida que prepara el docente → `*.options.db.setupSql`
--     (JSONB existente).
--   · Respuesta del alumno (su SQL + lo que devolvió la base) → serializada a
--     JSON en la columna de respuesta existente (ver src/modules/database/
--     sql-answer.ts). El RESULTADO se persiste a propósito: la base es efímera,
--     así que si no se guarda, la evidencia se pierde al cerrar la pestaña y no
--     hay con qué calificar ni con qué responder un reclamo.
--
-- Calificación: por IA, reusando el pipeline existente. Los resultados de las
-- consultas viajan al prompt por el MISMO campo `executionOutput` que ya usa
-- `so_consola` para su transcript de consola.
--
-- Migración ADITIVA: solo amplía los CHECK de `type` con `bd_sql`, preservando el
-- set vigente de cada tabla. Defensiva por tabla (to_regclass) — mismo patrón que
-- 20261080000000 (red_consola) / 20261081000000 (red_gui) / 20261280000000
-- (so_consola). Sin el guard, una tabla ausente aborta el deploy completo.
-- ──────────────────────────────────────────────────────────────────────

-- questions (exámenes) — NO tiene codigo_zip
DO $$
BEGIN
  IF to_regclass('public.questions') IS NOT NULL THEN
    ALTER TABLE public.questions DROP CONSTRAINT IF EXISTS questions_type_check;
    ALTER TABLE public.questions ADD CONSTRAINT questions_type_check
      CHECK (type IN ('abierta','cerrada','cerrada_multi','codigo','diagrama','java_gui','python_gui','red_consola','red_gui','so_consola','bd_sql'));
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
      CHECK (type IN ('abierta','cerrada','cerrada_multi','codigo','diagrama','java_gui','python_gui','codigo_zip','red_consola','red_gui','so_consola','bd_sql'));
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
      CHECK (type IN ('abierta','cerrada','cerrada_multi','codigo','diagrama','java_gui','python_gui','codigo_zip','red_consola','red_gui','so_consola','bd_sql'));
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
      CHECK (type IN ('cerrada','cerrada_multi','codigo','codigo_zip','abierta','diagrama','java_gui','python_gui','red_consola','red_gui','so_consola','bd_sql'));
  ELSE
    RAISE NOTICE 'Tabla public.question_bank no existe — se omite el ALTER. Si la creas luego, agrega bd_sql al CHECK.';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
