-- ──────────────────────────────────────────────────────────────────────
-- Papelera (soft-delete) para entidades principales.
--
-- Antes: cualquier DELETE era irreversible. Si un docente borraba un
-- examen por error, perdía las entregas asociadas (ON DELETE CASCADE).
--
-- Ahora: las entidades principales tienen `deleted_at` + `deleted_by`.
-- Al "eliminar" en la UI, el handler hace UPDATE SET deleted_at = now()
-- en lugar de DELETE. La fila + sus hijos siguen vivos, pero quedan
-- ocultos de las listas (queries normales agregan `is('deleted_at', null)`).
--
-- Visibles desde /app/trash. Restaurar = UPDATE SET deleted_at = NULL.
-- Eliminar definitivo = DELETE físico (cascade real). Purga automática:
-- `purge_deleted_items()` borra todo lo que lleva >30 días en papelera;
-- se invoca por pg_cron diariamente.
--
-- Alcance V1 (entidades incluidas):
--   - courses
--   - exams
--   - workshops
--   - projects
--   - attendance_sessions
--   - whiteboards
--   - generated_contents
--   - polls
--
-- Las demás tablas (snippets, videos, messages, etc.) conservan el
-- patrón viejo de DELETE físico — V2 las incorporará.
--
-- Compatibilidad RLS: NO modificamos policies existentes. El front
-- explícitamente filtra `deleted_at IS NULL` en las listas. La trash
-- page hace lo contrario (`IS NOT NULL`). Esto evita romper queries
-- existentes — el docente ya tiene SELECT sobre sus filas vivas o
-- borradas; la diferencia la enforce el front.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) Columnas en cada tabla ──
DO $$
DECLARE
  tbl TEXT;
  tbls TEXT[] := ARRAY[
    'courses',
    'exams',
    'workshops',
    'projects',
    'attendance_sessions',
    'whiteboards',
    'generated_contents',
    'polls'
  ];
BEGIN
  FOREACH tbl IN ARRAY tbls
  LOOP
    IF to_regclass('public.' || tbl) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ',
        tbl
      );
      EXECUTE format(
        'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL',
        tbl
      );
      -- Index parcial: acelera dos consultas opuestas — las listas
      -- principales (WHERE deleted_at IS NULL) y la papelera (WHERE
      -- deleted_at IS NOT NULL). El planner elige el path correcto.
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS idx_%I_deleted_at ON public.%I(deleted_at) WHERE deleted_at IS NOT NULL',
        tbl,
        tbl
      );
    ELSE
      RAISE NOTICE 'Tabla public.% no existe — se omite', tbl;
    END IF;
  END LOOP;
END $$;

-- ── 2) Función de purga automática ──
-- Elimina FÍSICAMENTE las filas con deleted_at más viejo que el TTL
-- (30 días por default). La cascade de FKs limpia los hijos. Idempotente
-- y safe (no toca filas con deleted_at IS NULL).
--
-- SECURITY DEFINER para que el pg_cron job (que corre como rol minimal)
-- pueda hacer DELETE en tablas con RLS. Validamos NADA porque el job
-- solo lo invoca el cron — no es accesible al usuario.
DROP FUNCTION IF EXISTS public.purge_deleted_items(INTERVAL);
CREATE OR REPLACE FUNCTION public.purge_deleted_items(_ttl INTERVAL DEFAULT INTERVAL '30 days')
RETURNS TABLE(table_name TEXT, purged_count INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tbl TEXT;
  tbls TEXT[] := ARRAY[
    'courses',
    'exams',
    'workshops',
    'projects',
    'attendance_sessions',
    'whiteboards',
    'generated_contents',
    'polls'
  ];
  cnt INT;
BEGIN
  FOREACH tbl IN ARRAY tbls
  LOOP
    IF to_regclass('public.' || tbl) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'DELETE FROM public.%I WHERE deleted_at IS NOT NULL AND deleted_at < now() - $1',
      tbl
    ) USING _ttl;
    GET DIAGNOSTICS cnt = ROW_COUNT;
    table_name := tbl;
    purged_count := cnt;
    RETURN NEXT;
  END LOOP;
  RETURN;
END;
$$;

COMMENT ON FUNCTION public.purge_deleted_items(INTERVAL) IS
  'Borra fisicamente las filas con deleted_at viejo de las tablas de papelera. TTL default 30 dias. Invocado diariamente por pg_cron. Retorna conteo por tabla.';

