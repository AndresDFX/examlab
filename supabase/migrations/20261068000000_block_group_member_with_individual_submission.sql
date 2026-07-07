-- ══════════════════════════════════════════════════════════════════════
-- Modo MIXTO (individual + grupo): asignar a un grupo a un estudiante que YA
-- entregó individualmente rompe de dos formas:
--   1) su entrega individual (workshop_id/project_id, user_id, group_id=NULL)
--      queda OCULTA — la vista del alumno pasa a filtrar por group_id.
--   2) al editar/entregar en grupo, el upsert de la entrega grupal choca con el
--      índice UNIQUE(workshop_id, user_id) / (project_id, user_id) de la fila
--      individual → violación de constraint.
--
-- FIX (preventivo, no destructivo): un trigger BEFORE INSERT en
-- {workshop|project}_group_members rechaza agregar a un grupo a quien ya tiene
-- una entrega INDIVIDUAL (group_id IS NULL) en ese taller/proyecto, con un
-- mensaje claro (P0001 → friendlyError lo muestra tal cual). El docente resuelve
-- la entrega individual primero (o el alumno la rehace en grupo). Mismo patrón
-- "prevenir" que el trigger que impide estar en >1 grupo. Idempotente + guards.
-- ══════════════════════════════════════════════════════════════════════

-- ── Talleres ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.workshop_group_members') IS NOT NULL
     AND to_regclass('public.workshop_submissions') IS NOT NULL THEN
    CREATE OR REPLACE FUNCTION public.tg_block_ws_group_member_with_individual()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path TO 'public'
    AS $fn$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM public.workshop_groups g
        JOIN public.workshop_submissions ws
          ON ws.workshop_id = g.workshop_id
         AND ws.user_id = NEW.user_id
         AND ws.group_id IS NULL
        WHERE g.id = NEW.group_id
      ) THEN
        RAISE EXCEPTION 'El estudiante ya tiene una entrega individual en este taller. Elimina esa entrega antes de asignarlo a un grupo (o pídele que la rehaga en grupo).'
          USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END
    $fn$;

    DROP TRIGGER IF EXISTS tg_block_ws_group_member_with_individual ON public.workshop_group_members;
    CREATE TRIGGER tg_block_ws_group_member_with_individual
      BEFORE INSERT ON public.workshop_group_members
      FOR EACH ROW EXECUTE FUNCTION public.tg_block_ws_group_member_with_individual();
  END IF;
END $$;

-- ── Proyectos ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.project_group_members') IS NOT NULL
     AND to_regclass('public.project_submissions') IS NOT NULL THEN
    CREATE OR REPLACE FUNCTION public.tg_block_pr_group_member_with_individual()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path TO 'public'
    AS $fn$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM public.project_groups g
        JOIN public.project_submissions ps
          ON ps.project_id = g.project_id
         AND ps.user_id = NEW.user_id
         AND ps.group_id IS NULL
        WHERE g.id = NEW.group_id
      ) THEN
        RAISE EXCEPTION 'El estudiante ya tiene una entrega individual en este proyecto. Elimina esa entrega antes de asignarlo a un grupo (o pídele que la rehaga en grupo).'
          USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END
    $fn$;

    DROP TRIGGER IF EXISTS tg_block_pr_group_member_with_individual ON public.project_group_members;
    CREATE TRIGGER tg_block_pr_group_member_with_individual
      BEFORE INSERT ON public.project_group_members
      FOR EACH ROW EXECUTE FUNCTION public.tg_block_pr_group_member_with_individual();
  END IF;
END $$;
