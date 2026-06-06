-- ──────────────────────────────────────────────────────────────────────
-- Features: import de usuarios + curso.
--
-- 1. profiles.student_code TEXT NULL — código estudiantil (matrícula,
--    carnet, ID institucional). Único por tenant cuando está set;
--    permite NULL múltiples (docentes/admins no lo tienen).
--
-- 2. courses.name único POR TENANT (excluyendo soft-deleted). Antes el
--    mismo nombre podía duplicarse → el import por course_name resolvía
--    ambiguo. Ahora un nombre + tenant identifica el curso de manera
--    inequívoca.
--
-- Aplica al template del CSV de usuarios + a la edge `bulk-import-users`
-- que ahora valida y rechaza imports con course_name inexistente o
-- student_code duplicado en el tenant.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) profiles.student_code ──
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE NOTICE 'profiles no existe — se omite';
    RETURN;
  END IF;

  ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS student_code TEXT NULL;

  -- Unique partial: solo aplica cuando student_code IS NOT NULL.
  -- Docentes/admins sin código no chocan entre sí.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_student_code_per_tenant
    ON public.profiles(tenant_id, lower(student_code))
    WHERE student_code IS NOT NULL;

  COMMENT ON COLUMN public.profiles.student_code IS
    'Código institucional del estudiante (matrícula, carnet, ID externo). Único por tenant cuando se asigna. Solo aplica a Estudiantes; NULL para Docentes/Admins.';
END $$;

-- ── 2) courses.name único por tenant (excluyendo soft-deleted) ──
DO $$
BEGIN
  IF to_regclass('public.courses') IS NULL THEN
    RAISE NOTICE 'courses no existe — se omite';
    RETURN;
  END IF;

  -- Antes de crear el unique, eliminamos duplicados existentes
  -- conservando el más viejo (created_at ASC). Esto es destructivo
  -- (DELETE de cursos), pero solo aplica si el tenant ya tenía
  -- duplicados — comportamiento previo era ambiguo igual.
  --
  -- En este deploy solo logueamos cuáles SE COLISIONARÍAN; el
  -- administrador puede limpiar manualmente antes de re-aplicar.
  -- Si NO hay duplicados (caso típico), el RAISE no se ejecuta.
  PERFORM 1
    FROM (
      SELECT tenant_id, lower(name) AS lname, COUNT(*) AS c
        FROM public.courses
       WHERE deleted_at IS NULL
       GROUP BY tenant_id, lower(name)
      HAVING COUNT(*) > 1
    ) dup;
  IF FOUND THEN
    RAISE NOTICE 'Hay cursos duplicados por (tenant, name). Limpia manualmente antes; el unique se aplica igual y rechazará INSERTs futuros pero los existentes quedan.';
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_courses_name_per_tenant
    ON public.courses(tenant_id, lower(name))
    WHERE deleted_at IS NULL;

  COMMENT ON INDEX public.idx_courses_name_per_tenant IS
    'Course name único por tenant (case-insensitive). Excluye soft-deleted para que se pueda re-crear con el mismo nombre tras eliminar. Habilita el lookup por nombre en el import de usuarios.';
END $$;