-- ── 3) RPC para restaurar / borrar definitivo (front-callable) ──
-- Single source of truth para que el front no tenga que conocer la
-- estructura de cada tabla. Valida que la tabla pertenezca al set
-- soportado y delega el UPDATE/DELETE. RLS aplica sobre el caller —
-- si el docente no tiene permiso UPDATE sobre la fila, la operación
-- falla con el error nativo de RLS.
--
-- IMPORTANTE: usamos SECURITY INVOKER (default) para que la RLS del
-- caller aplique. Si fuera DEFINER, cualquier authenticated podría
-- restaurar/borrar cualquier fila de la papelera.
DROP FUNCTION IF EXISTS public.trash_restore_item(TEXT, UUID);
CREATE OR REPLACE FUNCTION public.trash_restore_item(_table TEXT, _id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  allowed TEXT[] := ARRAY[
    'courses', 'exams', 'workshops', 'projects',
    'attendance_sessions', 'whiteboards', 'generated_contents', 'polls'
  ];
BEGIN
  IF NOT (_table = ANY(allowed)) THEN
    RAISE EXCEPTION 'Tabla % no permitida en papelera', _table USING ERRCODE = 'P0001';
  END IF;
  IF to_regclass('public.' || _table) IS NULL THEN
    RAISE EXCEPTION 'Tabla % no existe', _table USING ERRCODE = 'P0001';
  END IF;
  EXECUTE format(
    'UPDATE public.%I SET deleted_at = NULL, deleted_by = NULL WHERE id = $1',
    _table
  ) USING _id;
END;
$$;

DROP FUNCTION IF EXISTS public.trash_hard_delete_item(TEXT, UUID);
CREATE OR REPLACE FUNCTION public.trash_hard_delete_item(_table TEXT, _id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  allowed TEXT[] := ARRAY[
    'courses', 'exams', 'workshops', 'projects',
    'attendance_sessions', 'whiteboards', 'generated_contents', 'polls'
  ];
BEGIN
  IF NOT (_table = ANY(allowed)) THEN
    RAISE EXCEPTION 'Tabla % no permitida en papelera', _table USING ERRCODE = 'P0001';
  END IF;
  IF to_regclass('public.' || _table) IS NULL THEN
    RAISE EXCEPTION 'Tabla % no existe', _table USING ERRCODE = 'P0001';
  END IF;
  -- Solo permitimos hard-delete sobre filas YA borradas (deleted_at IS
  -- NOT NULL). Esto evita que un caller use la RPC para bypasear el
  -- flujo "primero papelera, después purge".
  EXECUTE format(
    'DELETE FROM public.%I WHERE id = $1 AND deleted_at IS NOT NULL',
    _table
  ) USING _id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.trash_restore_item(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.trash_hard_delete_item(TEXT, UUID) TO authenticated;

-- ── 4) Cron job diario de purga ──
-- Corre a las 03:00 UTC todos los días. La hora minimiza colisión con
-- otros jobs nocturnos del proyecto y queda fuera de horario académico
-- en LATAM. Si pg_cron no está instalado (entorno local), el job se
-- saltea con un NOTICE en lugar de fallar.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron no instalado — se omite el job de purga. Instalá con CREATE EXTENSION pg_cron;';
    RETURN;
  END IF;

  -- Desprogramar si ya existía (re-ejecutable en redespliegues).
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'purge-deleted-items-daily';

  PERFORM cron.schedule(
    'purge-deleted-items-daily',
    '0 3 * * *',
    $job$SELECT public.purge_deleted_items()$job$
  );
END $$;

-- Descripción humana del job (se ve en el módulo Cron del Admin).
DO $$
BEGIN
  IF to_regclass('public.cron_job_descriptions') IS NULL THEN
    RAISE NOTICE 'cron_job_descriptions no existe — se omite la descripción del job';
    RETURN;
  END IF;
  INSERT INTO public.cron_job_descriptions(jobname, description)
  VALUES (
    'purge-deleted-items-daily',
    'Papelera: borra fisicamente las filas con deleted_at > 30 dias en cursos, examenes, talleres, proyectos, sesiones, pizarras, contenidos y encuestas.'
  )
  ON CONFLICT (jobname) DO UPDATE
    SET description = EXCLUDED.description,
        updated_at = now();
END $$;

NOTIFY pgrst, 'reload schema';
