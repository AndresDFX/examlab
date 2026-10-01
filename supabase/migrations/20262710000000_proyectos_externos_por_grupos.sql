-- ══════════════════════════════════════════════════════════════════════
-- Proyectos EXTERNOS por grupos (paridad con talleres) + la nota de una
-- actividad externa no la puede borrar el estudiante.
--
-- 1) Proyecto externo: tener nota no impide cambiar de grupo.
--    Mismo motivo que la mig 20262700000000 para talleres: en un proyecto
--    EXTERNO la fila individual de `project_submissions` es la NOTA que
--    escribió el docente («Notas externas» o la ventana de grupos), no una
--    entrega. Esa migración dejó proyectos afuera porque la lista de proyectos
--    del estudiante buscaba solo la entrega del GRUPO y la nota quedaba
--    escondida; el cliente ya busca la fila propia en un proyecto externo
--    (`entregaEsDelGrupo`), y «Mis notas», el libro, el boletín y el acta ya
--    caían a la fila individual cuando el grupo no tiene entrega propia.
--
-- 2) El estudiante no puede borrar su fila en una actividad EXTERNA.
--    Las políticas «Students delete own … submissions in window» (mig
--    20260508140000) dejan borrar la entrega propia mientras el plazo está
--    abierto, para rehacerla. En una actividad externa no hay nada que rehacer:
--    esa fila es la nota del docente, y con el plazo abierto (la exposición
--    calificada en clase, antes de la hora de cierre) el estudiante podía
--    borrarla por la API. Las columnas de nota ya tenían candado (mig
--    20261034000000); el borrado no. Se recrean IGUALES más esa condición: en
--    una actividad en línea no cambia nada.
--
-- Defensiva con to_regclass e idempotente. Solo cambia el cuerpo de la función
-- (el trigger sigue siendo el mismo) y dos políticas de DELETE.
-- ══════════════════════════════════════════════════════════════════════

-- ── 1) Proyectos: la nota de un externo no bloquea el cambio de grupo ──
DO $$
BEGIN
  IF to_regclass('public.project_group_members') IS NOT NULL
     AND to_regclass('public.project_submissions') IS NOT NULL
     AND to_regclass('public.projects') IS NOT NULL THEN
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
        JOIN public.projects p ON p.id = g.project_id
        JOIN public.project_submissions ps
          ON ps.project_id = g.project_id
         AND ps.user_id = NEW.user_id
         AND ps.group_id IS NULL
        WHERE g.id = NEW.group_id
          AND NOT COALESCE(p.is_external, false)
      ) THEN
        RAISE EXCEPTION 'El estudiante ya tiene una entrega individual en este proyecto. Elimina esa entrega antes de asignarlo a un grupo (o pídele que la rehaga en grupo).'
          USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END
    $fn$;
  END IF;
END $$;

-- ── 2a) Talleres: el estudiante no borra su fila en un externo ──
DO $$
BEGIN
  IF to_regclass('public.workshop_submissions') IS NOT NULL
     AND to_regclass('public.workshops') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Students delete own workshop submissions in window"
      ON public.workshop_submissions;
    CREATE POLICY "Students delete own workshop submissions in window"
      ON public.workshop_submissions FOR DELETE TO authenticated
      USING (
        auth.uid() = user_id
        AND EXISTS (
          SELECT 1 FROM public.workshops w
          WHERE w.id = workshop_submissions.workshop_id
            AND w.status = 'published'
            AND NOT COALESCE(w.is_external, false)
            AND (w.due_date IS NULL OR w.due_date > now())
            AND (w.start_date IS NULL OR w.start_date <= now())
        )
      );
  END IF;
END $$;

-- ── 2b) Proyectos: ídem ──
DO $$
BEGIN
  IF to_regclass('public.project_submissions') IS NOT NULL
     AND to_regclass('public.projects') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Students delete own project submissions in window"
      ON public.project_submissions;
    CREATE POLICY "Students delete own project submissions in window"
      ON public.project_submissions FOR DELETE TO authenticated
      USING (
        auth.uid() = user_id
        AND EXISTS (
          SELECT 1 FROM public.projects p
          WHERE p.id = project_submissions.project_id
            AND p.status = 'published'
            AND NOT COALESCE(p.is_external, false)
            AND (p.due_date IS NULL OR p.due_date > now())
            AND (p.start_date IS NULL OR p.start_date <= now())
        )
      );
  END IF;
END $$;
