-- ══════════════════════════════════════════════════════════════════════
-- Taller EXTERNO por grupos: tener nota no impide cambiar de grupo.
--
-- La mig 20261068000000 rechaza meter en un grupo a quien ya tiene una entrega
-- INDIVIDUAL (group_id NULL) en ese taller, por dos razones: esa entrega
-- quedaría oculta en la vista del estudiante (que pasa a buscar por group_id)
-- y la entrega grupal chocaría con UNIQUE(workshop_id, user_id).
--
-- En un taller EXTERNO (`is_external`) no aplica ninguna de las dos. Esa
-- «entrega» es la NOTA que escribió el docente —en «Notas externas» o desde la
-- ventana de grupos—, no trabajo del estudiante: la lista de talleres del
-- estudiante no muestra los externos, y en uno externo nadie entrega en grupo.
-- La nota se sigue leyendo igual con o sin grupo: «Mis notas», el libro de
-- notas, el boletín y el acta usan la fila individual cuando el grupo no tiene
-- entrega propia, y en un externo no la tiene nunca.
--
-- Sin esta excepción, calificar una exposición por grupo y después corregir un
-- grupo era imposible: mover a alguien borra su membresía vieja, el INSERT de
-- la nueva se rechazaba y el estudiante quedaba SIN grupo.
--
-- PROYECTOS no se tocan, a propósito: la lista de proyectos del estudiante SÍ
-- muestra los externos y, con grupo, busca solo la entrega del grupo, así que
-- la fila individual con la nota quedaría escondida. Hoy además la acción
-- «Grupos» no se ofrece en un proyecto externo.
--
-- Queda un caso sin cubrir: pasar el taller de externo a en línea cuando sus
-- integrantes ya tenían nota. Es raro (ya se calificó por fuera) y cubrirlo
-- pediría otro trigger sobre `workshops`.
--
-- Solo cambia el cuerpo de la función; el trigger sigue siendo el mismo.
-- Idempotente.
-- ══════════════════════════════════════════════════════════════════════

-- ── Talleres ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.workshop_group_members') IS NOT NULL
     AND to_regclass('public.workshop_submissions') IS NOT NULL
     AND to_regclass('public.workshops') IS NOT NULL THEN
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
        JOIN public.workshops w ON w.id = g.workshop_id
        JOIN public.workshop_submissions ws
          ON ws.workshop_id = g.workshop_id
         AND ws.user_id = NEW.user_id
         AND ws.group_id IS NULL
        WHERE g.id = NEW.group_id
          AND NOT COALESCE(w.is_external, false)
      ) THEN
        RAISE EXCEPTION 'El estudiante ya tiene una entrega individual en este taller. Elimina esa entrega antes de asignarlo a un grupo (o pídele que la rehaga en grupo).'
          USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END
    $fn$;
  END IF;
END $$;
