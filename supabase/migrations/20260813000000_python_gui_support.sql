-- ──────────────────────────────────────────────────────────────────────
-- Soporte para preguntas tipo `python_gui` (tkinter) — paralelo a `java_gui`.
--
-- Antes: solo Java GUI estaba modelado en el banco. Python tenía soporte
-- de consola (type='codigo' con language='python') pero no había forma
-- de pedir al alumno construir una UI con tkinter y que la plataforma
-- la rendereara para calificar.
--
-- Ahora:
--   1. Nuevo `question_type='python_gui'` aceptado en todas las tablas
--      que aceptaban `java_gui` (questions, workshop_questions,
--      project_files, question_bank). El comportamiento es paralelo
--      al java_gui:
--        - El alumno escribe código Python que crea una ventana tkinter.
--        - El runner del proyecto (AWS Lambda con Xvfb + tkinter)
--          captura UN PNG de la ventana renderizada.
--        - La IA califica el código (no la imagen).
--   2. Nueva columna `code_execution_settings.python_gui_provider` para
--      seleccionar el motor. Único valor soportado hoy: 'aws_screenshot'
--      (no hay equivalente client-side estilo CheerpJ para tkinter — no
--      existe Pyodide+tkinter en WASM). La columna existe para
--      simetría con `java_gui_provider` y para poder añadir alternativas
--      en el futuro (ej. Pyodide+canvas si llegara a existir).
--
-- Las preguntas existentes mantienen su tipo — la migración es aditiva.
--
-- IMPORTANTE — Defensiva por tabla:
-- Cada ALTER se ejecuta dentro de un DO block que primero verifica que
-- la tabla existe (to_regclass(...) IS NOT NULL). Esto cubre entornos
-- donde alguna de estas tablas no llegó a crearse (parcial migrate,
-- restore desde dump viejo, schema reorganizado). El primer deploy en
-- la cuenta del usuario falló porque `public.question_bank` no existía
-- pero las migrations previas estaban marcadas como aplicadas — un
-- desfase entre supabase_migrations y la realidad de la DB. Con esta
-- guarda, las tablas presentes se actualizan y las ausentes se saltan
-- en lugar de abortar la migración entera.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) Aceptar 'python_gui' en los CHECK constraints de tipo ──

-- questions (exámenes)
DO $$
BEGIN
  IF to_regclass('public.questions') IS NOT NULL THEN
    ALTER TABLE public.questions DROP CONSTRAINT IF EXISTS questions_type_check;
    ALTER TABLE public.questions ADD CONSTRAINT questions_type_check
      CHECK (type IN ('abierta','cerrada','cerrada_multi','codigo','diagrama','java_gui','python_gui'));
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
      CHECK (type IN ('abierta','cerrada','cerrada_multi','codigo','diagrama','java_gui','python_gui','codigo_zip'));
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
      CHECK (type IN ('abierta','cerrada','cerrada_multi','codigo','diagrama','java_gui','python_gui','codigo_zip'));
  ELSE
    RAISE NOTICE 'Tabla public.project_files no existe — se omite el ALTER';
  END IF;
END $$;

-- question_bank (banco reutilizable). En al menos un entorno esta tabla
-- no existía cuando llegó esta migración (el INSTALL marcó la migración
-- 20260518100000 como aplicada pero la tabla no se creó — desfase del
-- shadow de migraciones). La guarda evita romper el deploy.
DO $$
BEGIN
  IF to_regclass('public.question_bank') IS NOT NULL THEN
    ALTER TABLE public.question_bank DROP CONSTRAINT IF EXISTS question_bank_type_check;
    ALTER TABLE public.question_bank ADD CONSTRAINT question_bank_type_check
      CHECK (type IN ('cerrada','cerrada_multi','codigo','codigo_zip','abierta','diagrama','java_gui','python_gui'));
  ELSE
    RAISE NOTICE 'Tabla public.question_bank no existe — se omite el ALTER. Si en el futuro la creas, agrega python_gui al CHECK manualmente.';
  END IF;
END $$;

-- ── 2) Columna python_gui_provider en code_execution_settings ──
DO $$
BEGIN
  IF to_regclass('public.code_execution_settings') IS NOT NULL THEN
    ALTER TABLE public.code_execution_settings
      ADD COLUMN IF NOT EXISTS python_gui_provider text NOT NULL DEFAULT 'aws_screenshot';

    ALTER TABLE public.code_execution_settings
      DROP CONSTRAINT IF EXISTS code_execution_settings_python_gui_provider_check;

    ALTER TABLE public.code_execution_settings
      ADD CONSTRAINT code_execution_settings_python_gui_provider_check
      CHECK (python_gui_provider IN ('aws_screenshot'));

    COMMENT ON COLUMN public.code_execution_settings.python_gui_provider IS
      'Motor para preguntas tipo python_gui. Único valor soportado hoy: aws_screenshot (AWS Lambda + Xvfb + tkinter, captura PNG estática, no interactivo). No existe equivalente client-side (Pyodide no incluye tkinter en WASM). Columna preparada para alternativas futuras.';
  ELSE
    RAISE NOTICE 'Tabla public.code_execution_settings no existe — se omite el ALTER';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
