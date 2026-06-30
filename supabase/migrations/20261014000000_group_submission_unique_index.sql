-- ══════════════════════════════════════════════════════════════════════
-- W3 — Race: dos miembros de un grupo entregando a la vez creaban DOS filas de
-- submission. El flujo cliente hace read(maybeSingle por group_id)→insert; no
-- es atómico y NO había UNIQUE(workshop_id|project_id, group_id), así que dos
-- inserts concurrentes (con user_id distinto = el miembro que entrega) ambos
-- satisfacían el UNIQUE(workshop_id, user_id) existente y creaban duplicados →
-- calificación de grupo corrupta (¿cuál fila se califica?).
--
-- Fix autoritativo a nivel DB: índice UNIQUE PARCIAL sobre (parent_id, group_id)
-- solo para filas grupales (group_id NOT NULL). Con esto, el 2º insert
-- concurrente falla con 23505 en vez de duplicar — la integridad la garantiza
-- la DB, no el orden del cliente. (El manejo elegante del 23505 en el cliente —
-- upsert/re-leer la fila existente — es pulido de UX opcional; sin él, el
-- miembro perdedor ve un error transitorio y al reintentar encuentra la fila ya
-- creada y la edita. No se pierde trabajo ni se corrompe.)
--
-- Verificado en prod (2026-06-30): 0 grupos con submission duplicada en ambas
-- tablas → la creación del índice no falla por datos existentes.
-- Simétrico para talleres y proyectos.
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.workshop_submissions') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS workshop_submissions_group_uidx
      ON public.workshop_submissions (workshop_id, group_id)
      WHERE group_id IS NOT NULL;
  END IF;

  IF to_regclass('public.project_submissions') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS project_submissions_group_uidx
      ON public.project_submissions (project_id, group_id)
      WHERE group_id IS NOT NULL;
  END IF;
END $$;
